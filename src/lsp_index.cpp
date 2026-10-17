/**
 * @file lsp_index.cpp
 * @brief 语言服务器的源码语义索引实现。
 *
 * 索引的形状是「一行 = 若干词素，每个词素可能对应模型里的一个实体」。重建时
 * 逐行扫描，把能在模型里查到的名字（站名 / 线路 ID / 方向 ID / 运营参数键）
 * 各记一条 `IndexEntry`，供 hover 与"跳转到定义"使用。
 *
 * 索引刻意**不做**语法分析：只要模型里查得到，就认它是这个名字。这样即便
 * 文档里有语法错误，标识符提示依然可用——这正是编辑器最需要它的时刻。
 */
#include "lsp_index.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace metro {
namespace {

/** @brief 去首尾空白。 */
std::string trimmed(const std::string &s) {
    const std::size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return {};
    const std::size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

/** @brief 转大写。 */
std::string upper(std::string s) {
    for (char &c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

/** @brief 数字 / 时间 / 负数。 */
bool looksNumeric(const std::string &s) {
    if (s.empty()) return false;
    bool digit = false;
    for (const char c : s) {
        if (std::isdigit(static_cast<unsigned char>(c))) { digit = true; continue; }
        if (c == '.' || c == '-' || c == '+' || c == ':') continue;
        return false;
    }
    return digit;
}

/**
 * @brief 一行拆词：引号串算一个词（去引号并解转义），`#` 之后是注释。
 * @param line 一行源码。
 * @return 词素表（含字节区间）。
 */
std::vector<IndexToken> tokenize(const std::string &line) {
    std::vector<IndexToken> out;
    std::size_t i = 0;
    while (i < line.size()) {
        const char c = line[i];
        if (c == ' ' || c == '\t' || c == '\r') { ++i; continue; }
        if (c == '#') break;
        IndexToken token;
        if (c == '\'' || c == '"') {
            const char quote = c;
            token.begin = i;
            token.quoted = true;
            ++i;
            std::string text;
            while (i < line.size() && line[i] != quote) {
                if (line[i] == '\\' && i + 1 < line.size()) {
                    const char e = line[i + 1];
                    text.push_back(e == 'n' ? '\n' : e == 't' ? '\t' : e == 'r' ? '\r' : e);
                    i += 2;
                    continue;
                }
                text.push_back(line[i]);
                ++i;
            }
            if (i < line.size()) ++i;  // 收尾引号
            token.text = std::move(text);
            token.end = i;
            out.push_back(std::move(token));
            continue;
        }
        token.begin = i;
        while (i < line.size() && line[i] != ' ' && line[i] != '\t' && line[i] != '\r' &&
               line[i] != '#' && line[i] != '\'' && line[i] != '"')
            ++i;
        token.text = line.substr(token.begin, i - token.begin);
        token.end = i;
        out.push_back(std::move(token));
    }
    return out;
}

/** @brief 浮点转文本：整数值不带小数点。 */
std::string numText(double v) {
    char buf[32];
    if (std::fabs(v - std::llround(v)) < 1e-9)
        std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(std::llround(v)));
    else
        std::snprintf(buf, sizeof buf, "%.5f", v);
    return buf;
}

/** @brief 线路签名（hover 顶部代码块）。 */
std::string lineSignature(const Line &l) {
    std::string s = "LINE_DEFINE " + l.id;
    if (!l.name.empty()) s += "   # " + l.name;
    return s;
}

/** @brief 线路说明。 */
std::string lineDoc(const Line &l) {
    std::ostringstream ss;
    ss << "**线路**"
       << "`" << l.id << "`" << (l.name.empty() ? "" : " · " + l.name) << "\n\n";
    if (!l.city.empty()) ss << "- 城市：`" << l.city << "`\n";
    if (!l.color.empty()) ss << "- 颜色：`" << l.color << "`\n";
    if (!l.formations.empty()) {
        ss << "- 编组：";
        for (std::size_t i = 0; i < l.formations.size(); ++i)
            ss << (i == 0 ? "" : " / ") << "`" << l.formations[i] << "`";
        ss << "\n";
    }
    ss << "- 最高速度：" << numText(l.maxspeed) << " km/h\n";
    if (l.power > 0) ss << "- 牵引功率：" << numText(l.power) << " kW\n";
    if (l.brake > 0) ss << "- 制动减速度：" << numText(l.brake) << " m/s²\n";
    ss << "- 方向数：" << l.directions.size() << "\n";
    if (l.special) ss << "- **特殊线路**（`SPECIAL_LINE` 单独计价）\n";
    if (l.disabled) ss << "- **已停用**\n";
    return ss.str();
}

/** @brief 车站签名。 */
std::string stationSignature(const Station &s) {
    std::string out = "STATION_DEFINE '" + s.name + "'";
    if (s.hasCoord) out += "  " + numText(s.lon) + ", " + numText(s.lat);
    return out;
}

/** @brief 车站说明。 */
std::string stationDoc(const Station &s) {
    std::ostringstream ss;
    ss << "**车站**" << s.name << "\n\n";
    if (s.hasCoord) ss << "- 坐标：`" << numText(s.lon) << ", " << numText(s.lat) << "`\n";
    else ss << "- **缺坐标**（`DISTANCE AUTO`、坐标校正、地图预览都依赖它）\n";
    if (!s.city.empty()) ss << "- 城市：`" << s.city << "`\n";
    if (!s.otherNames.empty()) {
        ss << "- 别名：";
        for (std::size_t i = 0; i < s.otherNames.size(); ++i)
            ss << (i == 0 ? "" : " / ") << s.otherNames[i];
        ss << "\n";
    }
    ss << "- 经过线路：" << s.lines.size() << " 条";
    if (!s.lines.empty()) {
        ss << "（";
        for (std::size_t i = 0; i < s.lines.size(); ++i)
            ss << (i == 0 ? "" : "、") << "`" << s.lines[i].id << "`";
        ss << "）";
    }
    ss << "\n";
    if (s.access.present) ss << "- 有 `ACCESSIBLE` 无障碍设施声明\n";
    return ss.str();
}

/** @brief 方向签名与说明。 */
std::string directionDoc(const Direction &d, const Line &l) {
    std::ostringstream ss;
    ss << "**方向**" << "`" << d.id << "`（线路 `" << l.id << "`）\n\n";
    if (!d.stations.empty()) {
        ss << "- 起点：" << d.stations.front().name << "\n";
        ss << "- 终点：" << d.stations.back().name << "\n";
    }
    ss << "- 站数：" << d.stations.size() << "\n";
    if (d.loop) ss << "- 环线" << (d.directionType.empty() ? "" : "（" + d.directionType + "）") << "\n";
    if (d.isFuture) ss << "- 规划中（不参与路线查询）\n";
    if (!d.expressStops.empty()) ss << "- 快车停靠：" << d.expressStops.size() << " 站\n";
    return ss.str();
}

/** @brief 运营参数键的说明表。 */
struct OpKeyInfo { const char *keyword; const char *title; const char *unit; };

const OpKeyInfo *opKeyInfo(const std::string &head) {
    static const OpKeyInfo kTable[] = {
        {"TRANSFER_TIME", "站内换乘时间", "秒"},
        {"OUT_STATION_TRANSFER_TIME", "出站换乘时间", "秒"},
        {"DWELL_TIME", "默认停站时间", "秒"},
        {"ENTRY_TIME", "进出站时间（单端）", "秒"},
        {"AVG_BOARD_TIME", "平均上车时间", "秒"},
        {"WALK_SPEED", "步行速度", "m/s"},
    };
    for (const OpKeyInfo &info : kTable)
        if (head == info.keyword) return &info;
    return nullptr;
}

} // namespace

void SourceIndex::build(const Program &program, const std::string &text) {
    entries_.clear();
    lines_.clear();
    tokensByLine_.clear();

    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines_.push_back(line);
    }

    for (std::size_t i = 0; i < lines_.size(); ++i) {
        std::vector<IndexToken> tokens = tokenize(lines_[i]);
        indexLine(program, static_cast<int>(i), tokens);
        tokensByLine_.push_back(std::move(tokens));
    }

    // 按行号排序，让 documentSymbol 与「最近定义」的查找都稳定。
    std::stable_sort(entries_.begin(), entries_.end(),
                     [](const IndexEntry &a, const IndexEntry &b) {
                         if (a.line != b.line) return a.line < b.line;
                         return a.column < b.column;
                     });
}

void SourceIndex::indexLine(const Program &program, int line,
                            const std::vector<IndexToken> &tokens) {
    if (tokens.empty()) return;
    const std::string head = upper(tokens[0].text);

    auto pushEntry = [&](const IndexToken &token, std::string kind, std::string signature,
                         std::string doc, bool declaration) {
        IndexEntry entry;
        entry.kind = std::move(kind);
        entry.name = token.text;
        entry.signature = std::move(signature);
        entry.doc = std::move(doc);
        entry.line = line;
        entry.column = token.begin;
        entry.length = token.end - token.begin;
        entry.declaration = declaration;
        addDefinition(std::move(entry));
    };

    // ---- 块头：线路 / 车站的定义与修改 ----
    const bool isLineHead = head == "LINE_DEFINE" || head == "LINE_MODIFY" ||
                            head == "LINE_TEMPLATE";
    const bool isStationHead = head == "STATION_DEFINE" || head == "STATION_MODIFY";
    if ((isLineHead || isStationHead) && tokens.size() >= 2) {
        const IndexToken &target = tokens[1];
        if (isLineHead) {
            if (const Line *l = program.findLine(target.text))
                pushEntry(target, "line", lineSignature(*l), lineDoc(*l), true);
        } else {
            if (const Station *s = program.findStation(target.text))
                pushEntry(target, "station", stationSignature(*s), stationDoc(*s), true);
        }
        // 块头之后同行的别的词素（如 `LINE_DEFINE G3 NAME '三号线'`）仍然当引用扫描。
    }

    // ---- `NODE '站名' 经度 纬度`：车站的真正定义处（多数数据这么写） ----
    if (head == "NODE" && tokens.size() >= 2) {
        if (const Station *s = program.findStation(tokens[1].text))
            pushEntry(tokens[1], "station", stationSignature(*s), stationDoc(*s), true);
    }

    // ---- 运营参数键：`ENTRY_TIME 120` ----
    if (const OpKeyInfo *info = opKeyInfo(head)) {
        IndexToken keyToken = tokens[0];
        std::string sig = tokens[0].text;
        if (tokens.size() >= 2) sig += " " + tokens[1].text;
        std::ostringstream doc;
        doc << "**" << info->title << "**（运营参数）\n\n";
        if (tokens.size() >= 2)
            doc << "当前值：`" << tokens[1].text << "` " << info->unit
                << "\n\n用于行程时间估算（`route` 命令与 `SimTimeCalculator` 同口径）。";
        else
            doc << "写在 `OPERATION_DEFINE` 块里，单位为" << info->unit << "。";
        pushEntry(keyToken, "operation", sig, doc.str(), true);
    }

    // ---- 其余词素：能在这条线上查到的名字都记一条引用 ----
    std::string ownerLine;
    if (isLineHead && tokens.size() >= 2) ownerLine = tokens[1].text;

    for (std::size_t i = 0; i < tokens.size(); ++i) {
        const IndexToken &token = tokens[i];
        if (token.text.empty() || looksNumeric(token.text)) continue;
        // 行首关键字不当名字（`LINE`、`NODE`、`STATIONS` 这些本身也是标识符）。
        if (i == 0 && !token.quoted) continue;

        if (const Station *s = program.findStation(token.text)) {
            pushEntry(token, "station", stationSignature(*s), stationDoc(*s), false);
            continue;
        }
        if (const Line *l = program.findLine(token.text)) {
            pushEntry(token, "line", lineSignature(*l), lineDoc(*l), false);
            continue;
        }
        for (const Line &l : program.lines) {
            bool matched = false;
            for (const Direction &d : l.directions) {
                if (d.id != token.text) continue;
                pushEntry(token, "direction", "DIRECTION " + d.id, directionDoc(d, l), false);
                matched = true;
                break;
            }
            if (matched) break;
        }
    }
    (void)ownerLine;
}

const IndexEntry *SourceIndex::lookup(int line, std::size_t column) const {
    if (line < 0 || line >= static_cast<int>(tokensByLine_.size())) return nullptr;
    const std::vector<IndexToken> &tokens = tokensByLine_[static_cast<std::size_t>(line)];

    const IndexToken *hit = nullptr;
    for (const IndexToken &token : tokens) {
        // 光标落在词素内部或紧邻结尾都算命中（编辑器习惯）。
        if (column >= token.begin && column <= token.end) { hit = &token; break; }
    }
    if (hit == nullptr || hit->text.empty()) return nullptr;

    // 1) 本行就是这个位置的定义，最精确。
    for (const IndexEntry &entry : entries_)
        if (entry.line == line && entry.column == hit->begin) return &entry;

    // 2) 同名里挑最近的（同行优先，其次行距最小）。定义优先于引用。
    const IndexEntry *best = nullptr;
    int bestScore = 0;
    for (const IndexEntry &entry : entries_) {
        if (entry.name != hit->text) continue;
        const int distance = std::abs(entry.line - line);
        const int score = distance * 2 + (entry.declaration ? 0 : 1);
        if (best == nullptr || score < bestScore) { best = &entry; bestScore = score; }
    }
    return best;
}

std::vector<const IndexEntry *> SourceIndex::definitionsOf(const std::string &name) const {
    std::vector<const IndexEntry *> out;
    for (const IndexEntry &entry : entries_)
        if (entry.name == name) out.push_back(&entry);
    return out;
}

const std::vector<IndexToken> &SourceIndex::tokens(int line) const {
    static const std::vector<IndexToken> kEmpty;
    if (line < 0 || line >= static_cast<int>(tokensByLine_.size())) return kEmpty;
    return tokensByLine_[static_cast<std::size_t>(line)];
}

bool SourceIndex::blankLine(int line) const {
    if (line < 0 || line >= static_cast<int>(lines_.size())) return true;
    const std::string text = trimmed(lines_[static_cast<std::size_t>(line)]);
    return text.empty() || text[0] == '#';
}

} // namespace metro
