/**
 * @file html.cpp
 * @brief 生成自包含的 HTML 地图：模型 JSON + 内嵌的绘图内核（`map_view/js/metro_mapcore.js`）。
 *
 * 分工：
 *   - **几何与配色**（合并方向、平滑曲线、等比投影、图例排序）全在
 *     `metro_mapcore.js` 里，浏览器与 C++ 共用同一份文件，不会两边打架；
 *   - C++ 只负责把模型序列化成 JSON（复用 `toJson`）、转义、拼页面骨架。
 *
 * 页面本身不依赖 D3：`metro_mapcore.buildModel/computeLayout/planRoute`
 * 给出纯数据，`renderStatic()` 把它拼成内联 SVG —— 单文件、离线可看。
 */
#include "metro_model.hpp"

// 由 tools/embed_mapcore.py 在构建期生成：k_metroMapCore（绘图内核）与
// k_staticRenderer（静态渲染层）。与 metro_templates.hpp 同一个套路——
// 运行时不读磁盘，保证 `metro-lang html` 产出单文件。
#include "metro_mapcore.hpp"

#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace metro {
namespace {

/** @brief 站点是否带无障碍设施（地图上打标用）。 */
bool accessibleStation(const Station &s) {
    const StationAccess &a = s.access;
    return a.present &&
           (a.accessible || a.hasAccessibleToilet || !a.elevators.empty() ||
            a.hasWideGate || a.hasTactilePaving || a.hasToilet);
}

/** @brief 数值 -> 文本（两位小数，够画图用）。 */
std::string num(double v) {
    char b[64];
    std::snprintf(b, sizeof(b), "%.2f", v);
    return b;
}

/** @brief 把 JSON 放进 `<script type="application/json">` 时要做的最小转义。 */
std::string escJsonForHtml(const std::string &json) {
    std::string o;
    o.reserve(json.size() + 16);
    for (char c : json) {
        if (c == '<') o += "\\u003c";
        else if (c == '>') o += "\\u003e";
        else if (c == '&') o += "\\u0026";
        else o += c;
    }
    return o;
}

/** @brief HTML 文本转义。 */
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
 * @brief 把无障碍站名清单塞进模型 JSON 的旁边。
 *
 * 无障碍是 `metro-lang` 自己的语义（地铁编辑器那边没有对应字段），
 * 直接作为独立数组给渲染层，避免污染 JSON v2 的字段口径。
 */
std::string accessibilityJson(const Program &p) {
    std::string o = "[";
    bool first = true;
    for (const Station &s : p.stations) {
        if (!accessibleStation(s)) continue;
        o += first ? "\"" : ",\"";
        first = false;
        o += s.name;
        o += "\"";
    }
    return o + "]";
}

} // namespace

std::string toHtml(const Program &p) {
    const std::string model = escJsonForHtml(toJson(p));

    std::ostringstream o; // 拼 HTML，用流最省事
    o << "<!DOCTYPE html>\n<html lang=\"zh\">\n<head>\n<meta charset=\"utf-8\">\n"
      << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
      << "<title>" << esc(p.keyCity) << " 地铁线网</title>\n"
      << "<style>\n"
      << ":root{color-scheme:dark}\n"
      << "html,body{margin:0;height:100%;background:#0f1115;color:#e6e6e6;"
         "font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif}\n"
      << "#map{width:100vw;height:100vh}\n"
      << "#map svg{display:block;width:100%;height:100%}\n"
      << "#legend{position:fixed;right:14px;top:14px;max-height:70vh;overflow:auto;"
         "background:#1b1f27e6;border-radius:10px;padding:10px 14px;font-size:14px;"
         "box-shadow:0 4px 18px #0008}\n"
      << "#legend h2{margin:0 0 8px;font-size:15px;font-weight:600}\n"
      << "#legend .row{display:flex;align-items:center;gap:8px;padding:2px 0}\n"
      << "#legend i{width:18px;height:5px;border-radius:3px;flex:none}\n"
      << "#legend .acc{color:#8fd694}\n"
      << "</style>\n</head>\n<body>\n"
      << "<div id=\"map\"></div>\n<div id=\"legend\"></div>\n"
      << "<script id=\"metro-model\" type=\"application/json\">" << model << "</script>\n"
      << "<script id=\"metro-accessibility\" type=\"application/json\">"
      << escJsonForHtml(accessibilityJson(p)) << "</script>\n"
      << "<script>\n" << k_metroMapCore << "\n</script>\n"
      << "<script>\n" << k_staticRenderer << "\n</script>\n"
      << "</body>\n</html>\n";
    return o.str();
}

} // namespace metro
