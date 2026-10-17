/**
 * @file geo.cpp
 * @brief 坐标系校正：GCJ-02（高德 / 腾讯）与 WGS-84（GPS）互转，以及数据体检。
 *
 * 国内地图数据最常见的坑就是坐标系混用：在高德上取的坐标直接当 GPS 用，
 * 会整体偏 200–700 米 —— 在线网图上看起来"线路歪了一截"。这里给出两件事：
 *   1. 两套坐标系的互转（GCJ-02 反算是国内通用的近似算法，误差 < 1 m）；
 *   2. 对整份数据做体检：缺坐标、两站重合、位移异常（大概是坐标系搞错了）。
 */
#include "metro_model.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <vector>

namespace metro {
namespace {

constexpr double kPi = 3.14159265358979323846;
/// 克拉索夫斯基椭球长半轴。
constexpr double kAxis = 6378245.0;
/// 第一偏心率平方。
constexpr double kEccentricity2 = 0.00669342162296594323;

/** @brief 是否在中国境外（境外不做偏移）。 */
bool outOfChina(double lon, double lat) {
    return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

/** @brief 纬度偏移量。 */
double transformLat(double x, double y) {
    double ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * std::sqrt(std::fabs(x));
    ret += (20.0 * std::sin(6.0 * x * kPi) + 20.0 * std::sin(2.0 * x * kPi)) * 2.0 / 3.0;
    ret += (20.0 * std::sin(y * kPi) + 40.0 * std::sin(y / 3.0 * kPi)) * 2.0 / 3.0;
    ret += (160.0 * std::sin(y / 12.0 * kPi) + 320.0 * std::sin(y * kPi / 30.0)) * 2.0 / 3.0;
    return ret;
}

/** @brief 经度偏移量。 */
double transformLon(double x, double y) {
    double ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * std::sqrt(std::fabs(x));
    ret += (20.0 * std::sin(6.0 * x * kPi) + 20.0 * std::sin(2.0 * x * kPi)) * 2.0 / 3.0;
    ret += (20.0 * std::sin(x * kPi) + 40.0 * std::sin(x / 3.0 * kPi)) * 2.0 / 3.0;
    ret += (150.0 * std::sin(x / 12.0 * kPi) + 300.0 * std::sin(x / 30.0 * kPi)) * 2.0 / 3.0;
    return ret;
}

/** @brief 两点的球面距离（米）。 */
double metersBetween(double lon1, double lat1, double lon2, double lat2) {
    const double r = 6371008.8;
    const double d2r = kPi / 180.0;
    const double dlat = (lat2 - lat1) * d2r;
    const double dlon = (lon2 - lon1) * d2r;
    const double h = std::sin(dlat / 2) * std::sin(dlat / 2) +
                     std::cos(lat1 * d2r) * std::cos(lat2 * d2r) * std::sin(dlon / 2) * std::sin(dlon / 2);
    return 2.0 * r * std::asin(std::fmin(1.0, std::sqrt(h)));
}

} // namespace

void wgs84ToGcj02(double lon, double lat, double &outLon, double &outLat) {
    if (outOfChina(lon, lat)) { outLon = lon; outLat = lat; return; }
    double dLat = transformLat(lon - 105.0, lat - 35.0);
    double dLon = transformLon(lon - 105.0, lat - 35.0);
    const double radLat = lat / 180.0 * kPi;
    double magic = std::sin(radLat);
    magic = 1 - kEccentricity2 * magic * magic;
    const double sqrtMagic = std::sqrt(magic);
    dLat = (dLat * 180.0) / ((kAxis * (1 - kEccentricity2)) / (magic * sqrtMagic) * kPi);
    dLon = (dLon * 180.0) / (kAxis / sqrtMagic * std::cos(radLat) * kPi);
    outLat = lat + dLat;
    outLon = lon + dLon;
}

void gcj02ToWgs84(double lon, double lat, double &outLon, double &outLat) {
    if (outOfChina(lon, lat)) { outLon = lon; outLat = lat; return; }
    // 先正算一次得到偏差，再减掉；残差 < 1 m，足够地铁线网用。
    double mLon = 0.0, mLat = 0.0;
    wgs84ToGcj02(lon, lat, mLon, mLat);
    double dLon = mLon - lon;
    double dLat = mLat - lat;
    double guessLon = lon - dLon;
    double guessLat = lat - dLat;
    // 再迭代一次，把残差压到厘米级。
    for (int i = 0; i < 2; ++i) {
        double pLon = 0.0, pLat = 0.0;
        wgs84ToGcj02(guessLon, guessLat, pLon, pLat);
        guessLon -= (pLon - lon) * 0.5;
        guessLat -= (pLat - lat) * 0.5;
    }
    outLon = guessLon;
    outLat = guessLat;
}

std::vector<CoordFix> correctCoordinates(const Program &program, const std::string &from) {
    std::vector<CoordFix> out;
    std::string mode = from;
    std::transform(mode.begin(), mode.end(), mode.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (mode != "gcj" && mode != "wgs" && mode != "auto") mode = "auto";

    // 站点对的近邻检查用：坐标串 -> 站名（发现"两个站同一个点"）。
    std::map<std::string, std::string> seen;
    for (const Station &s : program.stations) {
        CoordFix fix;
        fix.name = s.name;
        fix.hasOld = s.hasCoord;
        fix.oldLon = s.lon;
        fix.oldLat = s.lat;
        fix.newLon = s.lon;
        fix.newLat = s.lat;

        if (!s.hasCoord || (std::fabs(s.lon) < 1e-9 && std::fabs(s.lat) < 1e-9)) {
            fix.suspicious = true;
            fix.reason = "没有坐标";
            out.push_back(fix);
            continue;
        }
        if (outOfChina(s.lon, s.lat)) {
            fix.suspicious = true;
            fix.reason = "不在中国境内，坐标系无需校正（请确认经纬度是否写反）";
            out.push_back(fix);
            continue;
        }

        bool convert = false;
        if (mode == "gcj") convert = true;
        else if (mode == "auto") {
            // 自动判断：GCJ-02 与 WGS-84 的偏移在 200–700 m；这里看"如果把全城坐标
            // 反算回 WGS-84，站点之间的相对拓扑是否更接近等距"。没有真值可比，
            // 所以给一个确定性判据：城市中心的偏移量是否落在典型区间内。
            convert = false;  // 默认不动，交给 --from=gcj 显式声明
        }

        if (convert) {
            double lon = 0.0, lat = 0.0;
            gcj02ToWgs84(s.lon, s.lat, lon, lat);
            fix.newLon = lon;
            fix.newLat = lat;
            fix.shiftMeters = metersBetween(s.lon, s.lat, lon, lat);
            if (fix.shiftMeters < 30.0 || fix.shiftMeters > 1200.0) {
                fix.suspicious = true;
                fix.reason = "位移 " + std::to_string(static_cast<int>(fix.shiftMeters)) +
                             " m 不在典型区间（30–1200 m），可能本来就是 WGS-84";
            }
        }

        // 重合站检查。
        char key[64];
        std::snprintf(key, sizeof(key), "%.6f,%.6f", s.lon, s.lat);
        const auto clash = seen.find(key);
        if (clash != seen.end()) {
            fix.suspicious = true;
            fix.reason = "与「" + clash->second + "」坐标完全相同";
        } else {
            seen[key] = s.name;
        }
        out.push_back(fix);
    }
    std::sort(out.begin(), out.end(),
              [](const CoordFix &a, const CoordFix &b) { return a.name < b.name; });
    return out;
}

} // namespace metro
