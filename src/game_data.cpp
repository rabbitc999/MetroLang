/**
 * @file game_data.cpp
 * @brief 把 MetroLang 程序模型压成**游戏数据集**（`format: "metro-game-1"`）。
 *
 * 为什么不让页面直接吃 JSON v2：
 *
 *   - v2 里 `direction[].station[].next` 是「到下一站」的里程，一条线路的正反两个
 *     方向各写一遍，页面上要自己对齐；游戏里需要的是**一条主链 + 若干支线**，每段
 *     里程都双向可查；
 *   - v2 是给人读的完整性优先，380 KB 量级；游戏要每帧遍历全部区段，精简到 50 KB
 *     左右才跑得动；
 *   - 跨城市重名线路（广州 2 号线 vs 佛山 2 号线）在 v2 里是两个独立 ID，直接显示
 *     会撞名。
 *
 * 于是这里做与 `game/tools/prepare_data.py` **同一件事**：拼主链、登记双向里程、
 * 收集停站时间与发车间隔。两边口径必须一致——`game/test/sim.js` 和
 * `tests/test_game.py` 会交叉验证这一点。
 *
 * 序列化走本仓库自带的 `json/` 库（`json::Value` + `dump()`），**不手拼字符串**：
 * 括号由库负责配对、字符串由库负责转义，少一处笔误就是一个能编译但页面报
 * `JSONDecodeError` 的坏文件。项目里已经有这个库，没有理由不用。
 *
 * 输出结构见 `doc/06-game.md`。
 */
#include "metro_model.hpp"

#include "game_data.hpp"
#include "json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace metro {
namespace {

/** @brief `HH:mm` → 当天的秒数；解析不了返回 -1。 */
int clockSeconds(const std::string &text) {
    int hh = 0, mm = 0;
    if (std::sscanf(text.c_str(), "%d:%d", &hh, &mm) != 2) return -1;
    if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return -1;
    return hh * 3600 + mm * 60;
}

/** @brief 里程 / 时间二维小数：数据集里所有这类数字都走它，避免浮点尾巴。 */
double round2(double v) {
    if (!std::isfinite(v)) return 0.0;
    return std::round(v * 100.0) / 100.0;
}

/**
 * @brief 一个方向的站序 + 区间里程。
 *
 * `km[i]` 是第 `i` 站到第 `i+1` 站的距离；长度恒为 `stations.size() - 1`。
 */
struct Chain {
    std::vector<std::string> stations;
    std::vector<double> km;
    /** 来自 `FUTURE` 方向（规划中，尚未开通）。 */
    bool future = false;
};

/** @brief 从方向里剥出 Chain（末站没有 `next`，循环上界自然少一格）。 */
Chain chainOf(const Direction &d) {
    Chain c;
    c.future = d.isFuture;
    for (std::size_t i = 0; i < d.stations.size(); ++i) {
        c.stations.push_back(d.stations[i].name);
        if (i + 1 < d.stations.size()) c.km.push_back(d.stations[i].hasNext ? d.stations[i].next : 0.0);
    }
    return c;
}

/**
 * @brief 补上源数据里缺失的区间里程（`next: null`）。
 *
 * 真实样例里确实有漏录：北京 1 号线 `福寿岭↔苹果园`、深圳 6 号线 `松岗↔溪头`
 * 两端的 `next` 都是空的（5234 个区段里共 4 处）。如果直接当 0 处理，
 * `sim.js` 会按 `t = S / v` 算出 0 秒行程——列车瞬移，报错却一个都不会有。
 *
 * 这里用**同一条链**其余区段的中位数顶上（中位数比均值抗离群），并把补过的
 * 区段名记进 `filled`，数据集里单独列出来，方便回头修源数据。
 *
 * 只补 0 值、不碰正常值：`next` 本来就该为正。
 *
 * @param chains 这条线路的所有方向。
 * @param filled 输出：被补过的 `"A>B"` 键。
 */
void fillMissingKm(std::vector<Chain> &chains, std::vector<std::string> &filled) {
    std::vector<double> pool;
    for (const Chain &c : chains)
        for (double v : c.km)
            if (v > 0.0) pool.push_back(v);
    if (pool.empty()) return;
    std::sort(pool.begin(), pool.end());
    double median = pool[pool.size() / 2];
    if (pool.size() % 2 == 0) median = (pool[pool.size() / 2 - 1] + pool[pool.size() / 2]) / 2.0;

    for (Chain &c : chains) {
        for (std::size_t i = 0; i < c.km.size(); ++i) {
            if (c.km[i] > 0.0) continue;
            c.km[i] = median;
            filled.push_back(c.stations[i] + ">" + c.stations[i + 1]);
        }
    }
}

/** @brief Chain 的站数。 */
std::size_t size(const Chain &c) { return c.stations.size(); }

/** @brief 一段链的总里程。 */
double totalKm(const Chain &c) {
    double sum = 0.0;
    for (double v : c.km) sum += v;
    return sum;
}

/**
 * @brief 把一条线路的所有方向拼成「主链 + 支线」。
 *
 * 选主链：站最多的方向；站数相同取里程长的（环线内外环等长时取先出现的）。
 * 支线：其它方向里**尚未被覆盖**的连续站段，长度 ≥ 2 才算支线（单站忽略）。
 *
 * 注意「覆盖」是**逐步累积**的：先拼上的支线会把它的站标记为已覆盖，后面的方向再
 * 碰到这些站就断开——这正是 G3 / G12 / G14 那种「主线 + 一条支线」的真实形状。
 */
struct Joined {
    Chain main;
    std::vector<Chain> branches;
    /** 区间里程表，键为 `"A>B"`；正向反向都登记（反向走同一段时直接查）。 */
    std::unordered_map<std::string, double> km;
    /** 源数据缺失、由 `fillMissingKm` 补过的区段（`"A>B"`）。 */
    std::vector<std::string> filled;
    /** 规划中（`FUTURE`）的方向段：单独列出，**不进主链、不进支线**。 */
    std::vector<Chain> future;
};

/** @brief 登记一段里程，正反两个键都写。 */
void remember(std::unordered_map<std::string, double> &km, const std::string &a, const std::string &b,
              double distance) {
    if (a.empty() || b.empty() || a == b) return;
    km.emplace(a + ">" + b, distance);
    km.emplace(b + ">" + a, distance);
}

Joined joinLine(const Line &line) {
    Joined out;
    std::vector<Chain> chains;
    chains.reserve(line.directions.size());
    for (const Direction &d : line.directions) {
        Chain c = chainOf(d);
        if (size(c) < 2) continue;
        // 规划中（`FUTURE`）的方向单独收着：它不是运营线网的一部分，
        // 混进主线会把「尚未开通」的区段画成在跑车。广州 12 号线中段
        // `二沙岛—东湖—烈士陵园—…—广州体育馆` 就是这种段。
        if (c.future) out.future.push_back(std::move(c));
        else chains.push_back(std::move(c));
    }
    // 整条线都在规划中（`G24` 只有 `FUTURE` 方向）：不能在这里返回空，
    // 否则这条线路会从数据集里整体消失——站点表漏站、`stats.lines` 对不上、
    // 页面上少一条线却没有任何提示。退而求其次：拿第一段规划段当 `main`，
    // 让线路实体存在，但 `segments` 为空、不参与调度。
    if (chains.empty()) {
        if (!out.future.empty()) {
            out.main = out.future.front();
            for (std::size_t i = 0; i < out.main.km.size(); ++i)
                remember(out.km, out.main.stations[i], out.main.stations[i + 1], out.main.km[i]);
        }
        return out;
    }

    // 先补齐缺失里程，再选主链——否则「站数相同取里程长的」会被一堆 0 拉偏。
    fillMissingKm(chains, out.filled);

    // 反向段先标掉：数据里每条线路都把正反两个方向各写一遍，`A→B→C` 与
    // `C→B→A` 是同一条轨道。不排除它们，下面的端点续接会让主链首尾相接、
    // 整条线重复两遍（站序 `S1,S2,S3,S3,S2,S1`），页面上一列车来回弹。
    auto isReverseOf = [](const Chain &a, const Chain &b) {
        if (a.stations.size() != b.stations.size()) return false;
        return std::equal(a.stations.begin(), a.stations.end(), b.stations.rbegin());
    };

    std::size_t best = 0;
    for (std::size_t i = 1; i < chains.size(); ++i) {
        const std::size_t n = size(chains[i]);
        const std::size_t bn = size(chains[best]);
        if (n > bn || (n == bn && totalKm(chains[i]) > totalKm(chains[best]))) best = i;
    }

    // ── 端点续接：把能接上的方向段并进主链 ────────────────────────────────
    //
    // 有的线路在数据里被切成好几段**平级**的方向，谁也不比谁长，硬选最长那条
    // 会把一条直线拆成「主线 + 两条不相接的支线」。广州 12 号线就是典型：
    //   `大学城南 → 二沙岛`、`二沙岛 → 广州体育馆`、`广州体育馆 → 浔峰岗`
    // 三段等长，拼起来才是完整的南北向一线。
    //
    // 所以先贪心地把「首站或末站等于当前链端点」的段接上去，直到接不动为止；
    // 剩下的才是真正的支线（G3 那种从中间岔出去的形状，接不上端点，自然留下）。
    //
    // 光比端点还不够：G3 的 `G3_1`（海傍→天河客运站）与主链 `G3_0`
    // （海傍→机场北）**共享整段前缀**，端点一个首一个尾都能对上，接进去就会
    // 变成 67 站、前半段重复两遍。所以还要求「除接驳站外，别的站都不在主链里」
    // ——一条真正的续接段只跟主链共享那一个端点。
    std::vector<bool> used(chains.size(), false);
    used[best] = true;
    for (std::size_t i = 0; i < chains.size(); ++i)
        if (!used[i] && isReverseOf(chains[i], chains[best])) used[i] = true;

    /** @brief c 除接驳站外是否还有站已在主链里（有就说明不是干净的续接）。 */
    auto overlapsBeyond = [](const Chain &c, const std::unordered_set<std::string> &have,
                             const std::string &joint) {
        std::size_t hits = 0;
        for (const std::string &n : c.stations)
            if (have.count(n) != 0 && n != joint) ++hits;
        return hits > 0;
    };

    bool grown = true;
    while (grown) {
        grown = false;
        const std::unordered_set<std::string> have(chains[best].stations.begin(), chains[best].stations.end());
        for (std::size_t i = 0; i < chains.size(); ++i) {
            if (used[i]) continue;
            const Chain &c = chains[i];
            // 续接时也不能把「当前主链的反向」接上去。
            if (isReverseOf(c, chains[best])) {
                used[i] = true;
                continue;
            }
            if (c.stations.front() == chains[best].stations.back() && !overlapsBeyond(c, have, c.stations.front())) {
                chains[best].stations.insert(chains[best].stations.end(), c.stations.begin() + 1, c.stations.end());
                chains[best].km.insert(chains[best].km.end(), c.km.begin(), c.km.end());
                used[i] = grown = true;
            } else if (c.stations.back() == chains[best].stations.front() &&
                       !overlapsBeyond(c, have, c.stations.back())) {
                std::vector<std::string> names(c.stations.begin(), c.stations.end() - 1);
                names.insert(names.end(), chains[best].stations.begin(), chains[best].stations.end());
                std::vector<double> kms = c.km;
                kms.insert(kms.end(), chains[best].km.begin(), chains[best].km.end());
                chains[best].stations = std::move(names);
                chains[best].km = std::move(kms);
                used[i] = grown = true;
            }
            if (grown) break;  // 重开一轮，端点变了才能继续接
        }
    }
    out.main = chains[best];

    std::unordered_set<std::string> covered(out.main.stations.begin(), out.main.stations.end());
    for (std::size_t i = 0; i < out.main.km.size(); ++i)
        remember(out.km, out.main.stations[i], out.main.stations[i + 1], out.main.km[i]);

    // 先登记**所有**方向的里程：支线段只在它自己那个方向里写了一次，
    // 等拼支线时再查就查不到了。
    for (const Chain &c : chains)
        for (std::size_t i = 0; i < c.km.size(); ++i) remember(out.km, c.stations[i], c.stations[i + 1], c.km[i]);

    // 支线：扫描每个方向，把「未被覆盖的连续站段」抽出来。
    //
    // 关键点：切分时不能把两侧的已覆盖站直接扔掉。G3 的支线是
    // `体育西路(base) — 石牌桥 — 岗顶 — 华师 — 五山 — 天河客运站`，
    // 若只留新站，支线就变成一段悬空轨道，游戏里车不知道该从哪儿拐进去。
    // 所以段首/段尾各自**多取一个已覆盖站当接驳锚点**，这正是真实线形的形状。
    for (std::size_t ci = 0; ci < chains.size(); ++ci) {
        if (used[ci]) continue;
        const Chain &c = chains[ci];

        std::vector<std::string> run;
        std::vector<double> runKm;
        // 记下段内每一段里程：按**实际相邻站对**查表，锚点段也能取到。
        auto pushKm = [&](const std::string &a, const std::string &b) {
            if (run.empty()) return;
            auto it = out.km.find(a + ">" + b);
            runKm.push_back(it == out.km.end() ? 0.0 : it->second);
        };

        auto flush = [&](const std::string &tailAnchor, bool hasTail) {
            if (hasTail && !run.empty()) {
                // 段尾接回已覆盖网：把尾锚点补上，里程按最后两个站查。
                const std::string &last = run.back();
                pushKm(last, tailAnchor);
                run.push_back(tailAnchor);
            }
            if (run.size() >= 2) {
                // 与已有支线重复就跳过。正反都算重复：`A,B,C` 与 `C,B,A` 是同一段。
                std::vector<std::string> reversed(run.rbegin(), run.rend());
                bool duplicate = false;
                for (const Chain &e : out.branches)
                    if (e.stations == run || e.stations == reversed) duplicate = true;
                if (!duplicate && runKm.size() == run.size() - 1) {
                    Chain b;
                    b.stations = run;
                    b.km = runKm;
                    for (const std::string &n : b.stations) covered.insert(n);
                    out.branches.push_back(std::move(b));
                }
            } else {
                for (const std::string &n : run) covered.insert(n);
            }
            run.clear();
            runKm.clear();
        };

        for (std::size_t i = 0; i < c.stations.size(); ++i) {
            const std::string &name = c.stations[i];
            if (covered.count(name) == 0) {
                if (run.empty() && i > 0) {
                    // 段首锚点：前一个站（必然已覆盖，否则它也在 run 里）。
                    run.push_back(c.stations[i - 1]);
                }
                pushKm(run.back(), name);
                run.push_back(name);
                continue;
            }
            // 碰到已覆盖站：结束当前段，并把当前站当尾锚点。
            flush(name, !run.empty());
        }
        flush(std::string(), false);
    }
    return out;
}

/** @brief 编组（`6B` / `4A/6A`）→ 定员人数。字母是车型，数字是节数。 */
int capacityOf(const Line &line) {
    // 每节定员：A 型 310 人、B 型 240 人、其它（L 型 / 单轨 / 磁浮）按 200 算。
    // 与《地铁设计规范》口径一致：A 型 6 节 = 1860 人，B 型 6 节 = 1440 人。
    int perCar = 240;
    int cars = 6;
    if (!line.formations.empty()) {
        const std::string &f = line.formations.front();
        for (char c : f) {
            if (c >= '0' && c <= '9') cars = c - '0';
            else if (c == 'A' || c == 'a') perCar = 310;
            else if (c == 'B' || c == 'b') perCar = 240;
            else if (c == 'L' || c == 'l') perCar = 200;
        }
    }
    if (cars < 2 || cars > 12) cars = 6;
    return perCar * cars;
}

/** @brief 一条线路的最高速度：线路字段优先，缺失时按 80 km/h 兜底。 */
double maxSpeedOf(const Line &line) { return line.maxspeed > 0.0 ? line.maxspeed : 80.0; }

/** @brief 方向级默认停站时间；都没有就用程序级默认。 */
double dwellOf(const Program &p, const Line &line) {
    for (const Direction &d : line.directions)
        if (d.dwellTime >= 0.0) return d.dwellTime;
    return static_cast<double>(p.dwellTime);
}

/** @brief 站序 + 里程序列化成 `{"stations":[...],"km":[...]}`。 */
json::Value pathValue(const Chain &c) {
    json::Object o;
    json::Value stations{json::Array{}};
    for (const std::string &name : c.stations) stations.push_back(json::Value(name));
    json::Value kms{json::Array{}};
    for (double v : c.km) kms.push_back(json::Value(round2(v)));
    o.emplace("stations", std::move(stations));
    o.emplace("km", std::move(kms));
    return json::Value(std::move(o));
}

/**
 * @brief 显示名：同城线路原样，跨城重名线路（佛山 2 号线 vs 广州 2 号线）加城市前缀。
 *
 * 只有真撞名才加前缀，否则「广州地铁 1 号线」这种显示会啰嗦。
 */
std::string displayName(const Line &line, const std::map<std::string, std::vector<const Line *>> &byName) {
    auto it = byName.find(line.name);
    if (it == byName.end() || it->second.size() < 2) return line.name;
    if (line.city.empty()) return line.name;
    // 「广州」+「2号线」→「广州2号线」，与 prepare_data.py 拼法一致。
    return line.city + line.name;
}

/** @brief 一条线路在当前配置下的发车间隔时段表。 */
std::vector<HeadwayPeriod> periodsOf(const Program &p, const std::string &lineId) {
    for (const HeadwayProfile &h : p.headways)
        if (h.lineId == lineId) return h.periods;
    return {};
}

/**
 * @brief 时段表 → `[[起秒, 止秒, 值], ...]`（`sim.js` 的 `atTime` 直接吃这种紧凑表）。
 *
 * 起止时刻转成**当天秒数**：跨零点的时段（`22:00 06:00`）止点加一天，
 * 这样前端不必再解析 `HH:mm`。
 *
 * @param periods 时段表。
 * @param pick 取值函数：发车间隔取 `seconds`，拥挤度取 `factor`。
 * @param keep 过滤条件：返回 false 的时段丢弃。
 * @return 三元组数组。
 */
template <class Period, class Pick, class Keep>
json::Value periodsValue(const std::vector<Period> &periods, Pick pick, Keep keep) {
    json::Value out{json::Array{}};
    for (const Period &item : periods) {
        const int s = clockSeconds(item.start);
        int e = clockSeconds(item.end);
        if (s < 0 || e < 0) continue;
        if (e <= s) e += 24 * 3600;  // 跨零点
        const double value = pick(item);
        if (!keep(value)) continue;
        out.push_back(json::Value::array({json::Value(s), json::Value(e), json::Value(round2(value))}));
    }
    return out;
}

} // namespace

/**
 * @brief 规模摘要：直接复用 `toGameData` 的产物，保证口径永远一致。
 *
 * 单独算一遍就会有两份实现、迟早分叉（这正是「命令行说 465 站、页面说 464 站」
 * 那类问题的来源）。数据集本身就几十毫秒，命令行生成一次不算浪费。
 */
GameStats gameStats(const Program &p) {
    GameStats out;
    // 复用 `toGameData` 的产物，保证口径永远一致。单独算一遍就会有两份实现、
    // 迟早分叉——「命令行说 465 站、页面说 464 站」就是这么来的。
    const std::string text = toGameData(p);
    const json::ParseResult doc = json::parse(text);
    if (!doc.ok()) return out;
    const json::Object *root = doc.value->asObject();
    if (root == nullptr) return out;
    const json::Value *stats = root->tryGet("stats");
    if (stats == nullptr) return out;
    const json::Object *table = stats->asObject();
    if (table == nullptr) return out;
    auto read = [&](const char *key) -> int {
        const json::Value *v = table->tryGet(key);
        if (v == nullptr) return 0;
        const auto n = v->asInt();
        return n.has_value() ? static_cast<int>(*n) : 0;
    };
    out.lines = read("lines");
    out.stationsOperating = read("stations_operating");
    out.futureSegments = read("future");
    return out;
}

std::string toGameData(const Program &p) {
    // 线路名 → 线路，用来判断撞名。
    std::map<std::string, std::vector<const Line *>> byName;
    for (const Line &l : p.lines) byName[l.name].push_back(&l);

    // 站名 → 服务它的线路（游戏里按「站被几条线服务」给需求加权）。
    std::unordered_map<std::string, std::vector<std::string>> served;
    std::vector<std::string> stationOrder;
    std::unordered_set<std::string> seenStations;

    json::Object lines;
    json::Object headway;
    json::Object crowd;
    int lineCount = 0;
    int branchCount = 0;
    int stationRefs = 0;
    int filledTotal = 0;
    int futureSegs = 0;
    int plannedOnlyCount = 0;
    int operatingStations = 0;

    for (const Line &line : p.lines) {
        if (line.disabled) continue;
        const Joined joined = joinLine(line);
        if (size(joined.main) < 2) continue;
        // 整条线都在规划中：线路保留（站点表、配色、统计都要有它），
        // 但没有运营段，调度层会看到 0 段、不排车。
        const bool plannedOnly = joined.main.future;

        // 发车间隔：一条线路一张表。
        const std::vector<HeadwayPeriod> periods = periodsOf(p, line.id);
        if (!periods.empty()) {
            headway.emplace(line.id, periodsValue(periods, [](const HeadwayPeriod &h) { return double(h.seconds); },
                                                  [](double v) { return v > 0; }));
        }
        // 拥挤度：按**方向**登记（键 = 方向 ID，`G1_0` / `G1_1`），与 prepare_data.py 一致。
        for (const CrowdProfile &c : p.crowds) {
            bool related = false;
            for (const Direction &d : line.directions)
                if (d.id == c.dirId) related = true;
            if (!related || c.periods.empty()) continue;
            crowd.emplace(c.dirId, periodsValue(c.periods, [](const CrowdPeriod &x) { return x.factor; },
                                                [](double v) { return v >= 1.0; }));
        }

        auto touch = [&](const std::vector<std::string> &names, bool onLine) {
            for (const std::string &n : names) {
                // 用独立集合判断「是不是第一次见到」——不能用 `slot.empty()`：
                // 规划站会先建出空槽（不挂线路），下一条线再碰到它时
                // `slot` 仍为空，又会被 push 一次，站数直接翻倍。
                if (seenStations.insert(n).second) stationOrder.push_back(n);
                if (!onLine) continue;  // 规划站：只登记坐标，不算这条线在运营它
                auto &slot = served[n];
                if (std::find(slot.begin(), slot.end(), line.id) == slot.end()) slot.push_back(line.id);
            }
        };
        touch(joined.main.stations, !plannedOnly);
        for (const Chain &b : joined.branches) touch(b.stations, true);
        // 规划段独有的站也要进站点表——否则页面上画虚线时拿不到坐标，整段断掉。
        for (const Chain &f : joined.future) touch(f.stations, false);

        ++lineCount;
        branchCount += static_cast<int>(joined.branches.size());
        if (!plannedOnly) {
            stationRefs += static_cast<int>(size(joined.main));
            for (const Chain &b : joined.branches) stationRefs += static_cast<int>(size(b));
        } else {
            ++plannedOnlyCount;
        }

        json::Object entry;
        entry.emplace("id", json::Value(line.id));
        entry.emplace("name", json::Value(line.name));
        entry.emplace("display", json::Value(displayName(line, byName)));
        entry.emplace("color", json::Value(line.color.empty() ? "#888888" : line.color));
        entry.emplace("city", json::Value(line.city));
        entry.emplace("formation", json::Value(line.formations.empty() ? std::string() : line.formations.front()));
        entry.emplace("maxspeed", json::Value(round2(maxSpeedOf(line))));
        entry.emplace("capacity", json::Value(capacityOf(line)));
        entry.emplace("open_year", json::Value(line.openYear));
        entry.emplace("special", json::Value(line.special));
        entry.emplace("dwell", json::Value(round2(dwellOf(p, line))));
        entry.emplace("main", pathValue(joined.main));
        json::Value branches{json::Array{}};
        for (const Chain &b : joined.branches) branches.push_back(pathValue(b));
        entry.emplace("branches", std::move(branches));
        // 规划中（`FUTURE`）的区段：不进主链/支线，单独列出。页面可以画成
        // 虚线「在建中」而不参与调度，避免把没开通的轨道当作运营线。
        json::Value future{json::Array{}};
        for (const Chain &f : joined.future) future.push_back(pathValue(f));
        entry.emplace("future", std::move(future));
        entry.emplace("planned_only", json::Value(plannedOnly));
        futureSegs += static_cast<int>(joined.future.size());
        // 源数据缺里程、由中位数补过的区段。正常情况下是空数组；非空说明
        // 输入的 `.m` 该修了，数据集里留个痕迹比在页面上悄悄瞬移好。
        json::Value filled{json::Array{}};
        for (const std::string &key : joined.filled) filled.push_back(json::Value(key));
        entry.emplace("km_filled", std::move(filled));
        lines.emplace(line.id, json::Value(std::move(entry)));
        filledTotal += static_cast<int>(joined.filled.size());
    }

    // 站点表：游戏只需要「坐标 + 服务线路」，无障碍等语义用不上。
    std::unordered_map<std::string, const Station *> stationIndex;
    for (const Station &s : p.stations) stationIndex.emplace(s.name, &s);

    json::Object stations;
    for (const std::string &name : stationOrder) {
        auto it = stationIndex.find(name);
        if (it == stationIndex.end()) continue;
        const Station &s = *it->second;
        json::Object entry;
        entry.emplace("lon", json::Value(round2(s.lon * 10000.0) / 10000.0));
        entry.emplace("lat", json::Value(round2(s.lat * 10000.0) / 10000.0));
        entry.emplace("city", json::Value(s.city));
        json::Value ids{json::Array{}};
        const auto &linesHere = served[name];
        for (const std::string &id : linesHere) ids.push_back(json::Value(id));
        // `lines` 为空 = 只在规划段里出现的站，玩家到不了。
        if (!linesHere.empty()) ++operatingStations;
        entry.emplace("lines", std::move(ids));
        stations.emplace(name, json::Value(std::move(entry)));
    }

    // 换乘类型：游戏里只用得上耗时。
    json::Object transfers;
    for (const TransferType &t : p.transferTypes) {
        json::Object entry;
        entry.emplace("name", json::Value(t.name));
        entry.emplace("time", json::Value(t.time));
        entry.emplace("status", json::Value(t.status.empty() ? std::string("operating") : t.status));
        transfers.emplace(t.id, json::Value(std::move(entry)));
    }

    // 票价：起步价 + 阶梯表 + 封顶，结算页直接算。
    //
    // 极简样例（`smoke.metro`）根本没写 PRICE_DEFINE，此时阶梯表是空的、
    // 起步价也是 0。页面拿空表去查会算出 0 元，看起来像「免费乘车」这种 bug；
    // 这里退回成「全程起步价」的单段表。起步价本身缺失时再往下一档兜：
    // 取阶梯首段票价，最后才是 2 元（全国地铁的事实起步价）。
    double base = p.defaultFare;
    if (base <= 0.0 && !p.segments.empty()) base = p.segments.front().fare;
    if (base <= 0.0) base = 2.0;

    json::Object price;
    price.emplace("currency", json::Value(p.currency.empty() ? std::string("CNY") : p.currency));
    price.emplace("default_fare", json::Value(round2(base)));
    price.emplace("fare_cap", json::Value(round2(p.fareCap)));
    json::Value segments{json::Array{}};
    for (const PriceSegment &seg : p.segments) {
        segments.push_back(json::Value::object({
            {"rangeStart", json::Value(round2(seg.lo))},
            {"rangeEnd", json::Value(round2(seg.hi))},
            {"fare", json::Value(round2(seg.fare))},
        }));
    }
    if (p.segments.empty()) {
        segments.push_back(json::Value::object({
            {"rangeStart", json::Value(0.0)},
            {"rangeEnd", json::Value(9999.0)},
            {"fare", json::Value(round2(base))},
        }));
    }
    price.emplace("segments", std::move(segments));

    // 参数键名与 prepare_data.py 对齐：游戏内核按这套名字取值。
    // `reversal_time` / `accel` / `brake` 在 .m 里没有对应语句，用 doc/03 的默认口径。
    json::Object params;
    params.emplace("exit_time", json::Value(p.entryTime));
    params.emplace("inner_transfer_time", json::Value(p.transferTime));
    params.emplace("out_station_time", json::Value(p.outStationTransferTime));
    params.emplace("avg_board_time", json::Value(p.avgBoardTime));
    params.emplace("dwell_default", json::Value(p.dwellTime));
    params.emplace("reversal_time", json::Value(45));
    params.emplace("accel", json::Value(1.0));
    params.emplace("brake", json::Value(0.85));

    json::Object stats;
    stats.emplace("lines", json::Value(lineCount));
    stats.emplace("branches", json::Value(branchCount));
    stats.emplace("stations", json::Value(static_cast<std::int64_t>(stationOrder.size())));
    stats.emplace("line_stops", json::Value(stationRefs));
    // `stations` 是站点表总条目（含只在规划段里出现的站，画虚线要用它们的坐标）；
    // `stations_operating` 才是玩家实际能上下车的站数——页面标题该显示后者。
    stats.emplace("stations_operating", json::Value(static_cast<std::int64_t>(operatingStations)));
    stats.emplace("km_filled", json::Value(filledTotal));
    stats.emplace("future", json::Value(futureSegs));
    stats.emplace("planned_only", json::Value(plannedOnlyCount));

    json::Object root;
    root.emplace("format", json::Value("metro-game-1"));
    root.emplace("source", json::Value("metro-lang game"));
    // 没写 KEY_CITY 的样例（`TRANSFER.m` 只定义换乘类型）：用第一条线路的城市兜底，
    // 页面标题才不会变成「 地铁调度」。
    std::string city = p.keyCity;
    if (city.empty())
        for (const Line &l : p.lines)
            if (!l.city.empty()) {
                city = l.city;
                break;
            }
    if (city.empty()) city = "Metro";
    root.emplace("city", json::Value(city));
    root.emplace("version", json::Value(p.version));
    root.emplace("params", json::Value(std::move(params)));
    root.emplace("price", json::Value(std::move(price)));
    root.emplace("transfer_types", std::move(transfers));
    root.emplace("stations", json::Value(std::move(stations)));
    root.emplace("lines", json::Value(std::move(lines)));
    root.emplace("headway", json::Value(std::move(headway)));
    root.emplace("crowd", json::Value(std::move(crowd)));
    root.emplace("stats", json::Value(std::move(stats)));
    return json::Value(std::move(root)).dump();
}

} // namespace metro
