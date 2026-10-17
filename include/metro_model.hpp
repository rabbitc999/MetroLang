/**
 * @file metro_model.hpp
 * @brief MetroLang 的数据模型与工具链公开接口。
 *
 * 这是编译器、反编译器、JSON 序列化、HTML 地图与线路查询共用的领域模型：
 * 线路 / 方向 / 站点 / 换乘 / 票价 / 运营参数。未建模的命令原样保存在
 * `Program::raw` 里，保证往返不丢内容。
 */
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace metro {

/** @brief 站点在线路上的引用（站台状态）。 */
struct StationLineRef {
    std::string id;      ///< 线路 ID。
    std::string start;   ///< 该线路在本站的起始方向首站。
    std::string end;     ///< 末站。
    std::string status;  ///< operating / pending / out_station。
};

/** @brief 卫生间信息（普通 / 无障碍共用）。 */
struct ToiletInfo {
    std::string position = "paid_area"; ///< paid_area（付费区内）/ unpaid_area（付费区外）。
    bool accessible = false;            ///< 是否带无障碍隔间。
    std::string gender = "mixed";       ///< mixed / male / female。
};

/** @brief 无障碍电梯。 */
struct ElevatorInfo {
    std::string location;      ///< 位置描述，如 `A口出口旁`。
    bool accessible = true;    ///< 是否可供轮椅使用。
};

/** @brief 宽闸机（无障碍闸机）。 */
struct WideGateInfo {
    int quantity = 0;          ///< 数量。
};

/** @brief 自动扶梯。 */
struct EscalatorInfo {
    int quantity = 0;          ///< 数量。
    std::string direction = "both"; ///< up / down / both。
};

/** @brief 盲道（触觉铺装）。 */
struct TactilePavingInfo {
    std::string status = "available"; ///< available / partial / none。
};

/**
 * @brief 一个站点的无障碍设施，直接挂在 `Station` 上。
 *
 * 这是 JSON v2 相对旧格式的关键改动：旧格式把设施放在根级 `facilities`
 * 字典里、再用站名回指；v2 把设施内联进站点对象，站点相关数据只在一处，
 * 地图 / 查询工具不必再做第二次查表。
 */
struct StationAccess {
    bool present = false;                 ///< 是否出现过任何无障碍信息。
    bool hasToilet = false;               ///< 是否描述了普通卫生间。
    ToiletInfo toilet;                    ///< 普通卫生间。
    bool hasAccessibleToilet = false;     ///< 是否描述了无障碍卫生间。
    ToiletInfo accessibleToilet;          ///< 无障碍卫生间。
    std::vector<ElevatorInfo> elevators;  ///< 电梯列表。
    std::vector<EscalatorInfo> escalators;///< 自动扶梯列表。
    bool hasWideGate = false;             ///< 是否描述了宽闸机。
    WideGateInfo wideGate;                ///< 宽闸机。
    bool hasTactilePaving = false;        ///< 是否描述了盲道。
    TactilePavingInfo tactilePaving;      ///< 盲道。
    bool accessible = false;              ///< 是否明确标了 `ACCESSIBLE`（整站可达）。
};

/** @brief 一个车站。 */
struct Station {
    std::string name;                 ///< 站名（JSON 的键）。
    std::string city;                 ///< 所属城市。
    double lon = 0.0;                 ///< 经度。
    double lat = 0.0;                 ///< 纬度。
    bool hasCoord = false;            ///< 是否定义了坐标。
    std::vector<std::string> otherNames; ///< 多语言别名。
    std::vector<StationLineRef> lines;   ///< 经过的线路。
    StationAccess access;             ///< 无障碍设施（JSON v2 内联在站点里）。
    bool used = false;                ///< 是否被任何方向的 STATIONS 引用。
};

/** @brief 方向里的一站（站名 + 到下一站的距离 / 停站时间）。 */
struct DirStation {
    std::string name;      ///< 站名。
    double next = 0.0;     ///< 到下一站的距离（km），末站为 0。
    bool hasNext = false;  ///< 是否显式给了距离。
    double dwell = -1.0;   ///< 停站时间（秒），未设置 < 0。
};

/** @brief 路段敷设方式（高架 / 地下 / 地面）。 */
struct SegmentType {
    std::string from;   ///< 起点站。
    std::string to;     ///< 终点站。
    std::string type;   ///< elevated / underground / ground。
};

/** @brief 交路方案。 */
struct Routing {
    std::string name;                 ///< 交路名称。
    std::vector<std::string> stations; ///< 交路经过的站点。
};

/** @brief 一个运行方向。 */
struct Direction {
    std::string id;                ///< 方向 ID。
    std::string lineId;            ///< 所属线路 ID。
    std::vector<DirStation> stations; ///< 站序。
    bool loop = false;             ///< 是否环线。
    bool isFuture = false;         ///< 是否规划中。
    std::string directionType;     ///< inner / outer（仅环线）。
    std::string connectStation;    ///< CONNECT_STATION。
    std::vector<std::string> expressStops;  ///< 快车停靠站。
    std::vector<std::string> viaDirections; ///< 共线经过的方向。
    std::vector<SegmentType> segmentTypes;  ///< 路段类型。
    std::vector<Routing> routings; ///< 交路。
    std::string revOf;             ///< REV 引用的方向 ID（反向简写）。
    double dwellTime = -1.0;       ///< 方向级默认停站时间（秒）。
};

/** @brief 一条线路。 */
struct Line {
    std::string id;                  ///< 线路 ID。
    std::string name;                ///< 线路名称。
    std::string color;               ///< 颜色 `#RRGGBB`。
    std::string city;                ///< 城市。
    std::vector<std::string> formations; ///< 编组（可多条，如 `6B`、`4A/6A`）。
    std::vector<std::string> links;      ///< 百科链接（可多条）。
    std::string image;               ///< 示意图路径。
    double maxspeed = 0.0;           ///< 最高速度 km/h。
    double power = 0.0;              ///< 牵引功率 kW。
    double brake = 0.0;              ///< 制动减速度 m/s²。
    int openYear = 0;                ///< 开通年份。
    bool disabled = false;           ///< 是否停运。
    bool special = false;            ///< 是否特殊线路。
    std::vector<std::string> pending; ///< 暂缓开通站点。
    std::vector<Direction> directions; ///< 方向。
};

/** @brief 换乘类型。 */
struct TransferType {
    std::string id;             ///< 类型 ID。
    std::string name;           ///< 显示名称。
    int time = 0;               ///< 换乘耗时（秒）。
    std::string status;         ///< operating / pending / out_station。
    bool securityCheck = false; ///< 是否需要安检。
};

/** @brief 一条换乘规则。 */
struct Transfer {
    std::string type;      ///< 换乘类型 ID。
    std::string station;   ///< 换乘站。
    std::string lineA;     ///< 线路 A。
    std::string lineB;     ///< 线路 B。
    int time = 0;          ///< 换乘耗时（秒）；0 表示未显式设置。
    bool hasTime = false;  ///< 是否显式设置了 TIME。
};

/** @brief 运营时间。 */
struct OpenTime {
    std::string id;      ///< 线路 ID 或 GLOBAL。
    std::string from;    ///< 起。
    std::string to;      ///< 止。
    std::string days;    ///< 星期修饰符原文。
};

/** @brief 阶梯票价的区段。 */
struct PriceSegment { double lo = 0, hi = 0, fare = 0; };

/** @brief 线性延伸票价参数。 */
struct LinearExtension { bool present = false; double threshold = 0, base = 0, rate = 0; };

/** @brief 换乘优惠。 */
struct TransferDiscount { bool enabled = false; bool present = false; double amount = 0; int timeLimit = 0; };

/** @brief 特殊线路票价。 */
struct SpecialLineFare {
    std::string lineId;      ///< 线路 ID。
    bool all = false;        ///< `ALL 票价`：整条线路一口价。
    double fare = 0.0;       ///< 票价（`ALL` 时是统一价）。
    std::string from;        ///< `SEGMENT` 写法的起点站。
    std::string to;          ///< `SEGMENT` 写法的终点站。
    bool hasDefaultFare = false;   ///< 是否给了独立起步价。
    double defaultFare = 0.0;      ///< 独立起步价。
    std::vector<PriceSegment> segments; ///< 独立区间表。
};

/** @brief 一周里的星期几（与 `PERIOD` 的星期修饰符对应）。 */
struct DaySet {
    bool any = false;                ///< 未指定星期（= 每天）。
    std::vector<std::string> days;   ///< 小写三字母星期：mon/tue/wed/thu/fri/sat/sun。
    /** @brief 判断某个星期（小写三字母）是否命中。 @param d 星期。 @return 命中返回 true。 */
    bool matches(const std::string &d) const;
};

/**
 * @brief `HEADWAY_PROFILE` 的一条时段：某时间段内的发车间隔。
 *
 * 对应 `PERIOD HH:mm HH:mm 秒数 [星期修饰符]`；命中规则是**第一条**匹配的时段，
 * 与 metro_editor 的 `SimTimeCalculator.FindHeadway` 同口径。
 */
struct HeadwayPeriod {
    std::string start;  ///< 起始时刻 `HH:mm`。
    std::string end;    ///< 结束时刻 `HH:mm`（不含）。
    int seconds = 0;    ///< 发车间隔（秒）。
    DaySet days;        ///< 适用星期。
};

/** @brief 一条 `HEADWAY_PROFILE 线路ID`：某条线路的分时段发车间隔。 */
struct HeadwayProfile {
    std::string lineId;                  ///< 线路 ID。
    std::vector<HeadwayPeriod> periods;  ///< 时段表。
};

/** @brief `CROWD_PROFILE` 的一条时段：某时间段内的拥挤度系数。 */
struct CrowdPeriod {
    std::string start;  ///< 起始时刻 `HH:mm`。
    std::string end;    ///< 结束时刻 `HH:mm`（不含）。
    double factor = 1.0;///< 拥挤度系数（≥ 1.0，平均需等待的列车趟数）。
    DaySet days;        ///< 适用星期。
};

/** @brief 一条 `CROWD_PROFILE 方向ID`：某个方向的拥挤度。 */
struct CrowdProfile {
    std::string dirId;                 ///< 方向 ID。
    std::vector<CrowdPeriod> periods;  ///< 时段表。
};

/** @brief `DWELL_TIME_DEFINE` 的一条：站点 / 方向 / 线路级的停站时间。 */
struct DwellRule {
    enum Kind { Node, Direction, Line } kind = Node; ///< 生效范围。
    std::string station;   ///< kind == Node 时的站名。
    std::string dirId;     ///< kind == Direction 时的方向 ID。
    std::string lineId;    ///< kind == Line 时的线路 ID。
    double seconds = 0.0;  ///< 停站时间（秒）。
};

/** @brief `SPEED_LIMIT_DEFINE` 的一条区间限速。 */
struct SpeedLimitRule {
    std::string dirId;     ///< 方向 ID。
    std::string from;      ///< 起点站。
    std::string to;        ///< 终点站。
    double kmh = 0.0;      ///< 限速（km/h）。
};

/** @brief 一条未建模但原样保留的语句。 */
struct RawLine { std::string text; };

/** @brief MetroLang 程序模型。 */
struct Program {
    std::string keyCity;                       ///< 主城市（必填）。
    std::vector<std::string> otherCities;      ///< 其它城市。
    std::string version = "V1.0";              ///< 版本号。
    std::string author = "匿名";               ///< 作者。
    std::string createDate;                    ///< 创建日期。
    std::string updateDate;                    ///< 更新日期。

    int transferTime = 180;                    ///< 站内换乘时间（秒）。
    int outStationTransferTime = 300;          ///< 出站换乘时间（秒）。
    int dwellTime = 30;                        ///< 默认停站时间（秒）。
    int entryTime = 120;                       ///< 进站时间（秒）。
    int avgBoardTime = 3;                      ///< 平均上车时间（秒）。

    std::string currency = "CNY";              ///< 票价货币。
    double defaultFare = 0.0;                  ///< 起步价。
    double fareCap = 0.0;                      ///< 封顶价，0 表示无封顶。
    std::vector<PriceSegment> segments;        ///< 阶梯票价。
    LinearExtension linearExtension;           ///< 线性延伸。
    TransferDiscount transferDiscount;         ///< 换乘优惠。
    std::vector<SpecialLineFare> specialLines; ///< 特殊线路票价。

    std::vector<Station> stations;             ///< 站点。
    std::vector<Line> lines;                   ///< 线路。
    std::vector<TransferType> transferTypes;   ///< 换乘类型。
    std::vector<Transfer> transfers;           ///< 换乘规则。
    std::vector<OpenTime> openTimes;           ///< 运营时间。

    std::vector<HeadwayProfile> headways;      ///< 分时段发车间隔（HEADWAY_PROFILE）。
    std::vector<CrowdProfile> crowds;          ///< 分时段拥挤度（CROWD_PROFILE）。
    std::vector<DwellRule> dwellRules;         ///< 停站时间覆盖（DWELL_TIME_DEFINE）。
    std::vector<SpeedLimitRule> speedLimits;   ///< 区间限速（SPEED_LIMIT_DEFINE）。

    std::vector<RawLine> raw;                  ///< 未建模语句，原样保留。

    /** @brief 按站名查站点（可写）。 @param name 站名。 @return 指针；没有返回 nullptr。 */
    Station *findStation(const std::string &name);
    /** @brief 按站名查站点（只读）。 @param name 站名。 @return 指针；没有返回 nullptr。 */
    const Station *findStation(const std::string &name) const;
    /** @brief 按线路 ID 查线路（可写）。 @param id 线路 ID。 @return 指针；没有返回 nullptr。 */
    Line *findLine(const std::string &id);
    /** @brief 按线路 ID 查线路（只读）。 @param id 线路 ID。 @return 指针；没有返回 nullptr。 */
    const Line *findLine(const std::string &id) const;
    /** @brief 按方向 ID 查方向（可写）。 @param id 方向 ID。 @return 指针；没有返回 nullptr。 */
    Direction *findDirection(const std::string &id);
    /** @brief 按类型 ID 查换乘类型（可写）。 @param id 类型 ID。 @return 指针；没有返回 nullptr。 */
    TransferType *findTransferType(const std::string &id);
};

/**
 * @brief 两站之间的球面距离（km），按 WGS-84 坐标用 haversine 算。
 *
 * `DISTANCE AUTO` 与反编译时判断「几何距离是否等于显式距离」都用它，
 * 保证自动计算只有一份实现。
 *
 * @param a 起点站（需要 `hasCoord`）。
 * @param b 终点站（需要 `hasCoord`）。
 * @return 距离（km）；任一站缺坐标返回 0。
 */
double stationDistanceKm(const Station &a, const Station &b);

/** @brief 编译入口。 */
struct CompileResult {
    bool ok = false;                     ///< 是否成功。
    Program program;                     ///< 编译结果。
    std::vector<std::string> errors;     ///< 诊断。
    std::vector<std::string> dependencies; ///< %INCLUDE 依赖。
};

/**
 * @brief 编译 MetroLang 源码（已经过 library/preprocess 预处理）。
 * @param text 源码。
 * @param out 输出模型。
 * @param errors 输出诊断。
 * @return 成功返回 true。
 */
bool compileText(const std::string &text, Program &out, std::vector<std::string> &errors);

/**
 * @brief 把 `%IMPORT` 的 CSV 站表转成等价的 STATION_DEFINE 块。
 *
 * 供语言服务器等需要复刻 compileFile 的 CSV 装载行为的调用方使用。
 *
 * @param csvText CSV 全文（首行表头：站名/经度/纬度/城市）。
 * @return `STATION_DEFINE … END_DEFINE` 块文本。
 */
std::string csvToStationBlock(const std::string &csvText);

/**
 * @brief 编译 MetroLang 文件（先走 library/preprocess 的 % 指令与 %IMPORT）。
 * @param path 文件路径。
 * @param out 输出模型。
 * @param errors 输出诊断。
 * @param deps 可选输出：%INCLUDE 依赖表。
 * @return 成功返回 true。
 */
bool compileFile(const std::string &path, Program &out, std::vector<std::string> &errors,
                 std::vector<std::string> *deps = nullptr);

/**
 * @brief 反编译：模型 -> MetroLang 源码（模板化生成）。
 * @param program 程序模型。
 * @return MetroLang 源码文本。
 */
std::string decompile(const Program &program);

/**
 * @brief 序列化为 JSON（对齐 metro_editor 的 route_data.json 口径）。
 * @param program 程序模型。
 * @return JSON 文本。
 */
std::string toJson(const Program &program);

/**
 * @brief 从 JSON 解析模型。
 * @param json JSON 文本。
 * @param out 输出模型。
 * @param errors 输出诊断。
 * @return 成功返回 true。
 */
bool fromJson(const std::string &json, Program &out, std::vector<std::string> &errors);

/**
 * @brief 生成自包含的 HTML 地图（内嵌 SVG）。
 * @param program 程序模型。
 * @return HTML 文本。
 */
std::string toHtml(const Program &program);

/** @brief 线路查询选项。 */
struct RouteOptions {
    double transferPenalty = 0.0;    ///< 每次换乘额外惩罚（秒）。
    bool preferFewerTransfers = false; ///< 优先少换乘。

    /**
     * @brief 出行时间点（unix 秒，**本地时刻**的解释见下）。
     *
     * 发车间隔与拥挤度都按时段查表，所以查询时必须有一个"几点出发"。
     * 传 0 表示用当前时间；只用到 `HH:mm` 与星期，不看时区。
     */
    std::int64_t timestamp = 0;
    bool excludeSpecial = false;     ///< 不乘坐特殊线路（机场线 / 磁悬浮等）。
};

/** @brief 行程里的一个乘车区段：同一方向连续乘坐的部分。 */
struct RouteSegment {
    std::string lineId;            ///< 线路 ID。
    std::string lineName;          ///< 线路显示名（跨城市时带城市前缀）。
    std::string color;             ///< 线路颜色 `#RRGGBB`。
    std::string dirId;             ///< 方向 ID。
    std::string towards;           ///< "开往 ……" 的终点，环线是 `xx（内环）`。
    std::string from;              ///< 上车站。
    std::string to;                ///< 下车站。
    int stations = 0;              ///< 乘坐站数（= 站数 - 1）。
    double distanceKm = 0.0;       ///< 本段里程（km）。
    double runSeconds = 0.0;       ///< 纯区间运行时间（含中间站停站）。
    bool outStationTransfer = false; ///< 该段起点是否出站换乘。
    std::vector<std::string> stationNames; ///< 本段经过的站（含首末）。
};

/** @brief 一次行程的完整结果。 */
struct RouteResult {
    bool found = false;            ///< 是否找到路径。
    std::string error;             ///< 失败原因。
    std::string from;              ///< 起点站。
    std::string to;                ///< 终点站。

    std::vector<RouteSegment> segments; ///< 乘车区段。
    std::vector<std::string> stations;  ///< 按顺序经过的站（含换乘站重复出现）。

    double distanceKm = 0.0;       ///< 总里程。
    int transfers = 0;             ///< 换乘次数。
    int stops = 0;                 ///< 总乘坐站数。

    double runSeconds = 0.0;       ///< 区间运行 + 中间站停站。
    double transferWalkSeconds = 0.0; ///< 换乘步行时间合计。
    double waitSeconds = 0.0;      ///< 候车等待合计（含起点首班车）。
    double entrySeconds = 0.0;     ///< 进出站时间（两端，2 × ENTRY_TIME）。
    double totalSeconds = 0.0;     ///< 总耗时。

    double fare = 0.0;             ///< 票价（元）。
    double specialFare = 0.0;      ///< 其中特殊线路的部分。
    std::string fareNote;          ///< 票价说明（为什么是这个价）。
    std::string clock;             ///< 查询时刻 `HH:mm`（发车间隔/拥挤度按它取）。

    /** @brief 可读的乘车指引（"在【A】上车，先乘坐开往……"）。 @return 文本。 */
    std::string guidance() const;
};

/**
 * @brief 规划两站之间的行程（时间最短，口径对齐 metro_editor 的 SimTimeCalculator）。
 *
 * 边代价 = 区间运行时间（物理模型）+ 停站 + 换乘步行 + 候车 `T/2 + t + (C-1)T`。
 * A* 的启发式取两站球面距离 / 全网最高速度，与边同量纲。
 *
 * @param program 编译好的模型。
 * @param from 起点站名（会先做一次宽松匹配）。
 * @param to 终点站名。
 * @param options 选项。
 * @return 行程结果；`found == false` 时 `error` 有原因。
 */
RouteResult planRoute(const Program &program, const std::string &from, const std::string &to,
                      const RouteOptions &options);

/**
 * @brief 行程的 JSON（`route --json`；VS Code 插件与查看器共用）。
 * @param r 行程结果。
 * @return JSON 文本。
 */
std::string toJson(const RouteResult &r);

/**
 * @brief 站名宽松匹配：精确 → 忽略大小写 → 前缀 → 包含。
 * @param program 模型。
 * @param input 用户输入。
 * @return 匹配到的站名；没有返回空串。
 */
std::string matchStationName(const Program &program, const std::string &input);

/**
 * @brief 规划**只按时间**最小的行程（和 planRoute 同一套边代价，入口更直接）。
 *
 * `planRoute` 已经做了票价与分段汇总，这里是它的内核版本，供通勤矩阵等
 * 只关心秒数的调用方使用。
 *
 * @param program 模型。
 * @param from 起点站名。
 * @param to 终点站名。
 * @param options 选项。
 * @param outSeconds 输出总耗时（秒）。
 * @return 找到路径返回 true。
 */
bool shortestSeconds(const Program &program, const std::string &from, const std::string &to,
                     const RouteOptions &options, double &outSeconds);

/**
 * @brief 计算票价（口径对齐 metro_editor 的 SimFareCalculator）。
 *
 * 普通区段按总里程结算（阶梯区间 + 线性延伸 + DEFAULT_FARE），特殊线路
 * （`SPECIAL_LINE`）单独计价：`ALL 票价` 或自己的区间表。
 *
 * @param program 模型。
 * @param segments 行程区段（按顺序）。
 * @param outSpecial 输出其中特殊线路的票价部分。
 * @param outNote 输出一句话说明。
 * @return 总票价（元）。
 */
double computeFare(const Program &program, const std::vector<RouteSegment> &segments,
                   double &outSpecial, std::string &outNote);

/**
 * @brief 区间运行时间估算：metro_editor `SimTrainTimeUtils.ComputeSegmentTime` 的移植。
 *
 * 短区间（≤ 1.5 km）走物理模型精确积分，长区间走 `S/v_max + ΔT`（ΔT 由 10 km
 * 参考区间精确积分标定）。数值与 C# 版逐位一致。
 *
 * @param distanceKm 区间长度（km）。
 * @param consist 编组（如 `6B`、`4/8A`）。
 * @param vMaxKmh 最高速度（km/h）。
 * @param powerKw 牵引功率（kW）。
 * @param brakeDecel 制动减速度（m/s²）；<= 0 用 0.85。
 * @return 运行时间（秒）；距离 <= 0 返回 0。
 */
double segmentRunTimeExact(double distanceKm, const std::string &consist,
                           double vMaxKmh, double powerKw, double brakeDecel);

/**
 * @brief 某线路在某时刻的发车间隔（秒）。
 * @param program 模型。
 * @param lineId 线路 ID。
 * @param timestamp unix 秒；0 表示当前时间。
 * @return 间隔（秒）；没有配置返回 120。
 */
int headwayAt(const Program &program, const std::string &lineId, std::int64_t timestamp);

/**
 * @brief 某方向在某时刻的拥挤度系数。
 * @param program 模型。
 * @param dirId 方向 ID。
 * @param timestamp unix 秒；0 表示当前时间。
 * @return 系数（≥ 1）；没有配置返回 1。
 */
double crowdAt(const Program &program, const std::string &dirId, std::int64_t timestamp);

/**
 * @brief 在换乘站等下一趟车的平均时间：`T/2 + t + (C-1)T`。
 * @param program 模型。
 * @param dirId 目标方向。
 * @param timestamp unix 秒；0 表示当前时间。
 * @return 秒数。
 */
double waitSeconds(const Program &program, const std::string &dirId, std::int64_t timestamp);

/**
 * @brief 按方向 ID 找它所属的线路 ID。
 * @param program 模型。
 * @param dirId 方向 ID。
 * @return 线路 ID；找不到时原样返回 dirId。
 */
std::string lineIdOfDir(const Program &program, const std::string &dirId);

/**
 * @brief GCJ-02 → WGS-84 坐标转换（国内高德 / 腾讯坐标 → GPS）。
 *
 * 用的是国内通用的偏移反算（克拉索夫斯基椭球 + 双精度迭代一次），境外坐标原样返回。
 *
 * @param lon 经度（GCJ-02）。
 * @param lat 纬度（GCJ-02）。
 * @param outLon 输出经度（WGS-84）。
 * @param outLat 输出纬度（WGS-84）。
 */
void gcj02ToWgs84(double lon, double lat, double &outLon, double &outLat);

/**
 * @brief WGS-84 → GCJ-02 坐标转换（GPS → 高德 / 腾讯）。
 * @param lon 经度（WGS-84）。
 * @param lat 纬度（WGS-84）。
 * @param outLon 输出经度（GCJ-02）。
 * @param outLat 输出纬度（GCJ-02）。
 */
void wgs84ToGcj02(double lon, double lat, double &outLon, double &outLat);

/** @brief 一个站点的坐标校正建议。 */
struct CoordFix {
    std::string name;        ///< 站名。
    bool hasOld = false;     ///< 原坐标是否可用。
    double oldLon = 0.0;     ///< 原经度。
    double oldLat = 0.0;     ///< 原纬度。
    double newLon = 0.0;     ///< 校正后经度（WGS-84）。
    double newLat = 0.0;     ///< 校正后纬度（WGS-84）。
    double shiftMeters = 0.0;///< 位移（米）。
    bool suspicious = false; ///< 位移过大或缺失坐标，建议人工确认。
    std::string reason;      ///< 为什么被标记。
};

/**
 * @brief 坐标校正：把模型里所有站点的坐标按"来源坐标系"换到 WGS-84。
 *
 * 支持的场景：
 *   - `gcj`：数据是从高德 / 腾讯导出的 GCJ-02 坐标，反算成 WGS-84；
 *   - `wgs`：数据本来就是 GPS 坐标，只做检查（缺失 / 重复 / 明显越界）；
 *   - `auto`：先按城区中心判断这批坐标更像哪一套（GCJ-02 偏移量在 200–700 m 量级，
 *     城市内聚类可以分辨），再决定是否转换。
 *
 * 无论哪种模式，都会把"没有坐标 / 两站重合 / 超出城市范围"的站点标成 `suspicious`。
 *
 * @param program 模型（不改原数据）。
 * @param from 坐标系："gcj" / "wgs" / "auto"。
 * @return 每个有坐标或需要关心的站点一条结果（按站名排序）。
 */
std::vector<CoordFix> correctCoordinates(const Program &program, const std::string &from);

/** @brief 经纬度投影结果（Web 墨卡托归一化 0..1）。 */
struct XY { double x = 0, y = 0; bool valid = false; };

/**
 * @brief 把经纬度投影到 Web 墨卡托归一化坐标。
 * @param lon 经度。
 * @param lat 纬度。
 * @return 投影结果。
 */
XY project(double lon, double lat);

/**
 * @brief 区间运行时间估算（《列车运行时间计算》简化线性模型，单位秒）。
 * @param km 区间长度（km）。
 * @param maxspeed 最高速度（km/h），<=0 时用缺省 80。
 * @return 秒数。
 */
double segmentRunTimeSeconds(double km, double maxspeed);

} // namespace metro
