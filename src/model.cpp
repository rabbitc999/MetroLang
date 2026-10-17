/**
 * @file model.cpp
 * @brief 数据模型的查找辅助与几何 / 时间估算。
 */
#include "metro_model.hpp"

#include <cmath>

namespace metro {

Station *Program::findStation(const std::string &name) {
    for (Station &s : stations)
        if (s.name == name) return &s;
    return nullptr;
}

const Station *Program::findStation(const std::string &name) const {
    for (const Station &s : stations)
        if (s.name == name) return &s;
    return nullptr;
}

Line *Program::findLine(const std::string &id) {
    for (Line &l : lines)
        if (l.id == id) return &l;
    return nullptr;
}

const Line *Program::findLine(const std::string &id) const {
    for (const Line &l : lines)
        if (l.id == id) return &l;
    return nullptr;
}

Direction *Program::findDirection(const std::string &id) {
    for (Line &l : lines)
        for (Direction &d : l.directions)
            if (d.id == id) return &d;
    return nullptr;
}

TransferType *Program::findTransferType(const std::string &id) {
    for (TransferType &t : transferTypes)
        if (t.id == id) return &t;
    return nullptr;
}

double stationDistanceKm(const Station &a, const Station &b) {
    if (!a.hasCoord || !b.hasCoord) return 0.0;
    const double r = 6371.0088;
    const double d2r = 3.14159265358979323846 / 180.0;
    const double dlon = (b.lon - a.lon) * d2r;
    const double dlat = (b.lat - a.lat) * d2r;
    const double h = std::sin(dlat / 2) * std::sin(dlat / 2) +
                     std::cos(a.lat * d2r) * std::cos(b.lat * d2r) *
                         std::sin(dlon / 2) * std::sin(dlon / 2);
    return 2 * r * std::asin(std::fmin(1.0, std::sqrt(h)));
}

XY project(double lon, double lat) {
    XY out;
    if (lat < -85.0 || lat > 85.0) return out;
    const double pi = 3.14159265358979323846;
    out.x = (lon + 180.0) / 360.0;
    const double rad = lat * pi / 180.0;
    out.y = 0.5 - std::log(std::tan(pi / 4.0 + rad / 2.0)) / (2.0 * pi);
    out.valid = true;
    return out;
}

double segmentRunTimeSeconds(double km, double maxspeed) {
    // 《列车运行时间计算》6.3 简化线性模型：T = S / v_max + ΔT。
    // ΔT 取 v_max/2 * (1/a_acc + 1/a_brake)，a_acc = 1.0、a_brake = 0.85 m/s²，
    // 与文档默认参数同量级，用于通勤估算（偏保守）。
    if (km <= 0.0) return 0.0;
    const double vkmh = (maxspeed > 1.0) ? maxspeed : 80.0;
    const double v = vkmh / 3.6;               // m/s
    const double s = km * 1000.0;              // m
    const double aAcc = 1.0, aBrake = 0.85;
    const double dt = v * 0.5 * (1.0 / aAcc + 1.0 / aBrake);
    return s / v + dt;
}

} // namespace metro
