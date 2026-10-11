#!/usr/bin/env python3
"""把 MetroLang 线路样例渲染成**独立可用**的 SVG 文件。

用法：
    python3 tools/export_svg.py --bin build/metro-lang/metro-lang \
        --sample samples/shenzhen.m --out doc/shenzhen-metro.svg --title 深圳地铁线网

`metro-lang html` 产出的是一个自包含网页：内联 SVG 靠页面 CSS 提供深色底，
站名（`<text>`）默认全部画在图上。本工具把那段 `<svg>` 抠出来，补上宽高、
`<title>` 和一块深色背景矩形，得到一个可以单独放进 README / 文档的图。

默认**不打印站名**：几百座车站的站名在小图上会糊成一片，README 里的线路图
只需要"线网形状 + 换乘/无障碍标记"。要带站名加 `--labels`。

清晰度：SVG 是矢量图，这里通过 `width`/`height`（默认 1600×1200 乘 `--scale`）
给出一个足够大的内联尺寸，浏览到印刷都够用；`--scale` 只放大外框，`viewBox`
不变，所以放大不会改变构图、只会让文字/线条更锐利。
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

BACKGROUND = "#0f1115"

# `<text …>站名</text>`：站名里可能出现空白与 `♿`，不含 `<`，因此用非贪婪匹配。
TEXT_RE = re.compile(r"<text\b[^>]*>.*?</text>\s*", re.S)


def extract_svg(html: str) -> str:
    """从 `html` 里取出第一段完整 `<svg>…</svg>`。"""
    m = re.search(r"<svg\b.*?</svg>", html, re.S)
    if not m:
        raise SystemExit("找不到 <svg>：请确认 metro-lang html 的输出格式")
    return m.group(0)


def strip_labels(svg: str) -> str:
    """删掉所有站名文本节点，只留线网与站点圆圈。"""
    return TEXT_RE.sub("", svg)


def standalone(svg: str, width: int, height: int, title: str) -> str:
    """补宽高、标题与深色背景，让 SVG 脱离原网页也能看。"""
    svg = svg.replace("<svg ", f'<svg width="{width}" height="{height}" ', 1)
    head_end = svg.find(">")
    inject = f"<title>{title}</title><desc>由 metro-lang 从 MetroLang 线路数据渲染</desc>"
    inject += f'<rect x="0" y="0" width="100%" height="100%" fill="{BACKGROUND}"/>'
    svg = svg[: head_end + 1] + inject + svg[head_end + 1 :]
    return svg + "\n"


def main() -> int:
    """命令行入口：渲染 HTML → 抽 SVG（可选去站名）→ 写 --out。"""
    ap = argparse.ArgumentParser(description="导出 MetroLang 线路图的独立 SVG")
    ap.add_argument("--bin", required=True, help="metro-lang 可执行文件")
    ap.add_argument("--sample", required=True, help="MetroLang 线路文件（.m / .metro）")
    ap.add_argument("--out", required=True, help="输出 SVG 路径")
    ap.add_argument("--title", default="地铁线网", help="SVG 标题（<title> 与图内说明）")
    ap.add_argument("--width", type=int, default=1600, help="画布宽（默认 1600）")
    ap.add_argument("--height", type=int, default=1200, help="画布高（默认 1200）")
    ap.add_argument("--scale", type=float, default=2.0,
                    help="只放大 width/height（viewBox 不变），用于放大查看 / 印刷，默认 2")
    ap.add_argument("--labels", action="store_true",
                    help="保留站名文本（默认不打印站名，只画线网与站点）")
    ap.add_argument("--no-labels", dest="labels", action="store_false",
                    help="不打印站名（默认行为，显式写出便于脚本自述）")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        html_path = os.path.join(tmp, "map.html")
        subprocess.run([args.bin, "html", args.sample, "-o", html_path], check=True)
        with open(html_path, encoding="utf-8") as fh:
            html = fh.read()

    width = int(round(args.width * args.scale))
    height = int(round(args.height * args.scale))
    svg = extract_svg(html)
    labels = svg.count("<text")
    if not args.labels:
        svg = strip_labels(svg)
    svg = standalone(svg, width, height, args.title)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"已写出 {args.out}（{len(svg)} 字节，{svg.count('<polyline')} 条折线，"
          f"{svg.count('<circle')} 座车站，{width}×{height}，"
          f"站名 {'保留 ' + str(labels) + ' 个' if args.labels else '已去除'}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
