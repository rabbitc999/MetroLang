/**
 * @file game_html.cpp
 * @brief 把游戏数据集 + 内嵌资源拼成**单文件**游戏页面。
 *
 * 与 `html.cpp`（静态地图）分工一致：
 *   - 数据由 C++ 算（`toGameData`），页面永远和输入的 `.metro` 一致；
 *   - 逻辑、样式、绘图库在构建期由 `tools/embed_game.py` 固化进
 *     `metro_game_assets.hpp`，运行时不读磁盘，也不走 CDN。
 *
 * 页面骨架只有一个 `<div id="app">` 和三段 `<script>`：数据集（`application/json`）、
 * 模拟内核、渲染层。渲染层启动时读 `<script id="game-data">`，所以同一个 HTML
 * 换掉那段 JSON 就是另一个城市的游戏。
 */
#include "game_data.hpp"

// 由 tools/embed_game.py 在构建期生成：
// k_gameSim / k_gameUi / k_gameStyle / k_gameD3
#include "metro_game_assets.hpp"

#include <sstream>
#include <string>

namespace metro {
namespace {

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

} // namespace

std::string toGameHtml(const Program &p, const std::string &title) {
    const std::string data = escJsonForHtml(toGameData(p));
    const std::string heading = title.empty() ? p.keyCity + " 地铁调度" : title;

    std::ostringstream o;
    o << "<!DOCTYPE html>\n<html lang=\"zh\">\n<head>\n<meta charset=\"utf-8\">\n"
      << "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
      << "<title>" << esc(heading) << "</title>\n"
      << "<style>\n" << k_gameStyle << "\n</style>\n"
      << "</head>\n<body>\n"
      // 渲染层只认这一个挂载点；没脚本时浏览器里留一句提示，别给一片白。
      << "<div id=\"app\"><noscript>这个页面需要 JavaScript。</noscript></div>\n"
      << "<script id=\"game-data\" type=\"application/json\">" << data << "</script>\n"
      << "<script>\n" << k_gameD3 << "\n</script>\n"
      << "<script>\n" << k_gameSim << "\n</script>\n"
      << "<script>\n" << k_gameUi << "\n</script>\n"
      << "</body>\n</html>\n";
    return o.str();
}

} // namespace metro
