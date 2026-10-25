#!/usr/bin/env python3
"""
把 `game/` 下的运行时资源**内嵌成 C++ 源**，供 `metro-lang game` 产出单文件页面。

与 `tools/embed_mapcore.py`、`tools/embed_templates.py` 同一个套路：构建期生成
`metro_game_assets.hpp`，运行时不读磁盘，游戏页才能是一个可以直接双击打开、
也可以随手发出去的 `.html`。

内嵌的资源按体积分两组，**默认只带精简组**：

  --full 不给（默认，精简组）
      k_gameSim     game/js/sim.js          模拟内核（纯函数、不碰 DOM，Node 里也跑）
      k_gameUi      game/js/ui.js           页面渲染层
      k_gameStyle   game/css/style.css      样式
      k_gameD3      game/js/d3.min.js       绘图库（离线副本）

  --full （完整组，排在最后）
      k_gameDefaultData  game/data/guangzhou.json  兜底数据集

**顺序是契约**：`main()` 按 `wanted` 的顺序把 `sources` 逐个对上，错一个
常量就装错内容，页面会莫名报「缺少模块」。加资源时两边一起改。

为什么兜底数据集默认不内嵌：`metro-lang game <file.metro>` 的数据集是**从输入的
`.metro` 现算**的（见 `src/game_data.cpp`），一份都不需要；只有 `metro-lang game`
不带输入文件、想直接看样例时才用得上。为它让每个 exe 多背 45 KB 不划算。

用法：
  python tools/embed_game.py --out build/metro-lang/gen/metro_game_assets.hpp \\
      game/js/sim.js game/js/ui.js game/css/style.css game/js/d3.min.js
  python tools/embed_game.py --full --out ... game/data/guangzhou.json

文件里出现 `)METROGAME` 会让原生字符串提前结束——这里直接报错，不静默截断。
"""

import argparse
import pathlib
import sys

DELIM = "METROGAME"

# 精简组：常量名 ←→ 用途 ←→ 在输入列表里的位置。
BASE = [
    ("k_gameSim", "模拟内核（game/js/sim.js：区间耗时 / 列车状态机 / 客流 / 评分）"),
    ("k_gameUi", "页面渲染层（game/js/ui.js：线网绘制 / 列车动画 / 控制面板）"),
    ("k_gameStyle", "样式（game/css/style.css）"),
    ("k_gameD3", "绘图库（game/js/d3.min.js，离线副本）"),
]

# 完整组额外多一个：没指定输入文件时的样例数据集。
FULL_EXTRA = [
    ("k_gameDefaultData", "兜底数据集（game/data/*.json，`metro-lang game` 未带输入时使用）"),
]


def embed(path: pathlib.Path) -> str:
    """读一个资源，包成 `R"METROGAME(...)METROGAME"` 原生字符串。"""
    text = path.read_text(encoding="utf-8")
    if f"){DELIM}\"" in text:
        raise SystemExit(f"{path} 里出现了 ){DELIM}，会截断原生字符串，换定界符再试")
    return f'R"{DELIM}({text}){DELIM}"'


def main() -> int:
    parser = argparse.ArgumentParser(description="把游戏运行时资源内嵌成 C++ 头文件")
    parser.add_argument("--out", required=True, help="输出头文件路径")
    parser.add_argument("--full", action="store_true", help="额外的兜底数据集也一并内嵌")
    parser.add_argument("sources", nargs="+",
                        help="要内嵌的资源（顺序固定：见模块文档；BASE [、数据集]）")
    args = parser.parse_args()

    wanted = BASE + (FULL_EXTRA if args.full else [])
    if len(args.sources) != len(wanted):
        names = "、".join(name for name, _ in wanted)
        print(f"需要 {len(wanted)} 个输入：{names}", file=sys.stderr)
        return 2

    paths = [pathlib.Path(p) for p in args.sources]
    for path in paths:
        if not path.is_file():
            print(f"找不到 {path}", file=sys.stderr)
            return 2

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    parts = [
        "/**\n"
        " * @file metro_game_assets.hpp\n"
        " * @brief 由 tools/embed_game.py 生成的游戏资源固化头（请勿手改）。\n"
        " *\n"
        " * 把 game/ 下的 JS / CSS（以及可选的兜底数据集）以原始字符串内嵌，\n"
        " * 运行时不读磁盘，`metro-lang game` 才能产出单文件页面。改完 game/js 下的\n"
        " * 脚本要让改动生效必须重新构建——Makefile 已把这些文件列为本头的依赖。\n"
        " */\n"
        "#pragma once\n\n"
        "namespace metro {\n\n"
    ]
    total = 0
    for (name, purpose), path in zip(wanted, paths):
        parts.append(f"/** @brief {purpose}。 */\n")
        parts.append(f"inline constexpr const char *{name} = {embed(path)};\n\n")
        total += path.stat().st_size
    parts.append("} // namespace metro\n")

    out.write_text("".join(parts), encoding="utf-8")
    print(f"已生成 {out}（{len(paths)} 个资源，{total} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
