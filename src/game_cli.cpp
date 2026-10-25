/**
 * @file game_cli.cpp
 * @brief `metro-lang game` 子命令：导出游戏数据集（`--json`）或单文件游戏页。
 *
 * 单独一个翻译单元，是为了让 `--json` 那条路不把 d3（340 KB）链进来：
 * `game_data.cpp` 只依赖模型，`game_html.cpp` 才需要 `metro_game_assets.hpp`。
 */
#include "game_data.hpp"

#include <cstdio>
#include <string>

namespace metro {

GameOutput writeGame(const Program &p, bool jsonOnly, const std::string &out, const std::string &title) {
    const std::string text = jsonOnly ? toGameData(p) : toGameHtml(p, title);
    if (out.empty()) {
        std::fwrite(text.data(), 1, text.size(), stdout);
        return GameOutput::Stdout;
    }
    if (FILE *f = std::fopen(out.c_str(), "wb")) {
        const std::size_t n = std::fwrite(text.data(), 1, text.size(), f);
        std::fclose(f);
        return n == text.size() ? GameOutput::File : GameOutput::Failed;
    }
    return GameOutput::Failed;
}

} // namespace metro
