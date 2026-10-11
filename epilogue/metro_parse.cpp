/**
 * @file metro_parse.cpp
 * @brief MetroLang 语义层与解析入口（由 metrolang.gram 的 %epilogue 内嵌）。
 *
 * 本文件不单独编译：解析器生成器生成 `parser.cpp` 时把它内嵌到产物末尾，
 * 所以「词法 + 语法 + 语义 + 解析驱动」是同一份生成结果，`src/` 里没有手写
 * 的解析流程。
 *
 * 语义层按「当前块 + 行首关键字」把每行折叠进 `metro::Program`；未建模的块
 * 与命令原样进 `Program::raw`，反编译时再原样写回。
 */
#include "metro_semantics.hpp"
#include "parser.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <sstream>

namespace metro {
namespace {

/** @brief 值表里的一个词法单元。 */
struct Lex {
    int kind = 3;      ///< 1 数字 / 2 字符串 / 3 其它。
    std::string text;  ///< 词素（字符串已去引号解转义）。
    double num = 0.0;  ///< 数值（kind == 1）。
};

/** @brief 当前行的一个参数。 */
struct Val {
    char kind = 'i';   ///< 's' 字符串 / 'n' 数字 / ':' 冒号 / 'i' 标识符或关键字。
    std::string text;  ///< 文本。
    double num = 0.0;  ///< 数值。
};

/** @brief 块栈的一帧。 */
struct Frame {
    BlockKind kind;                     ///< 块种类。
    int line = -1;                      ///< 目标线路下标（-1 表示无）。
    int dir = -1;                       ///< 目标方向下标。
    int station = -1;                   ///< STATION_DEFINE 里最近一个站点下标。
    std::string head;                   ///< 块头原文（含关键字）。
    std::string target;                 ///< 块头第一个参数（*_MODIFY 的目标对象 ID）。
    std::vector<std::string> body;      ///< 未建模的成员行（原样保留）。
};

std::vector<Lex> g_pool;             ///< 值表。
Program g_program;                   ///< 输出模型。
std::vector<std::string> g_errors;   ///< 诊断。
std::vector<Val> g_args;             ///< 当前行参数。
std::vector<Frame> g_stack;          ///< 块栈。
std::string g_head;                  ///< 当前行首关键字（大写）。
std::string g_headRaw;               ///< 当前行首原文。
std::vector<std::string> g_rawLines; ///< 未建模块的原始行。

/** @brief 去首尾空白。 */
std::string trimWs(const std::string &s) {
    std::size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    std::size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

/** @brief 转大写。 */
std::string upper(std::string s) {
    for (char &c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

/** @brief 转小写。 */
std::string lower(std::string s) {
    for (char &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

/** @brief 去引号并解转义（只有成对引号才处理，避免砍掉多字节字符）。 */
std::string unescape(const std::string &raw) {
    std::string s = trimWs(raw);
    if (s.size() >= 2 && ((s.front() == '\'' && s.back() == '\'') ||
                          (s.front() == '"' && s.back() == '"'))) {
        std::string out;
        for (std::size_t i = 1; i + 1 < s.size(); ++i) {
            if (s[i] == '\\' && i + 2 < s.size()) {
                char e = s[++i];
                switch (e) {
                    case 'n': out.push_back('\n'); break;
                    case 't': out.push_back('\t'); break;
                    case 'r': out.push_back('\r'); break;
                    default: out.push_back(e);
                }
            } else {
                out.push_back(s[i]);
            }
        }
        return out;
    }
    return s;
}

/** @brief 参数是否是指定标记（关键字 / 标识符，大小写不敏感）。 */
bool isMark(const Val &v, const char *mark) { return upper(trimWs(v.text)) == mark; }

/** @brief 取第 i 个参数的文本（字符串原样，其它去引号）。 */
std::string argText(std::size_t i) {
    return i < g_args.size() ? g_args[i].text : std::string();
}
/** @brief 取第 i 个参数的大写文本。 */
std::string argKey(std::size_t i) { return upper(trimWs(argText(i))); }
/** @brief 取第 i 个参数的数值（沿用参数里的 num）。 */
double argNum(std::size_t i, double fallback = 0.0) {
    return i < g_args.size() ? g_args[i].num : fallback;
}

/** @brief 时间参数 -> 秒：`30` = 30，`1:` = 60，`1:30` = 90。 */
double timeSeconds(std::size_t i) {
    if (i >= g_args.size()) return 0.0;
    double first = g_args[i].num;
    if (i + 2 < g_args.size() && g_args[i + 1].kind == ':' && g_args[i + 2].kind == 'n')
        return first * 60.0 + g_args[i + 2].num;
    if (i + 1 < g_args.size() && g_args[i + 1].kind == ':') return first * 60.0;
    return first;
}

/** @brief 把当前行还原成一句可读文本（未建模命令原样保留用）。 */
std::string lineText() {
    std::string out = g_headRaw.empty() ? g_head : g_headRaw;
    for (const Val &v : g_args) {
        if (v.kind == ':') { out += ":"; continue; }
        if (v.kind == 's') out += " '" + v.text + "'";
        else out += " " + v.text;
    }
    return out;
}

/** @brief 记录一句未建模文本（在块内就挂到当前帧，关块时按块结构写出）。 */
void keepRaw() {
    std::string text = lineText();
    if (!g_stack.empty()) g_stack.back().body.push_back(std::move(text));
    else g_program.raw.push_back(RawLine{std::move(text)});
}

/** @brief 块种类 -> 块头关键字（未建模块原样保留时用于还原块头）。 */
const char *blockHeadName(BlockKind kind) {
    switch (kind) {
        case MB_TRANSFER_TYPE: return "TRANSFER_TYPE";
        case MB_TRANSFER_DEFINE: return "TRANSFER_DEFINE";
        case MB_VIRTUAL_TRANSFER: return "VIRTUAL_TRANSFER_DEFINE";
        case MB_LINE_TEMPLATE: return "LINE_TEMPLATE";
        case MB_DIRECTION_TEMPLATE: return "DIRECTION_TEMPLATE";
        case MB_HEADWAY_PROFILE: return "HEADWAY_PROFILE";
        case MB_CROWD_PROFILE: return "CROWD_PROFILE";
        case MB_DWELL_DEFINE: return "DWELL_TIME_DEFINE";
        case MB_SPEED_LIMIT_DEFINE: return "SPEED_LIMIT_DEFINE";
        case MB_LABEL_DEFINE: return "LABEL_DEFINE";
        case MB_FACILITY_DEFINE: return "FACILITY_DEFINE";
        case MB_PROMOTION_DEFINE: return "PROMOTION_DEFINE";
        case MB_POLICY: return "POLICY";
        case MB_ZONE_DEFINE: return "ZONE_DEFINE";
        case MB_ATTRIBUTES: return "ATTRIBUTES";
        case MB_OPERATOR_DEFINE: return "OPERATOR_DEFINE";
        case MB_BACKGROUND_DEFINE: return "BACKGROUND_DEFINE";
        case MB_SPECIAL_DEFINE: return "SPECIAL_DEFINE";
        case MB_STATION_MODIFY: return "STATION_MODIFY";
        case MB_LINE_MODIFY: return "LINE_MODIFY";
        case MB_DIRECTION_MODIFY: return "DIRECTION_MODIFY";
        default: return "";
    }
}

/** @brief 块种类是否整块未建模（关块时按块结构原样写出）。 */
bool isRawBlock(BlockKind kind) {
    switch (kind) {
        case MB_TRANSFER_DEFINE:
        case MB_VIRTUAL_TRANSFER:
        case MB_LINE_TEMPLATE:
        case MB_DIRECTION_TEMPLATE:
        case MB_HEADWAY_PROFILE:
        case MB_CROWD_PROFILE:
        case MB_DWELL_DEFINE:
        case MB_SPEED_LIMIT_DEFINE:
        case MB_LABEL_DEFINE:
        case MB_OPERATOR_DEFINE:
        case MB_BACKGROUND_DEFINE:
        case MB_SPECIAL_DEFINE:
        case MB_ATTRIBUTES:
        case MB_POLICY:
            return true;
        default:
            return false;
    }
}

/** @brief 当前区块（栈顶）。 */
Frame &top() {
    static Frame dummy{MB_SPECIAL_DEFINE, -1, -1, -1, "", "", {}};
    return g_stack.empty() ? dummy : g_stack.back();
}

/** @brief 目标线路指针（栈顶帧）。 */
Line *frameLine() {
    if (g_stack.empty()) return nullptr;
    int idx = g_stack.back().line;
    if (idx < 0 || idx >= static_cast<int>(g_program.lines.size())) return nullptr;
    return &g_program.lines[idx];
}

/** @brief 目标方向指针（栈顶帧）。 */
Direction *frameDirection() {
    Line *l = frameLine();
    if (l == nullptr) return nullptr;
    int idx = g_stack.back().dir;
    if (idx < 0 || idx >= static_cast<int>(l->directions.size())) return nullptr;
    return &l->directions[idx];
}

/** @brief 收集当前行里所有字符串参数。 */
std::vector<std::string> stringArgs() {
    std::vector<std::string> out;
    for (const Val &v : g_args)
        if (v.kind == 's') out.push_back(v.text);
    return out;
}

/**
 * @brief 收集当前行的"值"参数文本（字符串优先，没有字符串时取第一个非标记词）。
 *
 * `FORMATION '6B'` 与 `FORMATION 6B` 都算一条；`LINK 'a' 'b'` 算两条。
 * 标点（逗号 / 冒号）与括号不进结果。
 */
std::vector<std::string> valueArgs() {
    std::vector<std::string> out;
    for (const Val &v : g_args)
        if (v.kind == 's') out.push_back(v.text);
    if (!out.empty()) return out;
    for (const Val &v : g_args) {
        if (v.kind == 'i') { out.push_back(v.text); break; }
    }
    return out;
}

/** @brief 收集当前行里所有数字参数。 */
std::vector<double> numberArgs() {
    std::vector<double> out;
    for (const Val &v : g_args)
        if (v.kind == 'n') out.push_back(v.num);
    return out;
}

// ---------------- 各块的行处理 ----------------
void lineProgram() {
    if (g_head == "KEY_CITY") g_program.keyCity = argText(0);
    else if (g_head == "OTHER_CITY") { for (auto &s : stringArgs()) g_program.otherCities.push_back(s); }
    else if (g_head == "VERSION") g_program.version = argText(0);
    else if (g_head == "AUTHOR") g_program.author = argText(0);
    else if (g_head == "CREATE_DATE") g_program.createDate = argText(0);
    else if (g_head == "UPDATE_DATE") g_program.updateDate = argText(0);
    else keepRaw();
}

void lineStation() {
    if (g_head == "NODE") {
        Station s;
        s.name = argText(0);
        for (std::size_t i = 1; i < g_args.size(); ++i) {
            if (isMark(g_args[i], "COORD")) {
                if (i + 2 < g_args.size()) { s.lon = g_args[i + 1].num; s.lat = g_args[i + 2].num; s.hasCoord = true; }
            } else if (isMark(g_args[i], "CITY")) {
                if (i + 1 < g_args.size()) s.city = g_args[i + 1].text;
            }
        }
        // 同名站点合并（后出现的坐标 / 城市覆盖）
        for (Station &old : g_program.stations) {
            if (old.name == s.name) {
                if (s.hasCoord) { old.lon = s.lon; old.lat = s.lat; old.hasCoord = true; }
                if (!s.city.empty()) old.city = s.city;
                g_stack.back().station = static_cast<int>(&old - &g_program.stations[0]);
                return;
            }
        }
        g_program.stations.push_back(s);
        g_stack.back().station = static_cast<int>(g_program.stations.size()) - 1;
    } else if (g_head == "OTHER_NAME" || g_head == "OTHER_NAMES") {
        int idx = top().station;
        if (idx >= 0 && idx < static_cast<int>(g_program.stations.size()))
            for (auto &s : stringArgs()) g_program.stations[idx].otherNames.push_back(s);
        else keepRaw();
    } else if (g_head == "COORD" || g_head == "CITY") {
        int idx = top().station;
        if (idx >= 0 && idx < static_cast<int>(g_program.stations.size())) {
            Station &s = g_program.stations[idx];
            if (g_head == "COORD" && g_args.size() >= 2) { s.lon = g_args[0].num; s.lat = g_args[1].num; s.hasCoord = true; }
            else if (g_head == "CITY") s.city = argText(0);
        } else keepRaw();
    } else keepRaw();
}

void lineOperation() {
    if (g_head == "TRANSFER_TIME") g_program.transferTime = static_cast<int>(timeSeconds(0));
    else if (g_head == "DWELL_TIME") g_program.dwellTime = static_cast<int>(timeSeconds(0));
    else if (g_head == "OUT_STATION_TRANSFER_TIME") g_program.outStationTransferTime = static_cast<int>(timeSeconds(0));
    else if (g_head == "ENTRY_TIME") g_program.entryTime = static_cast<int>(timeSeconds(0));
    else if (g_head == "AVG_BOARD_TIME") g_program.avgBoardTime = static_cast<int>(timeSeconds(0));
    else keepRaw();
}

void linePrice() {
    if (g_head == "CURRENCY") g_program.currency = argText(0);
    else if (g_head == "DEFAULT_FARE") g_program.defaultFare = argNum(0);
    else if (g_head == "FARE_CAP") g_program.fareCap = argNum(0);
    else if (g_head == "SEGMENT") {
        std::vector<double> n = numberArgs();
        if (n.size() >= 3) g_program.segments.push_back(PriceSegment{n[0], n[1], n[2]});
        else keepRaw();
    } else if (g_head == "LINEAR_EXTENSION") {
        LinearExtension le;
        le.present = true;
        for (std::size_t i = 0; i < g_args.size(); ++i) {
            if (isMark(g_args[i], "THRESHOLD") && i + 1 < g_args.size()) le.threshold = g_args[++i].num;
            else if (isMark(g_args[i], "BASE_FARE") && i + 1 < g_args.size()) le.base = g_args[++i].num;
            else if (isMark(g_args[i], "RATE_PER_KM") && i + 1 < g_args.size()) le.rate = g_args[++i].num;
        }
        g_program.linearExtension = le;
    } else if (g_head == "TRANSFER_DISCOUNT") {
        TransferDiscount d;
        d.present = true;
        for (std::size_t i = 0; i < g_args.size(); ++i) {
            if (isMark(g_args[i], "DISCOUNT_AMOUNT") && i + 1 < g_args.size()) d.amount = g_args[++i].num;
            else if (isMark(g_args[i], "TIME_LIMIT") && i + 1 < g_args.size()) d.timeLimit = static_cast<int>(g_args[++i].num);
            else if (g_args[i].kind == 'i' && argKey(i) == "TRUE") d.enabled = true;
        }
        g_program.transferDiscount = d;
    } else if (g_head == "SPECIAL_LINE") {
        SpecialLineFare f;
        f.lineId = argText(0);
        for (std::size_t i = 1; i < g_args.size(); ++i) {
            if (isMark(g_args[i], "ALL")) f.all = true;
            else if (isMark(g_args[i], "SEGMENT")) {
                std::vector<std::string> ss = stringArgs();
                if (ss.size() >= 2) { f.from = ss[ss.size() - 2]; f.to = ss[ss.size() - 1]; }
            }
        }
        std::vector<double> n = numberArgs();
        if (!n.empty()) f.fare = n.back();
        g_program.specialLines.push_back(f);
    } else keepRaw();
}

void lineTransferType() {
    TransferType &t = g_program.transferTypes.back();
    if (g_head == "TIME") t.time = static_cast<int>(timeSeconds(0));
    else if (g_head == "STATUS") t.status = argText(0);
    else if (g_head == "SECURITY_CHECK") t.securityCheck = true;
    else keepRaw();
}

void lineTransferDefine() {
    Transfer &t = g_program.transfers.back();
    if (g_head == "TIME") { t.time = static_cast<int>(timeSeconds(0)); t.hasTime = true; }
    else if (g_head == "STATUS") t.type = argText(0);
    else if (g_head == "SECURITY_CHECK") { /* 元数据，暂存 raw */ keepRaw(); }
    else keepRaw();
}

void lineLine() {
    Line *l = frameLine();
    if (l == nullptr) { keepRaw(); return; }
    if (g_head == "NAME") l->name = argText(0);
    else if (g_head == "COLOR") l->color = argText(0);
    else if (g_head == "CITY") l->city = argText(0);
    else if (g_head == "FORMATION") { for (auto &v : valueArgs()) l->formations.push_back(v); }
    else if (g_head == "LINK") { for (auto &v : valueArgs()) l->links.push_back(v); }
    else if (g_head == "IMAGE") l->image = argText(0);
    else if (g_head == "MAXSPEED") l->maxspeed = argNum(0);
    else if (g_head == "POWER") l->power = argNum(0);
    else if (g_head == "BRAKE") l->brake = argNum(0);
    else if (g_head == "OPEN_YEAR") l->openYear = static_cast<int>(argNum(0));
    else if (g_head == "DISABLE" || (g_head == "DISABLED" && (g_args.empty() || argKey(0) != "FALSE"))) l->disabled = true;
    else if (g_head == "SPECIAL") l->special = true;
    else if (g_head == "PENDING") { for (auto &s : stringArgs()) l->pending.push_back(s); }
    else if (g_head == "DEPOT" || g_head == "INHERITS") keepRaw();
    else keepRaw();
}

void lineDirection() {
    Direction *d = frameDirection();
    if (d == nullptr) { keepRaw(); return; }
    if (g_head == "STATIONS") {
        for (auto &s : stringArgs()) d->stations.push_back(DirStation{s, 0.0, false, -1.0});
    } else if (g_head == "DISTANCE") {
        if (!g_args.empty() && argKey(0) == "AUTO") {
            for (std::size_t i = 0; i + 1 < d->stations.size(); ++i) {
                const Station *a = g_program.findStation(d->stations[i].name);
                const Station *b = g_program.findStation(d->stations[i + 1].name);
                if (a != nullptr && b != nullptr && a->hasCoord && b->hasCoord) {
                    d->stations[i].next = stationDistanceKm(*a, *b);
                    d->stations[i].hasNext = true;
                }
            }
        } else {
            // 按位置对齐解析：`DISTANCE [d0, d1, ..., NIL]` 里 NIL 是"该站到下一站
            // 距离未知"的占位。列表里的逗号不进 g_args，所以 g_args 就是按站序排的
            // 一串值；跳过 NIL / 其它非数字时要照常前进下标，否则后面的距离会整体错位。
            std::size_t idx = 0;
            for (const Val &v : g_args) {
                if (v.kind == ':' || idx >= d->stations.size()) continue;
                if (v.kind == 'n') {
                    d->stations[idx].next = v.num;
                    d->stations[idx].hasNext = true;
                }
                ++idx;
            }
        }
    } else if (g_head == "DWELL_TIME" || g_head == "DWELL") {
        if (!g_args.empty() && g_args[0].kind == 'n') d->dwellTime = timeSeconds(0);
        else if (!g_args.empty() && g_args[0].kind == 's') { /* 单站停站，暂存 raw */ keepRaw(); }
    } else if (g_head == "LOOP") {
        d->loop = true;
        if (g_args.size() > 0) d->directionType = argKey(0);
    } else if (g_head == "IS_FUTURE" || g_head == "FUTURE") {
        d->isFuture = g_args.empty() || argKey(0) != "FALSE";
    } else if (g_head == "CONNECT_STATION") d->connectStation = argText(0);
    else if (g_head == "EXPRESS_STOPS") { for (auto &s : stringArgs()) d->expressStops.push_back(s); }
    else if (g_head == "VIA") { for (auto &s : stringArgs()) d->viaDirections.push_back(s); }
    else if (g_head == "SEGMENT_TYPE") {
        std::vector<std::string> ss = stringArgs();
        if (ss.size() >= 3) d->segmentTypes.push_back(SegmentType{ss[0], ss[1], upper(ss[2])});
        else keepRaw();
    } else if (g_head == "ROUTING") {
        Routing r;
        for (const Val &v : g_args) {
            if (v.kind == 's') { if (r.name.empty()) r.name = v.text; else r.stations.push_back(v.text); }
        }
        d->routings.push_back(r);
    } else if (g_head == "REV" || g_head == "REVERSE") {
        d->revOf = argText(0);
        if (g_head == "REV") {
            // 立即继承并反转
            if (const Direction *src = const_cast<Program &>(g_program).findDirection(d->revOf)) {
                Direction copy = *src;
                std::reverse(copy.stations.begin(), copy.stations.end());
                // 反转后站点顺序变了，距离要跟着走：第 i 段的距离变成原来第 i+1 段的。
                // hasNext 也必须一起搬，否则"原本是末站"的那一站反转后仍然被当成末站。
                for (std::size_t i = 0; i + 1 < copy.stations.size(); ++i) {
                    copy.stations[i].next = copy.stations[i + 1].next;
                    copy.stations[i].hasNext = copy.stations[i + 1].hasNext;
                }
                if (!copy.stations.empty()) { copy.stations.back().next = 0; copy.stations.back().hasNext = false; }
                d->stations = copy.stations;
                d->loop = copy.loop;
                d->isFuture = copy.isFuture;
                if (d->directionType.empty()) d->directionType = copy.directionType;
            }
        }
    } else keepRaw();
}

/**
 * @brief `FACILITY_DEFINE` 块的一行：把无障碍设施挂到站点上。
 *
 * 行形如 `TOILET '站名' POSITION PAID_AREA [ACCESSIBLE] [GENDER MIXED]`、
 * `ELEVATOR '站名' LOCATION '位置' [ACCESSIBLE]`、`WIDE_GATE '站名' QUANTITY 2`、
 * `ESCALATOR '站名' QUANTITY 4 [DIRECTION both]`、
 * `TACTILE_PAVING '站名' STATUS available`。站名是行里第一个字符串参数；
 * `POSITION` / `LOCATION` / `QUANTITY` / `DIRECTION` / `STATUS` / `GENDER` 是带值的
 * 标记，`ACCESSIBLE` 是无值标记。站点不存在时按站名补一个空站点，保证数据不丢。
 */
void lineFacility() {
    const std::string kind = g_head;
    static const char *const kKinds[] = {"TOILET", "ACCESSIBLE_TOILET", "ELEVATOR",
                                         "WIDE_GATE", "ESCALATOR", "TACTILE_PAVING"};
    bool known = false;
    for (const char *k : kKinds) if (kind == k) { known = true; break; }
    if (!known) { keepRaw(); return; }

    std::string stationName;
    for (const Val &v : g_args)
        if (v.kind == 's') { stationName = v.text; break; }
    if (stationName.empty()) { keepRaw(); return; }

    Station *st = g_program.findStation(stationName);
    if (st == nullptr) {
        Station fresh;
        fresh.name = stationName;
        g_program.stations.push_back(fresh);
        st = g_program.findStation(stationName);
    }
    if (st == nullptr) { keepRaw(); return; }
    StationAccess &a = st->access;
    a.present = true;

    std::string position = "paid_area";
    std::string gender = "mixed";
    std::string location;
    std::string direction = "both";
    std::string status = "available";
    int quantity = 0;
    bool accessible = false;
    for (std::size_t i = 0; i < g_args.size(); ++i) {
        const std::string key = argKey(i);
        const std::size_t next = i + 1;
        if (key == "POSITION") {
            position = (next < g_args.size() && argKey(next) == "UNPAID_AREA") ? "unpaid_area" : "paid_area";
        } else if (key == "LOCATION") {
            if (next < g_args.size()) location = g_args[next].text;
        } else if (key == "QUANTITY") {
            if (next < g_args.size()) quantity = static_cast<int>(g_args[next].num);
        } else if (key == "DIRECTION") {
            if (next < g_args.size()) direction = lower(trimWs(g_args[next].text));
        } else if (key == "STATUS") {
            if (next < g_args.size()) status = lower(trimWs(g_args[next].text));
        } else if (key == "GENDER") {
            if (next < g_args.size()) gender = lower(trimWs(g_args[next].text));
        } else if (key == "ACCESSIBLE") {
            accessible = true;
        }
    }
    if (accessible) a.accessible = true;

    if (kind == "TOILET") {
        a.hasToilet = true;
        a.toilet.position = position;
        a.toilet.gender = gender;
        a.toilet.accessible = accessible;
    } else if (kind == "ACCESSIBLE_TOILET") {
        a.hasAccessibleToilet = true;
        a.accessibleToilet.position = position;
        a.accessibleToilet.gender = gender;
        a.accessibleToilet.accessible = true;
    } else if (kind == "ELEVATOR") {
        ElevatorInfo e;
        e.location = location;
        e.accessible = true;
        a.elevators.push_back(e);
    } else if (kind == "WIDE_GATE") {
        a.hasWideGate = true;
        a.wideGate.quantity = quantity;
    } else if (kind == "ESCALATOR") {
        EscalatorInfo e;
        e.quantity = quantity;
        e.direction = direction;
        a.escalators.push_back(e);
    } else if (kind == "TACTILE_PAVING") {
        a.hasTactilePaving = true;
        a.tactilePaving.status = status;
    }
}

void lineAny() { keepRaw(); }

/**
 * @brief 顶层（不在任何块里）单行命令。
 *
 * 目前只建模 `TRANSFER 类型 '站名' 线路A 线路B`：它和 `TRANSFER_DEFINE` 块描述
 * 同一件换乘，真实样例两种写法都在用，只认块形式会让单行写法整句掉进 raw。
 * 站名既可以带引号（按字符串参数取），也可以裸写（按位置取）。
 */
void lineTopLevel() {
    if (g_head == "TRANSFER") {
        Transfer t;
        t.type = argText(0);
        std::vector<std::string> strs = stringArgs();
        if (strs.size() >= 3) {
            t.station = strs[0];
            t.lineA = strs[1];
            t.lineB = strs[2];
        } else if (g_args.size() >= 4) {
            t.station = g_args[1].text;
            t.lineA = g_args[2].text;
            t.lineB = g_args[3].text;
        }
        if (t.station.empty() || t.lineA.empty() || t.lineB.empty()) { keepRaw(); return; }
        g_program.transfers.push_back(t);
        return;
    }
    keepRaw();
}

/** @brief 按当前块的种类分派一行。 */
void dispatchLine() {
    if (g_stack.empty()) { lineTopLevel(); return; }
    switch (g_stack.back().kind) {
        case MB_PROGRAM: lineProgram(); break;
        case MB_STATION: lineStation(); break;
        case MB_OPERATION: lineOperation(); break;
        case MB_PRICE: linePrice(); break;
        case MB_TRANSFER_TYPE: lineTransferType(); break;
        case MB_TRANSFER_DEFINE: lineTransferDefine(); break;
        case MB_LINE: lineLine(); break;
        case MB_DIRECTION: lineDirection(); break;
        case MB_FACILITY_DEFINE: lineFacility(); break;
        default: lineAny(); break;
    }
}

/** @brief 处理 STATION_MODIFY / LINE_MODIFY / DIRECTION_MODIFY 的动词行。 */
void dispatchModify(int verb, int attr) {
    if (g_stack.empty()) return;
    const std::string v = upper(trimWs(g_pool[verb].text));
    const std::string a = upper(trimWs(g_pool[attr].text));
    // 目标对象来自块头（`LINE_MODIFY G24` 的 G24），不是动词行上的参数。
    const std::string target = g_stack.back().target.empty() ? argText(0) : g_stack.back().target;
    if (g_stack.back().kind == MB_STATION_MODIFY) {
        Station *s = g_program.findStation(target);
        if (s == nullptr) { g_errors.push_back("STATION_MODIFY 找不到站点：" + target); return; }
        if (a == "COORD" && verb >= 0 && v == "SET") {
            std::vector<double> n = numberArgs();
            if (n.size() >= 2) { s->lon = n[0]; s->lat = n[1]; s->hasCoord = true; }
        } else if (a == "CITY" && v == "SET") {
            s->city = argText(0);
        } else if (a == "OTHER_NAME" || a == "OTHER_NAMES") {
            std::vector<std::string> ss;
            for (const Val &val : g_args) if (val.kind == 's') ss.push_back(val.text);
            if (v == "SET" || v == "ADD") for (auto &x : ss) s->otherNames.push_back(x);
            else if (v == "REMOVE") {
                for (auto it = s->otherNames.begin(); it != s->otherNames.end();)
                    it = (std::find(ss.begin(), ss.end(), *it) != ss.end()) ? s->otherNames.erase(it) : it + 1;
            }
        }
    } else if (g_stack.back().kind == MB_LINE_MODIFY) {
        Line *l = g_program.findLine(target);
        if (l == nullptr) { g_errors.push_back("LINE_MODIFY 找不到线路：" + target); return; }
        if (v == "SET") {
            if (a == "NAME") l->name = argText(0);
            else if (a == "COLOR") l->color = argText(0);
            else if (a == "MAXSPEED") l->maxspeed = argNum(0);
            else if (a == "IMAGE") l->image = argText(0);
            else if (a == "OPEN_YEAR") l->openYear = static_cast<int>(argNum(0));
            else if (a == "CITY") l->city = argText(0);
            else if (a == "FORMATION") { l->formations = valueArgs(); }
            else if (a == "LINK") { l->links = valueArgs(); }
        } else if (v == "ADD" && (a == "FORMATION" || a == "LINK")) {
            std::vector<std::string> values = valueArgs();
            std::vector<std::string> &dst = (a == "FORMATION") ? l->formations : l->links;
            for (auto &x : values) dst.push_back(x);
        } else if (a == "SPECIAL") {
            if (v == "ADD") l->special = true;
            else if (v == "REMOVE") l->special = false;
        }
    } else if (g_stack.back().kind == MB_DIRECTION_MODIFY) {
        Direction *d = g_program.findDirection(target);
        if (d == nullptr) { g_errors.push_back("DIRECTION_MODIFY 找不到方向：" + target); return; }
        if (a == "LOOP") {
            if (v == "ADD") d->loop = true;
            else if (v == "REMOVE") d->loop = false;
        } else if (a == "CONNECT_STATION" && v == "SET") d->connectStation = argText(0);
        else if (a == "IS_FUTURE" && v == "SET") d->isFuture = argKey(0) != "FALSE";
        else if (a == "DIRECTION_TYPE" && v == "SET") d->directionType = argKey(1);
        else if (a == "EXPRESS_STOPS" && v == "SET") {
            d->expressStops.clear();
            for (const Val &val : g_args) if (val.kind == 's') d->expressStops.push_back(val.text);
        } else if (a == "ROUTING") {
            Routing r;
            for (std::size_t i = 0; i < g_args.size(); ++i)
                if (g_args[i].kind == 's') { if (r.name.empty()) r.name = g_args[i].text; else r.stations.push_back(g_args[i].text); }
            if (v == "REMOVE") {
                for (auto it = d->routings.begin(); it != d->routings.end();)
                    it = (it->name == r.name) ? d->routings.erase(it) : it + 1;
            } else {
                for (Routing &old : d->routings) if (old.name == r.name) { old = r; return; }
                d->routings.push_back(r);
            }
        }
    }
}

} // namespace

int mb_token_value(int kind, std::string_view text, double value) {
    Lex lx;
    lx.kind = kind;
    // 数字从词素原文重解析：生成器把 Token 数值放进了 int32 通道，
    // 直接用它会把坐标 / 票价的小数部分截掉（121.02 -> 121）。词素是原文，
    // 这里用 strtod 取回完整精度。字符串 / 标识符不带数值。
    if (kind == 1) {
        const std::string raw = trimWs(std::string(text));
        lx.num = raw.empty() ? value : std::strtod(raw.c_str(), nullptr);
    } else {
        lx.num = value;
    }
    lx.text = (kind == 2) ? unescape(std::string(text)) : trimWs(std::string(text));
    g_pool.push_back(std::move(lx));
    return static_cast<int>(g_pool.size()) - 1;
}

void mb_arg(int value) {
    if (value < 0 || value >= static_cast<int>(g_pool.size())) return;
    const Lex &lx = g_pool[value];
    Val v;
    v.text = lx.text;
    v.num = lx.num;
    if (lx.kind == 2) v.kind = 's';
    else if (lx.kind == 1) v.kind = 'n';
    else if (lx.text == ":") v.kind = ':';
    else v.kind = 'i';
    g_args.push_back(std::move(v));
}

void mb_line(int head) {
    if (head < 0 || head >= static_cast<int>(g_pool.size())) return;
    g_headRaw = trimWs(g_pool[head].text);
    g_head = upper(g_headRaw);
    dispatchLine();
    g_args.clear();
}

void mb_begin(BlockKind kind) {
    Frame f;
    f.kind = kind;
    f.head = lineText();
    if (const char *name = blockHeadName(kind); name[0] != '\0') {
        std::string rebuilt = name;
        for (const Val &v : g_args) {
            if (v.kind == ':') rebuilt += ":";
            else if (v.kind == 's') rebuilt += " '" + v.text + "'";
            else rebuilt += " " + v.text;
        }
        f.head = rebuilt;
    }
    const std::string first = argText(0);
    const std::string second = argText(1);
    f.target = first;
    switch (kind) {
        case MB_LINE:
        case MB_LINE_TEMPLATE: {
            Line l;
            l.id = first;
            g_program.lines.push_back(l);
            f.line = static_cast<int>(g_program.lines.size()) - 1;
            break;
        }
        case MB_DIRECTION:
        case MB_DIRECTION_TEMPLATE: {
            Line *parent = frameLine();
            if (parent != nullptr) {
                Direction d;
                d.id = first;
                d.lineId = parent->id;
                parent->directions.push_back(d);
                f.line = g_stack.back().line;
                f.dir = static_cast<int>(parent->directions.size()) - 1;
            }
            break;
        }
        case MB_TRANSFER_TYPE: {
            TransferType t;
            t.id = first;
            t.name = second;
            t.time = static_cast<int>(timeSeconds(2));
            g_program.transferTypes.push_back(t);
            break;
        }
        case MB_TRANSFER_DEFINE: {
            Transfer t;
            t.station = first;
            t.lineA = second;
            t.lineB = argText(2);
            g_program.transfers.push_back(t);
            break;
        }
        default:
            break;
    }
    g_args.clear();
    g_stack.push_back(std::move(f));
}

void mb_end_block() {
    if (g_stack.empty()) return;
    Frame f = std::move(g_stack.back());
    g_stack.pop_back();
    if (isRawBlock(f.kind)) {
        // 整块未建模：块头 + 缩进成员 + END_DEFINE 原样进 raw
        g_program.raw.push_back(RawLine{f.head});
        for (const std::string &line : f.body) g_program.raw.push_back(RawLine{"    " + line});
        g_program.raw.push_back(RawLine{"END_DEFINE"});
        return;
    }
    // 建模块里没认出来的行也原样保留（缩进写法）
    for (const std::string &line : f.body) g_program.raw.push_back(RawLine{"    " + line});
}

void mb_end_policy() {
    if (g_stack.empty() || g_stack.back().kind != MB_POLICY) return;
    Frame f = std::move(g_stack.back());
    g_stack.pop_back();
    for (const std::string &line : f.body) {
        if (g_stack.empty()) g_program.raw.push_back(RawLine{line});
        else g_stack.back().body.push_back(line);
    }
}

void mb_end_attributes() {
    if (g_stack.empty() || g_stack.back().kind != MB_ATTRIBUTES) return;
    Frame f = std::move(g_stack.back());
    g_stack.pop_back();
    if (g_stack.empty()) {
        g_program.raw.push_back(RawLine{"ATTRIBUTES"});
        for (const std::string &line : f.body) g_program.raw.push_back(RawLine{"    " + line});
        g_program.raw.push_back(RawLine{"END_ATTRIBUTES"});
    } else {
        g_stack.back().body.push_back("ATTRIBUTES");
        for (const std::string &line : f.body) g_stack.back().body.push_back("    " + line);
        g_stack.back().body.push_back("END_ATTRIBUTES");
    }
}

void mb_modify(int verb, int attr) {
    dispatchModify(verb, attr);
    g_args.clear();
}

Program &mb_program() { return g_program; }
const std::vector<std::string> &mb_errors() { return g_errors; }

/**
 * @brief 解析入口：MetroLang 源码 -> 模型。
 *
 * 剥 BOM、统一换行，交给生成的分析器驱动语义动作，最后汇总诊断。这是
 * MetroLang 前端唯一的解析流程实现，随 %epilogue 内嵌在 parser.cpp 里。
 */
bool compileText(const std::string &text, Program &out, std::vector<std::string> &errors) {
    g_pool.clear();
    g_program = Program();
    g_errors.clear();
    g_args.clear();
    g_stack.clear();
    g_head.clear();
    g_rawLines.clear();

    std::string source = text;
    if (source.size() >= 3 && static_cast<unsigned char>(source[0]) == 0xEF &&
        static_cast<unsigned char>(source[1]) == 0xBB &&
        static_cast<unsigned char>(source[2]) == 0xBF)
        source.erase(0, 3);

    std::string normalized;
    normalized.reserve(source.size() + 1);
    for (std::size_t i = 0; i < source.size(); ++i) {
        if (source[i] == '\r') {
            if (i + 1 < source.size() && source[i + 1] == '\n') continue;
            normalized.push_back('\n');
        } else {
            normalized.push_back(source[i]);
        }
    }
    if (normalized.empty() || normalized.back() != '\n') normalized.push_back('\n');

    // MetroLang 的一行式方向快捷方式 `DIRECTION_DEFINE 新ID REV 原ID` 不带
    // END_DEFINE，和块形式共享同一个前缀；这里先规范化成等价的块写法：
    //     DIRECTION_DEFINE 新ID
    //       REV 原ID
    //     END_DEFINE
    // 这样文法里不必为它造一条会和块头抢 Token 的产生式。
    {
        std::string rewritten;
        rewritten.reserve(normalized.size() + 32);
        std::size_t pos = 0;
        while (pos < normalized.size()) {
            std::size_t eol = normalized.find('\n', pos);
            if (eol == std::string::npos) eol = normalized.size();
            const std::string line = normalized.substr(pos, eol - pos);
            std::vector<std::string> words;
            {
                std::istringstream ls(line);
                std::string w;
                while (ls >> w) words.push_back(w);
            }
            const bool shortcut = (words.size() == 4 && words[0] == "DIRECTION_DEFINE" &&
                                   words[2] == "REV");
            if (shortcut) {
                const std::size_t firstText = line.find_first_not_of(" \t");
                const std::string indent =
                    (firstText == std::string::npos) ? std::string() : line.substr(0, firstText);
                rewritten += indent + "DIRECTION_DEFINE " + words[1] + "\n";
                rewritten += indent + "  REV " + words[3] + "\n";
                rewritten += indent + "END_DEFINE\n";
            } else {
                rewritten += line;
                rewritten.push_back('\n');
            }
            pos = eol + 1;
        }
        normalized.swap(rewritten);
    }

    Parser::Engine engine;
    Parser::ParserValue_T result = 0;
    if (engine.runText(normalized, &result) != Parser::Status::Ok) {
        for (const Parser::Error &e : engine.errors()) {
            std::ostringstream os;
            os << "第 " << e.line() << " 行：" << e.message();
            // 加上出错那一行的原文，方便在预处理/展开后的文本里定位。
            if (!e.context().empty()) os << "\n          " << e.context();
            errors.push_back(os.str());
        }
        if (errors.empty()) errors.push_back("语法分析失败");
        return false;
    }
    for (const std::string &e : g_errors) errors.push_back(e);
    out = g_program;
    return errors.empty();
}

} // namespace metro
