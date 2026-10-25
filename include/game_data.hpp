/**
 * @file game_data.hpp
 * @brief 游戏数据集（`format: "metro-game-1"`）与游戏页面的生成入口。
 */
#ifndef METRO_GAME_DATA_HPP
#define METRO_GAME_DATA_HPP

#include "metro_model.hpp"

#include <string>

namespace metro {

/** @brief 数据集的规模摘要，供命令行提示用（不必序列化整份 JSON）。 */
struct GameStats {
    int lines = 0;             ///< 线路数（含纯规划线）。
    int stationsOperating = 0; ///< 玩家能上下车的站数。
    int futureSegments = 0;    ///< 规划段数（双向各算一段）。
};

/**
 * @brief 算规模摘要，口径与 `toGameData()` 的 `stats` 完全一致。
 *
 * 命令行提示用它而不是 `program.lines.size()` / `program.stations.size()`：
 * 模型里含只在规划段出现的站、也含被 `disabled` 的线路，直接报模型数字会
 * 与数据集里的 `stats` 对不上，看起来像漏了东西。
 *
 * @param p 已编译的程序模型。
 * @return 摘要。
 */
GameStats gameStats(const Program &p);

/**
 * @brief 把程序模型压成游戏数据集（JSON 文本）。
 *
 * 与 `game/tools/prepare_data.py` 同口径：线路拼成「主链 + 支线」、区间里程双向登记、
 * 停站时间与分时段发车间隔秒数化。字段说明见 `doc/06-game.md`。
 *
 * **规划段（`FUTURE`）单独隔离**：不进 `main` / `branches`，落到 `lines[].future`，
 * 由前端画成虚线、不参与调度。整条线都在规划中时（如只有 `FUTURE` 方向的 24 号线）
 * 线路仍然保留并标 `planned_only: true`，避免线路从数据集里无声消失。
 *
 * 源数据缺失的区间里程（`next` 为空）用同线其余区间的中位数补齐，并记进
 * `lines[].km_filled`——不当 0 处理，否则列车会以 0 秒瞬移。
 *
 * @param p 已编译的程序模型。
 * @return 游戏数据集 JSON（`format` 恒为 `metro-game-1`）。
 */
std::string toGameData(const Program &p);

/**
 * @brief 生成自包含的游戏页面（单文件 HTML）。
 *
 * 数据集由 `toGameData(p)` 算出并内联，页面**不读磁盘**：脚本、样式、d3 都在
 * 构建期由 `tools/embed_game.py` 固化进 `metro_game_assets.hpp`。
 *
 * @param p 已编译的程序模型。
 * @param title 页面标题；空则用「<主城市> 地铁调度」。
 * @return 完整 HTML 文本。
 */
std::string toGameHtml(const Program &p, const std::string &title = std::string());

/** @brief `writeGame` 的结果。 */
enum class GameOutput {
    Stdout, ///< 已输出
    File,   ///< 已写文件
    Failed, ///< 文件写不了
};

/**
 * @brief `metro-lang game` 的落地动作：算数据集 / 拼页面，再写到文件或标准输出。
 *
 * @param p 已编译的程序模型。
 * @param jsonOnly 为 true 时只导出数据集（供外部工具消费），否则输出单文件游戏页。
 * @param out 输出路径；空则写标准输出。
 * @param title 页面标题（仅 jsonOnly 为 false 时用）。
 * @return 写入结果。
 */
GameOutput writeGame(const Program &p, bool jsonOnly, const std::string &out,
                     const std::string &title = std::string());

} // namespace metro

#endif // METRO_GAME_DATA_HPP
