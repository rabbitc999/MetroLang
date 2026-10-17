#!/usr/bin/env python3
"""
把 map_view 的绘图内核与静态渲染层**内嵌成 C++ 源**。

与 `tools/embed_templates.py` 同一个套路：构建期生成 `metro_mapcore.hpp`，
运行时不读磁盘，`metro-lang html` 才能产出**单文件**页面。

生成两个常量：

  k_metroMapCore      map_view/js/metro_mapcore.js       绘图内核（几何 / 配色 / 图例）
  k_staticRenderer    template/static/metro_static_render.js  静态渲染层（拼 SVG）

为什么把内核放进 map_view/：它同时被浏览器查看器和 C++ 用，放在 `template/`
会让人误以为只有反编译用；放 `map_view/js/` 与 `app.js` 并列，改起来最直观。

用法：
  python tools/embed_mapcore.py --out build/metro-lang/gen/metro_mapcore.hpp \
      map_view/js/metro_mapcore.js template/static/metro_static_render.js

文件里出现 `)METROMAP` 会让原生字符串提前结束——这里直接报错，不静默截断。
"""

import argparse
import pathlib
import sys

DELIM = "METROMAP"


def embed(path: pathlib.Path) -> str:
    """读一个脚本，包成 `R"METROMAP(...)METROMAP"` 原生字符串。"""
    text = path.read_text(encoding="utf-8")
    if f"){DELIM}\"" in text:
        raise SystemExit(f"{path} 里出现了 ){DELIM}，会截断原生字符串，换定界符再试")
    return f'R"{DELIM}({text}){DELIM}"'


def main() -> int:
    parser = argparse.ArgumentParser(description="把 JS 渲染层内嵌成 C++ 头文件")
    parser.add_argument("--out", required=True, help="输出头文件路径")
    parser.add_argument("sources", nargs="+", help="要内嵌的 JS 文件（按顺序）")
    args = parser.parse_args()

    if len(args.sources) != 2:
        print("需要两个输入：绘图内核 + 静态渲染层", file=sys.stderr)
        return 2

    core_path = pathlib.Path(args.sources[0])
    render_path = pathlib.Path(args.sources[1])
    for path in (core_path, render_path):
        if not path.is_file():
            print(f"找不到 {path}", file=sys.stderr)
            return 2

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "/**\n"
        " * @file metro_mapcore.hpp\n"
        " * @brief 由 tools/embed_mapcore.py 生成的绘图层固化头（请勿手改）。\n"
        " *\n"
        " * 把 map_view/js/metro_mapcore.js（几何 / 配色 / 图例）与\n"
        " * template/static/metro_static_render.js（拼 SVG）以原始字符串内嵌，\n"
        " * 运行时不依赖磁盘脚本，`metro-lang html` 才能产出单文件页面。\n"
        " */\n"
        "#pragma once\n\n"
        "namespace metro {\n\n"
        "/** @brief 地图绘图内核（map_view/js/metro_mapcore.js 的内嵌副本）。 */\n"
        f"inline constexpr const char *k_metroMapCore = {embed(core_path)};\n\n"
        "/** @brief 静态渲染层（template/static/metro_static_render.js 的内嵌副本）。 */\n"
        f"inline constexpr const char *k_staticRenderer = {embed(render_path)};\n\n"
        "} // namespace metro\n",
        encoding="utf-8",
    )
    print(f"已生成 {out}（{core_path.stat().st_size} + {render_path.stat().st_size} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
