/**
 * @file metro_model.hpp
 * @brief MetroLang 的数据模型与工具链公开接口。
 *
 * 这是编译器、反编译器、JSON 序列化、HTML 地图与线路查询共用的领域模型：
 * 线路 / 方向 / 站点 / 换乘 / 票价 / 运营参数。未建模的命令原样保存在
 * `Program::raw` 里，保证往返不丢内容。
 */
#pragma once

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
struct SpecialLineFare { std::string lineId; bool all = false; double fare = 0; std::string from, to; };

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

    std::vector<RawLine> raw;                  ///< 未建模语句，原样保留。

    /** @brief 按站名查站点（可写）。 @param name 站名。 @return 指针；没有返回 nullptr。 */
    Station *findStation(const std::string &name);
    /** @brief 按站名查站点（只读）。 @param name 站名。 @return 指针；没有返回 nullptr。 */
    const Station *findStation(const std::string &name) const;
    /** @brief 按线路 ID 查线路（可写）。 @param id 线路 ID。 @return 指针；没有返回 nullptr。 */
    Line *findLine(const std::string &id);
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
};

/**
 * @brief 查询最短时间路径。
 * @param program 程序模型。
 * @param from 起点站。
 * @param to 终点站。
 * @param options 选项。
 * @param error 输出错误。
 * @return 可读路径文本；失败返回空串并写 error。
 */
std::string queryRoute(const Program &program, const std::string &from, const std::string &to,
                       const RouteOptions &options, std::string &error);

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
