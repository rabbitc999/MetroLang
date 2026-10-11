/**
 * @file html.cpp
 * @brief 生成自包含的 HTML 地图（Web 墨卡托 + 内联 SVG）。
 */
#include "metro_model.hpp"

#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace metro {
namespace {

/** @brief HTML/XML 文本转义。 */
std::string esc(const std::string &s) {
    std::string o;
    for (char c : s) {
        switch (c) {
            case '&': o += "&amp;"; break;
            case '<': o += "&lt;"; break;
            case '>': o += "&gt;"; break;
            case '"': o += "&quot;"; break;
            default: o += c;
        }
    }
    return o;
}

/**
 * @brief 站点是否带无障碍设施（用于地图上打标）。
 * @param s 站点。
 * @return 有电梯 / 无障碍卫生间 / 宽闸机 / 盲道，或显式标了 ACCESSIBLE 时返回 true。
 */
bool accessibleStation(const Station &s) {
    const StationAccess &a = s.access;
    return a.present &&
           (a.accessible || a.hasAccessibleToilet || !a.elevators.empty() ||
            a.hasWideGate || a.hasTactilePaving || a.hasToilet);
}

/** @brief 数值 -> 属性文本。 */
std::string f(double v) {
    char b[64];
    std::snprintf(b, sizeof(b), "%.2f", v);
    return b;
}

} // namespace

std::string toHtml(const Program &p) {
    double minX = 1, minY = 1, maxX = 0, maxY = 0;
    bool any = false;
    for (const Station &s : p.stations) {
        if (!s.hasCoord) continue;
        XY q = project(s.lon, s.lat);
        if (!q.valid) continue;
        minX = std::fmin(minX, q.x); maxX = std::fmax(maxX, q.x);
        minY = std::fmin(minY, q.y); maxY = std::fmax(maxY, q.y);
        any = true;
    }
    if (!any) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    // 留白按**范围的比例**算。这里不能写死一个常数：坐标是归一化墨卡托（整个地球
    // 是 1×1），一座城市的跨度只有千分之几，加 0.04 相当于往外扩 14 度，整张图会被
    // 压成中间一个小点。
    double spanX = std::fmax(1e-9, maxX - minX);
    double spanY = std::fmax(1e-9, maxY - minY);
    minX -= spanX * 0.04; maxX += spanX * 0.04;
    minY -= spanY * 0.04; maxY += spanY * 0.04;
    spanX = maxX - minX;
    spanY = maxY - minY;
    // 画布给足分辨率：这是矢量图，但嵌进文档/README 时按内联尺寸渲染，
    // 1600×1200 下 354 座车站的站名才算看得清（原来 1000×800 太挤）。
    const double w = 1600.0, h = 1200.0;
    // 等比缩放并居中：经纬度投影出来的形状不该被画布拉伸。
    const double scale = std::fmin(w / spanX, h / spanY);
    const double offX = (w - spanX * scale) / 2.0;
    const double offY = (h - spanY * scale) / 2.0;
    auto px = [&](double lon, double lat, double &x, double &y) {
        XY q = project(lon, lat);
        x = offX + (q.x - minX) * scale;
        y = offY + (q.y - minY) * scale;
    };

    std::ostringstream o;
    o << "<!DOCTYPE html>\n<html lang=\"zh\">\n<head>\n<meta charset=\"utf-8\">\n"
      << "<title>" << esc(p.keyCity) << " 地铁线网</title>\n"
      << "<style>body{margin:0;background:#0f1115;color:#e6e6e6;font-family:system-ui,sans-serif}"
      << "svg{display:block;width:100%;height:auto}.legend{position:fixed;right:12px;top:12px;"
      << "background:#1b1f27cc;border-radius:8px;padding:12px 16px;font-size:16px}"
      << ".legend i{display:inline-block;width:18px;height:5px;margin-right:7px;vertical-align:middle}"
      << "</style>\n</head>\n<body>\n<svg viewBox=\"0 0 " << f(w) << " " << f(h)
      << "\" xmlns=\"http://www.w3.org/2000/svg\""
      << " shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\">\n";

    for (const Line &l : p.lines) {
        for (const Direction &d : l.directions) {
            if (!d.revOf.empty() && d.stations.empty()) continue;
            o << "<polyline fill=\"none\" stroke=\"" << esc(l.color.empty() ? "#888" : l.color)
              << "\" stroke-width=\"7\" stroke-linejoin=\"round\" stroke-linecap=\"round\" points=\"";
            for (const DirStation &s : d.stations) {
                const Station *st = p.findStation(s.name);
                if (st == nullptr || !st->hasCoord) continue;
                double x = 0, y = 0;
                px(st->lon, st->lat, x, y);
                o << f(x) << "," << f(y) << " ";
            }
            o << "\"/>\n";
        }
    }
    // 站名密度控制：几百座车站全标会把图糊成一片，所以大线网只标"换乘站"与
    // 带无障碍设施的站；小线网（<= 150 站）仍然全标。这里出现的线路数按
    // `lines[].direction[].station` 统计，同一线路的多个方向只算一次。
    std::map<std::string, int> stationLineCount;
    for (const Line &l : p.lines) {
        std::set<std::string> seen;
        for (const Direction &d : l.directions)
            for (const DirStation &ds : d.stations) seen.insert(ds.name);
        for (const std::string &name : seen) ++stationLineCount[name];
    }
    const bool dense = p.stations.size() > 150;
    for (const Station &s : p.stations) {
        if (!s.hasCoord) continue;
        double x = 0, y = 0;
        px(s.lon, s.lat, x, y);
        const bool acc = accessibleStation(s);
        const bool interchange = stationLineCount.count(s.name) != 0 && stationLineCount[s.name] >= 2;
        const bool label = !dense || interchange || acc;
        o << "<circle cx=\"" << f(x) << "\" cy=\"" << f(y)
          << "\" r=\"" << (label ? "9" : "7") << "\" fill=\"#fff\" stroke=\""
          << (acc ? "#2e7d32" : "#111") << "\"" << (acc ? " stroke-width=\"4\"" : "") << "/>"
          << "\n";
        if (!label) continue;
        // 字号是"画布单位"：画布宽 1600 映射到阅读宽度时，30 号字约等于 16px，
        // 站名才看得清；改画布尺寸时这两个数要一起看。
        o << "<text x=\"" << f(x + 14) << "\" y=\"" << f(y + 9)
          << "\" font-size=\"" << (interchange ? "30" : "26") << "\""
          << " fill=\"#f2f4f8\" stroke=\"#000\" stroke-width=\"5\" paint-order=\"stroke\">"
          << esc(s.name) << (acc ? " \u267f" : "") << "</text>\n";
    }
    o << "</svg>\n<div class=\"legend\"><b>" << esc(p.keyCity) << "</b><br/>"
      << "<div><i style=\"background:#2e7d32\"></i>\u267f 无障碍设施</div>";
    for (const Line &l : p.lines)
        o << "<div><i style=\"background:" << esc(l.color.empty() ? "#888" : l.color) << "\"></i>"
          << esc(l.name.empty() ? l.id : l.name) << "</div>";
    o << "</div>\n</body>\n</html>\n";
    return o.str();
}

} // namespace metro
