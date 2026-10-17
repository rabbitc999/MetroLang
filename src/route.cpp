/**
 * @file route.cpp
 * @brief 行程规划：口径对齐 metro_editor 的 SimMetroGraph + SimTimeCalculator。
 *
 * 图节点是「方向 + 车站」：
 *   - 运行边：同方向相邻站，代价 = 区间运行时间（物理模型）+ 起点停站时间；
 *   - 换乘边：同站跨方向，代价 = 换乘步行 + 候车等待 `T/2 + t + (C-1)T`。
 * 搜索用 A*，启发式取两站球面距离 / 全网最高速度 —— 与边同量纲（秒），
 * 所以可采纳、不会剪掉最优解。
 */
#include "metro_model.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <map>
#include <queue>
#include <set>
#include <string>
#include <vector>

namespace metro {
namespace {

/** @brief 图里的一条边。 */
struct Edge {
    std::string to;      ///< 目标节点键。
    double seconds = 0;  ///< 代价（秒）。
    bool ride = false;   ///< true = 运行边，false = 换乘边。
};

/** @brief 一个方向在图上需要的信息。 */
struct DirInfo {
    std::string id;                       ///< 方向 ID。
    std::string lineId;                   ///< 线路 ID。
    bool loop = false;                    ///< 是否环线。
    std::string innerOuter;               ///< inner / outer（环线）。
    std::vector<std::string> stations;    ///< 站序。
    std::map<std::string, double> nextKm; ///< 站 -> 到下一站距离（km）。
    /**
     * @brief 区间距离表：`"甲\x1f乙"` -> km，**双向**都登记。
     *
     * `nextKm` 只按「本站 -> 下一站」存，反向走同一段时查不到就会退回球面距离，
     * 明细里的里程便和实际票价口径对不上。这张表把两个方向都铺平，明细直接按
     * 站对查，与建边用的是同一个数。
     */
    std::map<std::string, double> segKm;
};

/** @brief 建好的图。 */
struct Graph {
    std::map<std::string, DirInfo> dirs;                        ///< 方向 -> 信息。
    std::map<std::string, std::vector<std::string>> atStation;  ///< 站 -> 方向列表。
    std::map<std::string, std::vector<Edge>> edges;             ///< 节点键 -> 边。
    std::set<std::string> nodes;                                ///< 所有节点键。
};

/** @brief 节点键：方向 ID + '\x1f' + 站名。 */
std::string nodeKey(const std::string &dir, const std::string &station) {
    return dir + '\x1f' + station;
}

/** @brief 拆节点键。 */
void splitKey(const std::string &key, std::string &dir, std::string &station) {
    const std::size_t pos = key.find('\x1f');
    if (pos == std::string::npos) { dir = key; station.clear(); return; }
    dir = key.substr(0, pos);
    station = key.substr(pos + 1);
}

/** @brief `HH:mm` -> 一天中的分钟数。 */
int minutesOfDay(const std::string &hhmm) {
    const std::size_t colon = hhmm.find(':');
    if (colon == std::string::npos) return -1;
    return std::atoi(hhmm.c_str()) * 60 + std::atoi(hhmm.c_str() + colon + 1);
}

/** @brief 本地时刻：星期（小写三字母）+ 分钟数。 */
struct Clock { std::string day; int minutes = 0; std::string text; };

/**
 * @brief unix 秒 -> 本地时刻。
 *
 * 发车间隔表 `PERIOD 07:00 09:00 …` 是按**本地**时刻写的，所以这里必须取本地时间。
 * `timestamp == 0` 表示用当前时间。
 */
Clock clockAt(std::int64_t timestamp) {
    const std::time_t t = timestamp > 0 ? static_cast<std::time_t>(timestamp) : std::time(nullptr);
    std::tm local{};
#if defined(_WIN32)
    localtime_s(&local, &t);
#else
    localtime_r(&t, &local);
#endif
    static const char *kDays[7] = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"};
    Clock out;
    out.day = kDays[(local.tm_wday >= 0 && local.tm_wday < 7) ? local.tm_wday : 0];
    out.minutes = local.tm_hour * 60 + local.tm_min;
    char buffer[8];
    std::snprintf(buffer, sizeof(buffer), "%02d:%02d", local.tm_hour, local.tm_min);
    out.text = buffer;
    return out;
}

/** @brief 时段是否命中某个时刻（支持跨零点）。 */
bool periodHits(const std::string &start, const std::string &end, const DaySet &days,
                const Clock &now) {
    if (!days.matches(now.day)) return false;
    const int begin = minutesOfDay(start);
    const int finish = minutesOfDay(end);
    if (begin < 0 || finish < 0) return false;
    if (begin <= finish) return now.minutes >= begin && now.minutes < finish;
    return now.minutes >= begin || now.minutes < finish;
}

/** @brief 线路默认最高速度（km/h）。 */
double lineMaxSpeed(const Line &l) { return l.maxspeed > 1.0 ? l.maxspeed : 80.0; }
/** @brief 线路默认牵引功率（kW）。 */
double linePower(const Line &l) { return l.power > 1.0 ? l.power : 2000.0; }
/** @brief 线路默认制动减速度（m/s²）。 */
double lineBrake(const Line &l) { return l.brake > 0.01 ? l.brake : 0.85; }

/** @brief 线路编组（取第一条非空）。 */
std::string lineConsist(const Line &l) {
    for (const std::string &f : l.formations)
        if (!f.empty()) return f;
    return "6B";
}

/** @brief 站点在某线路上的状态。 */
std::string stationLineStatus(const Station *s, const std::string &lineId) {
    if (s == nullptr) return "operating";
    for (const StationLineRef &ref : s->lines)
        if (ref.id == lineId) return ref.status.empty() ? "operating" : ref.status;
    return "operating";
}

/** @brief 站点在某线路上是否不可用（pending / 未开通）。 */
bool stationClosed(const Station *s, const std::string &lineId) {
    const std::string status = stationLineStatus(s, lineId);
    return !(status == "operating" || status == "out_station");
}

/** @brief 找适用于 (站, 线路对) 的 TRANSFER 规则；没有返回 nullptr。 */
const Transfer *findTransfer(const Program &p, const std::string &station, const std::string &lineA,
                            const std::string &lineB) {
    for (const Transfer &t : p.transfers) {
        if (!t.station.empty() && t.station != station) continue;
        const bool direct = (t.lineA == lineA && (t.lineB.empty() || t.lineB == lineB)) ||
                            (t.lineA == lineB && (t.lineB.empty() || t.lineB == lineA));
        const bool mirrored = (t.lineB == lineA && t.lineA == lineB);
        if (direct || mirrored) return &t;
    }
    return nullptr;
}

/** @brief 小写化（状态字段在源码里可能是 `OPERATING` / `Operating` 混写）。 */
std::string toLower(std::string s) {
    for (char &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

/**
 * @brief 换乘是否可用：`operating` / `out_station` 之外的状态（pending 等）不可用。
 *
 * `TRANSFER_TYPE` 里的 `STATUS` 在数据里常写成大写（`OPERATING` / `OUT_STATION`），
 * 比较前统一小写，否则一条正常的同台换乘会被当成"暂缓开通"直接丢掉。
 */
std::string transferStatus(const Program &p, const std::string &station, const std::string &lineA,
                           const std::string &lineB) {
    const Transfer *t = findTransfer(p, station, lineA, lineB);
    if (t == nullptr || t->type.empty()) return "operating";
    for (const TransferType &tt : p.transferTypes)
        if (tt.id == t->type && !tt.status.empty()) return toLower(tt.status);
    return "operating";
}

/** @brief 换乘步行时间（秒）。 */
double transferWalk(const Program &p, const std::string &station, const std::string &lineA,
                    const std::string &lineB) {
    const Transfer *t = findTransfer(p, station, lineA, lineB);
    if (t != nullptr) {
        if (t->hasTime && t->time > 0) return static_cast<double>(t->time);
        for (const TransferType &tt : p.transferTypes)
            if (tt.id == t->type && tt.time > 0) return static_cast<double>(tt.time);
    }
    const std::string status = transferStatus(p, station, lineA, lineB);
    if (status == "out_station") return static_cast<double>(p.outStationTransferTime);
    return static_cast<double>(p.transferTime);
}

/** @brief 某站出发前的停站时间（秒），优先级 NODE > DIRECTION > LINE > 方向 > 全局。 */
double dwellAt(const Program &p, const Direction &d, const std::string &lineId,
               const std::string &station) {
    for (const DwellRule &r : p.dwellRules)
        if (r.kind == DwellRule::Node && r.station == station &&
            (r.lineId.empty() || r.lineId == lineId))
            return r.seconds;
    for (const DwellRule &r : p.dwellRules)
        if (r.kind == DwellRule::Direction && r.dirId == d.id) return r.seconds;
    for (const DwellRule &r : p.dwellRules)
        if (r.kind == DwellRule::Line && r.lineId == lineId) return r.seconds;
    for (const DirStation &s : d.stations)
        if (s.name == station && s.dwell >= 0.0) return s.dwell;
    if (d.dwellTime >= 0.0) return d.dwellTime;
    return static_cast<double>(p.dwellTime);
}

/** @brief 区间限速（km/h），SPEED_LIMIT_DEFINE 覆盖线路默认值。 */
double limitSpeed(const Program &p, const std::string &dirId, const std::string &from,
                  const std::string &to, double fallback) {
    for (const SpeedLimitRule &r : p.speedLimits)
        if (r.dirId == dirId && r.from == from && r.to == to) return r.kmh;
    // 反向写法也认（数据里可能只写了单向）。
    for (const SpeedLimitRule &r : p.speedLimits)
        if (r.dirId == dirId && r.from == to && r.to == from) return r.kmh;
    return fallback;
}

/**
 * @brief 一条运行边的代价：区间运行时间 + 出发站的停站时间。
 *
 * 停站只算**出发站**：一条 N 站的乘车段有 N-1 条运行边，正好覆盖中间 N-1 个站
 * （含出发站、不含终点站），与 C# `SimTimeCalculator` 的口径一致——到终点站就下车，
 * 不用再等它发车。这样各边相加不会重复计停站。
 */
double rideSeconds(const Program &p, const Line &line, const Direction &d, const std::string &from,
                   const std::string &to, double km) {
    const double speed = limitSpeed(p, d.id, from, to, lineMaxSpeed(line));
    const double run =
        segmentRunTimeExact(km, lineConsist(line), speed, linePower(line), lineBrake(line));
    return run + dwellAt(p, d, line.id, from);
}

/** @brief 建图。 */
Graph buildGraph(const Program &p, const RouteOptions &options) {
    Graph g;
    for (const Line &line : p.lines) {        if (line.disabled) continue;
        const bool skipSpecial = options.excludeSpecial && line.special;
        for (const Direction &d : line.directions) {
            if (d.isFuture || skipSpecial || d.stations.size() < 2) continue;
            DirInfo info;
            info.id = d.id;
            info.lineId = line.id;
            info.loop = d.loop;
            info.innerOuter = d.directionType;
            for (std::size_t i = 0; i < d.stations.size(); ++i) {
                info.stations.push_back(d.stations[i].name);
                if (i + 1 < d.stations.size() && d.stations[i].next > 0)
                    info.nextKm[d.stations[i].name] = d.stations[i].next;
            }
            for (const std::string &name : info.stations) {
                g.atStation[name].push_back(d.id);
                g.nodes.insert(nodeKey(d.id, name));
            }
            const std::string id = d.id;
            // 区间距离双向登记：建边和明细都从这里取，反向走同一段时不会退化成球面距离。
            {
                const char SEP = '\x1f';
                for (std::size_t i = 0; i + 1 < d.stations.size(); ++i) {
                    double km = d.stations[i].next;
                    if (km <= 0.0) {
                        const Station *a = p.findStation(d.stations[i].name);
                        const Station *b = p.findStation(d.stations[i + 1].name);
                        km = (a != nullptr && b != nullptr) ? stationDistanceKm(*a, *b) : 0.0;
                    }
                    if (km <= 0.0) continue;
                    info.segKm[d.stations[i].name + SEP + d.stations[i + 1].name] = km;
                    info.segKm[d.stations[i + 1].name + SEP + d.stations[i].name] = km;
                }
                if (d.loop && d.stations.size() > 2) {
                    const std::string &last = d.stations.back().name;
                    const std::string &first = d.stations.front().name;
                    const auto found = info.nextKm.find(last);
                    if (found != info.nextKm.end() && found->second > 0) {
                        info.segKm[last + SEP + first] = found->second;
                        info.segKm[first + SEP + last] = found->second;
                    }
                }
            }
            // 运行边。
            for (std::size_t i = 0; i + 1 < d.stations.size(); ++i) {
                const std::string &from = d.stations[i].name;
                const std::string &to = d.stations[i + 1].name;
                double km = d.stations[i].next;
                if (km <= 0.0) {
                    const Station *a = p.findStation(from);
                    const Station *b = p.findStation(to);
                    km = (a != nullptr && b != nullptr) ? stationDistanceKm(*a, *b) : 0.0;
                }
                if (km <= 0.0) continue;
                const double seconds = rideSeconds(p, line, d, from, to, km);
                g.edges[nodeKey(id, from)].push_back(Edge{nodeKey(id, to), seconds, true});
                g.edges[nodeKey(id, to)].push_back(Edge{nodeKey(id, from), seconds, true});
            }
            // 环线闭合边。
            if (d.loop && d.stations.size() > 2) {
                const std::string &last = d.stations.back().name;
                const std::string &first = d.stations.front().name;
                const auto found = info.nextKm.find(last);
                if (found != info.nextKm.end() && found->second > 0) {
                    const double seconds = rideSeconds(p, line, d, last, first, found->second);
                    g.edges[nodeKey(id, last)].push_back(Edge{nodeKey(id, first), seconds, true});
                    g.edges[nodeKey(id, first)].push_back(Edge{nodeKey(id, last), seconds, true});
                }
            }
            g.dirs[id] = std::move(info);
        }
    }

    // 换乘边：同站跨线路的两个方向之间。
    for (const auto &kv : g.atStation) {
        const std::vector<std::string> &dirIds = kv.second;
        for (std::size_t i = 0; i < dirIds.size(); ++i) {
            for (std::size_t j = 0; j < dirIds.size(); ++j) {
                if (i == j) continue;
                const DirInfo &a = g.dirs[dirIds[i]];
                const DirInfo &b = g.dirs[dirIds[j]];
                if (a.lineId == b.lineId) continue;
                const Station *s = p.findStation(kv.first);
                if (stationClosed(s, a.lineId) || stationClosed(s, b.lineId)) continue;
                const std::string status = transferStatus(p, kv.first, a.lineId, b.lineId);
                if (!(status == "operating" || status == "out_station")) continue;
                // 换乘的完整代价 = 步行 + 等下一趟车。等车必须计入，否则 A* 会把
                // "多换乘、每段只坐一两站"当成捷径（因为长区间的累计运行秒数总比
                // 换乘步行大），算出明显绕远的路线。
                double cost = transferWalk(p, kv.first, a.lineId, b.lineId);
                cost += waitSeconds(p, b.id, options.timestamp);
                cost += options.transferPenalty;
                if (options.preferFewerTransfers) cost += 600.0;
                g.edges[nodeKey(a.id, kv.first)].push_back(Edge{nodeKey(b.id, kv.first), cost, false});
            }
        }
    }
    return g;
}

/** @brief 全网最高速度（A* 启发式用）。 */
double fastestSpeed(const Program &p) {
    double best = 80.0;
    for (const Line &l : p.lines) best = std::max(best, lineMaxSpeed(l));
    return best;
}

/** @brief 站到站的最小可能耗时（秒），A* 启发式。 */
double heuristic(const Program &p, const std::string &from, const std::string &to, double kmh) {
    const Station *a = p.findStation(from);
    const Station *b = p.findStation(to);
    if (a == nullptr || b == nullptr || !a->hasCoord || !b->hasCoord) return 0.0;
    return stationDistanceKm(*a, *b) / (kmh / 3.6);
}

/** @brief 线路显示名：跨城市时加城市前缀（与 C# `BuildDisplayName` 一致）。 */
std::string displayName(const Program &p, const Line &l) {
    const std::string name = l.name.empty() ? l.id : l.name;
    const std::string city = l.city.empty() ? p.keyCity : l.city;
    if (city.empty() || city == p.keyCity) return name;
    return city + name;
}

/** @brief 方向的"开往"终点：环线给内环/外环，其余给该段实际终点。 */
std::string towardsOf(const Graph &g, const Program &p, const std::string &dirId,
                      const std::vector<std::string> &ridden) {
    const auto found = g.dirs.find(dirId);
    if (found == g.dirs.end()) return std::string();
    const DirInfo &dir = found->second;
    if (dir.loop) {
        const std::string anchor = ridden.size() > 1 ? ridden[1] : dir.stations.front();
        if (dir.innerOuter == "inner") return anchor + "（内环）";
        if (dir.innerOuter == "outer") return anchor + "（外环）";
        return anchor;
    }
    // 按站序判断乘车方向：站序里靠后的一头就是终点。
    const std::size_t first = [&]() -> std::size_t {
        for (std::size_t i = 0; i < dir.stations.size(); ++i)
            if (dir.stations[i] == ridden.front()) return i;
        return std::string::npos;
    }();
    const std::size_t last = [&]() -> std::size_t {
        for (std::size_t i = 0; i < dir.stations.size(); ++i)
            if (dir.stations[i] == ridden.back()) return i;
        return std::string::npos;
    }();
    if (first == std::string::npos || last == std::string::npos) return dir.stations.back();
    return (first < last) ? dir.stations.back() : dir.stations.front();
}

} // namespace

bool DaySet::matches(const std::string &d) const {
    if (any) return true;
    return std::find(days.begin(), days.end(), d) != days.end();
}

int headwayAt(const Program &program, const std::string &lineId, std::int64_t timestamp) {
    const Clock now = clockAt(timestamp);
    for (const HeadwayProfile &profile : program.headways) {
        if (profile.lineId != lineId) continue;
        for (const HeadwayPeriod &period : profile.periods)
            if (periodHits(period.start, period.end, period.days, now)) return period.seconds;
    }
    return 120;
}

double crowdAt(const Program &program, const std::string &dirId, std::int64_t timestamp) {
    const Clock now = clockAt(timestamp);
    for (const CrowdProfile &profile : program.crowds) {
        if (profile.dirId != dirId) continue;
        for (const CrowdPeriod &period : profile.periods)
            if (periodHits(period.start, period.end, period.days, now)) return period.factor;
    }
    return 1.0;
}

std::string lineIdOfDir(const Program &p, const std::string &dirId) {
    for (const Line &l : p.lines)
        for (const Direction &d : l.directions)
            if (d.id == dirId) return l.id;
    return dirId;
}

double waitSeconds(const Program &program, const std::string &dirId, std::int64_t timestamp) {
    const double headway = static_cast<double>(headwayAt(program, lineIdOfDir(program, dirId), timestamp));
    const double crowd = crowdAt(program, dirId, timestamp);
    const double board = static_cast<double>(program.avgBoardTime);
    // `T/2 + t + (C-1)T`：拥挤度 > 1 表示平均要等更多趟。
    return headway / 2.0 + board + (crowd - 1.0) * headway;
}

std::string matchStationName(const Program &p, const std::string &input) {
    if (input.empty()) return std::string();
    for (const Station &s : p.stations)
        if (s.name == input) return s.name;
    std::string lower = input;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    for (const Station &s : p.stations) {
        std::string name = s.name;
        std::transform(name.begin(), name.end(), name.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (name == lower) return s.name;
    }
    for (const Station &s : p.stations)
        if (s.name.rfind(input, 0) == 0) return s.name;
    for (const Station &s : p.stations)
        if (s.name.find(input) != std::string::npos) return s.name;
    return std::string();
}

namespace {

/** @brief 一次 A* 的原始结果（节点序列 + 总秒数）。 */
struct RawPath {
    bool found = false;
    std::vector<std::string> nodes;  ///< 节点键序列。
    double seconds = 0.0;            ///< 边代价之和。
};

/**
 * @brief A*：起点站的所有方向作为多源起点，终点站命中任一方向即结束。
 *
 * @param g 图。
 * @param p 模型（启发式要用坐标）。
 * @param from 起点站。
 * @param to 终点站。
 * @return 原始路径。
 */
RawPath search(const Graph &g, const Program &p, const std::string &from, const std::string &to) {
    RawPath out;
    const auto startIt = g.atStation.find(from);
    const auto goalIt = g.atStation.find(to);
    if (startIt == g.atStation.end() || goalIt == g.atStation.end()) return out;
    if (from == to) { out.found = true; return out; }

    std::set<std::string> goals;
    for (const std::string &dir : goalIt->second) goals.insert(nodeKey(dir, to));
    const double kmh = fastestSpeed(p);

    std::map<std::string, double> best;
    std::map<std::string, std::string> prev;
    using Item = std::pair<double, std::string>;
    std::priority_queue<Item, std::vector<Item>, std::greater<Item>> queue;

    for (const std::string &dir : startIt->second) {
        const std::string key = nodeKey(dir, from);
        best[key] = 0.0;
        queue.push({heuristic(p, from, to, kmh), key});
    }

    std::string goal;
    int popped = 0;
    while (!queue.empty()) {
        const auto [priority, key] = queue.top();
        queue.pop();
        ++popped;
        // 队列里存的是「入队时的 g」，同一个节点可能被更优路径更新过多次。
        // g 与当前 best 不等的项是过期项，直接跳过（否则会用旧代价做出错误判断）。
        std::string kdir, kstation;
        splitKey(key, kdir, kstation);
        const double nodeCost = priority - heuristic(p, kstation, to, kmh);
        const auto bestIt = best.find(key);
        if (bestIt == best.end() || nodeCost > bestIt->second + 1e-9) continue;
        const double cost = bestIt->second;
        if (goals.count(key) != 0) { goal = key; break; }
        const auto edges = g.edges.find(key);
        if (edges == g.edges.end()) continue;
        std::string dir, station;
        splitKey(key, dir, station);
        for (const Edge &edge : edges->second) {
            const double next = cost + edge.seconds;
            const auto found = best.find(edge.to);
            if (found != best.end() && next >= found->second - 1e-9) continue;
            best[edge.to] = next;
            prev[edge.to] = key;
            std::string ndir, nstation;
            splitKey(edge.to, ndir, nstation);
            queue.push({next + heuristic(p, nstation, to, kmh), edge.to});
        }
    }
    if (goal.empty()) return out;

    out.found = true;
    out.seconds = best[goal];
    if (std::getenv("METRO_DEBUG") != nullptr)
        std::fprintf(stderr, "[debug] search %s -> %s: %.1fs, 展开 %d 个节点\n", from.c_str(),
                     to.c_str(), out.seconds, popped);    for (std::string cur = goal;;) {
        out.nodes.push_back(cur);
        const auto found = prev.find(cur);
        if (found == prev.end()) break;
        cur = found->second;
    }
    std::reverse(out.nodes.begin(), out.nodes.end());
    return out;
}

} // namespace

bool shortestSeconds(const Program &p, const std::string &from, const std::string &to,
                     const RouteOptions &options, double &outSeconds) {
    const Graph g = buildGraph(p, options);
    const RawPath raw = search(g, p, from, to);
    if (!raw.found) return false;
    outSeconds = raw.seconds;
    return true;
}

RouteResult planRoute(const Program &p, const std::string &from, const std::string &to,
                      const RouteOptions &options) {
    RouteResult result;
    const std::string start = matchStationName(p, from);
    const std::string finish = matchStationName(p, to);
    if (start.empty()) { result.error = "找不到起点站：" + from; return result; }
    if (finish.empty()) { result.error = "找不到终点站：" + to; return result; }
    result.from = start;
    result.to = finish;
    result.clock = clockAt(options.timestamp).text;

    const Graph g = buildGraph(p, options);
    const RawPath raw = search(g, p, start, finish);
    if (!raw.found) {
        result.error = "没有找到从 " + start + " 到 " + finish + " 的路径（线路可能不连通）";
        return result;
    }

    // 把节点序列切成"同方向连续段"。
    struct Piece { std::string dir; std::vector<std::string> stations; };
    std::vector<Piece> pieces;
    for (const std::string &key : raw.nodes) {
        std::string dir, station;
        splitKey(key, dir, station);
        if (pieces.empty() || pieces.back().dir != dir) pieces.push_back(Piece{dir, {station}});
        else if (pieces.back().stations.back() != station) pieces.back().stations.push_back(station);
    }

    const std::string queryClock = result.clock;
    (void)queryClock;

    for (std::size_t i = 0; i < pieces.size(); ++i) {
        const Piece &piece = pieces[i];
        const auto dirIt = g.dirs.find(piece.dir);
        if (dirIt == g.dirs.end()) continue;
        const DirInfo &dir = dirIt->second;
        const Line *line = const_cast<Program &>(p).findLine(dir.lineId);
        if (line == nullptr) continue;
        const Direction *d = nullptr;
        for (const Direction &cand : line->directions)
            if (cand.id == dir.id) d = &cand;
        if (d == nullptr) continue;

        RouteSegment segment;
        segment.lineId = line->id;
        segment.lineName = displayName(p, *line);
        segment.color = line->color;
        segment.dirId = dir.id;
        segment.from = piece.stations.front();
        segment.to = piece.stations.back();
        segment.stationNames = piece.stations;
        segment.stations = static_cast<int>(piece.stations.size()) - 1;
        if (segment.stations < 0) segment.stations = 0;
        segment.towards = towardsOf(g, p, dir.id, piece.stations);
        if (i > 0) {
            const std::string &prevLine = result.segments.empty() ? std::string()
                                                                 : result.segments.back().lineId;
            if (!prevLine.empty())
                segment.outStationTransfer =
                    transferStatus(p, segment.from, prevLine, line->id) == "out_station";
        }

        // 本段里程与纯运行时间。停站只算中间站（含出发站、不含终点站），
        // 与 rideSeconds 的边口径一致，这样各段相加不会重复计入终点站的停站。
        for (std::size_t k = 0; k + 1 < piece.stations.size(); ++k) {
            const std::string &a = piece.stations[k];
            const std::string &b = piece.stations[k + 1];
            double km = 0.0;
            // 先按站对查（双向登记过），查不到再退回「本站 -> 下一站」。
            const auto pairIt = dir.segKm.find(a + '\x1f' + b);
            if (pairIt != dir.segKm.end()) km = pairIt->second;
            else {
                const auto found = dir.nextKm.find(a);
                if (found != dir.nextKm.end()) km = found->second;
                else {
                    const Station *sa = p.findStation(a);
                    const Station *sb = p.findStation(b);
                    km = (sa != nullptr && sb != nullptr) ? stationDistanceKm(*sa, *sb) : 0.0;
                }
            }
            segment.distanceKm += km;
            const double speed = limitSpeed(p, dir.id, a, b, lineMaxSpeed(*line));
            segment.runSeconds += segmentRunTimeExact(km, lineConsist(*line), speed,
                                                      linePower(*line), lineBrake(*line));
            // 最后一条边到达的就是本段终点，不用再等它发车。
            if (k + 2 < piece.stations.size()) segment.runSeconds += dwellAt(p, *d, line->id, b);
        }

        // 换乘的步行时间在边里已计入搜索代价，这里只做展示汇总；
        // 候车时间统一在下面按「起点等一趟 + 每次换乘等一趟」统计，避免重复。
        if (i > 0) {
            const std::string &prevLine = result.segments.empty() ? std::string()
                                                                 : result.segments.back().lineId;
            if (!prevLine.empty())
                result.transferWalkSeconds += transferWalk(p, segment.from, prevLine, line->id);
        }
        result.runSeconds += segment.runSeconds;
        result.distanceKm += segment.distanceKm;
        result.stops += segment.stations;
        result.stations.insert(result.stations.end(), piece.stations.begin(),
                               piece.stations.end());
        result.segments.push_back(std::move(segment));
    }

    // 候车：起点等一趟车，之后每次换乘再等一趟（与 C# `SimTimeCalculator` 一致）。
    for (std::size_t i = 0; i < result.segments.size(); ++i)
        result.waitSeconds += waitSeconds(p, result.segments[i].dirId, options.timestamp);
    result.transfers = result.segments.empty() ? 0 : static_cast<int>(result.segments.size()) - 1;
    result.entrySeconds = 2.0 * static_cast<double>(p.entryTime);
    // 明细里的 runSeconds 已经按「含出发站、不含终点站」累加，与总计天然自洽，
    // 这里不再额外扣减（旧版扣过一次，导致明细与合计对不上）。
    result.totalSeconds = result.runSeconds + result.transferWalkSeconds + result.waitSeconds +
                          result.entrySeconds;

    double special = 0.0;
    std::string note;
    result.fare = computeFare(p, result.segments, special, note);
    result.specialFare = special;
    result.fareNote = note;
    result.found = !result.segments.empty() || start == finish;
    if (!result.found) result.error = "没有可乘坐的区段";
    return result;
}

std::string RouteResult::guidance() const {
    if (!found) return error;
    if (segments.empty()) return "起点和终点是同一站，无需乘坐地铁。";
    std::string out;
    for (std::size_t i = 0; i < segments.size(); ++i) {
        const RouteSegment &s = segments[i];
        char stations[32];
        std::snprintf(stations, sizeof(stations), "%d", s.stations);
        if (i == 0)
            out += "在【" + s.from + "】上车，先乘坐开往" + s.towards + "方向的" + s.lineName +
                   "，坐" + stations + "站到【" + s.to + "】";
        else if (i + 1 == segments.size())
            out += "最后换乘开往" + s.towards + "方向的" + s.lineName + "，坐" + stations +
                   "站即可到达【" + s.to + "】";
        else
            out += "再换乘开往" + s.towards + "方向的" + s.lineName + "，坐" + stations + "站到【" +
                   s.to + "】";
        out += (i + 1 == segments.size()) ? "。" : "；";
    }
    return out;
}

namespace {

/** @brief JSON 字符串字面量（UTF-8 原样，只转义控制字符与引号）。 */
std::string q(const std::string &s) {
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (const char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char>(c) < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned char>(c));
                out += buf;
            } else {
                out.push_back(c);
            }
        }
    }
    out.push_back('"');
    return out;
}

/** @brief 数字：整数值不带小数点，其余保留两位（秒 / 公里 / 元足够）。 */
std::string n(double v) {
    char buf[32];
    if (std::fabs(v - std::llround(v)) < 1e-9) std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(std::llround(v)));
    else std::snprintf(buf, sizeof buf, "%.2f", v);
    return buf;
}

} // namespace

std::string toJson(const RouteResult &r) {
    std::string out = "{\n";
    out += "  \"found\": " + std::string(r.found ? "true" : "false") + ",\n";
    out += "  \"from\": " + q(r.from) + ",\n";
    out += "  \"to\": " + q(r.to) + ",\n";
    out += "  \"clock\": " + q(r.clock) + ",\n";
    if (!r.error.empty()) out += "  \"error\": " + q(r.error) + ",\n";

    out += "  \"summary\": {\"distance_km\": " + n(r.distanceKm) + ", \"transfers\": " + n(r.transfers) +
           ", \"stops\": " + n(r.stops) + ", \"run_seconds\": " + n(r.runSeconds) +
           ", \"transfer_walk_seconds\": " + n(r.transferWalkSeconds) + ", \"wait_seconds\": " +
           n(r.waitSeconds) + ", \"entry_seconds\": " + n(r.entrySeconds) + ", \"total_seconds\": " +
           n(r.totalSeconds) + ", \"fare\": " + n(r.fare) + ", \"special_fare\": " + n(r.specialFare) +
           ", \"fare_note\": " + q(r.fareNote) + "},\n";

    out += "  \"segments\": [";
    for (std::size_t i = 0; i < r.segments.size(); ++i) {
        const RouteSegment &s = r.segments[i];
        out += (i == 0 ? "\n" : ",\n");
        out += "    {\"line\": " + q(s.lineId) + ", \"line_name\": " + q(s.lineName) +
               ", \"color\": " + q(s.color) + ", \"direction\": " + q(s.dirId) + ", \"towards\": " +
               q(s.towards) + ", \"from\": " + q(s.from) + ", \"to\": " + q(s.to) + ", \"stations\": " +
               n(s.stations) + ", \"distance_km\": " + n(s.distanceKm) + ", \"run_seconds\": " +
               n(s.runSeconds) + ", \"out_station_transfer\": " +
               (s.outStationTransfer ? "true" : "false") + ", \"path\": [";
        for (std::size_t k = 0; k < s.stationNames.size(); ++k)
            out += (k == 0 ? "" : ", ") + q(s.stationNames[k]);
        out += "]}";
    }
    out += r.segments.empty() ? "],\n" : "\n  ],\n";

    out += "  \"stations\": [";
    for (std::size_t i = 0; i < r.stations.size(); ++i)
        out += (i == 0 ? "" : ", ") + q(r.stations[i]);
    out += "],\n";

    out += "  \"guidance\": " + q(r.guidance()) + "\n}\n";
    return out;
}

} // namespace metro
