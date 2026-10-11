#!/usr/bin/env python3
"""生成 `map_view/preview.svg`：跑一遍查看器，把画出来的图裁成贴边的矢量图。

管线分三步，每步都用的现成工具：

1. `node tools/render_preview.js`（jsdom）把 `index.html` + `app.js` + `loader.js`
   跑一遍，抠出 d3 生成的那段 `<svg>`——这一步不需要浏览器；
2. cairosvg 把它栅格化（默认 2 倍超采样），再用 ImageMagick 的 `-format %@`
   量出"非背景像素"的包围盒——这样就顺带把站名字宽也算进去了，比在 JS 里
   猜文本宽度靠谱；
3. 把包围盒（除以超采样倍数、加边距）写成 SVG 的 `viewBox`，宽高按倍数放大。
   `viewBox` 之外的内容不显示，于是空边被裁掉，而图**仍然是矢量**，放大不掉清晰度。

用法：
    python3 tools/make_preview.py 数据.json [输出.svg] [--size 1600x1000] [--scale 2]

例（在 map_view/ 下）：
    ../build/metro-lang/metro-lang compile ../samples/shenzhen.m -o /tmp/sz.json
    python3 tools/make_preview.py /tmp/sz.json

依赖：`node` + `npm i jsdom`、Python 的 `cairosvg`、`convert`（ImageMagick）。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # map_view/
BACKGROUND = "#f5f5f5"


def run(cmd) -> str:
    """跑一条命令，失败直接抛错（把 stderr 带出来）。"""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit(f"命令失败：{' '.join(cmd)}")
    return proc.stdout


def content_bbox(png: str, fuzz: str):
    """用 ImageMagick 量出非背景像素的包围盒，返回 (x, y, w, h)。"""
    out = run(["convert", png, "-fuzz", fuzz, "-format", "%@", "info:"]).strip()
    m = re.match(r"(\d+)x(\d+)\+(\d+)\+(\d+)$", out)
    if not m:
        raise SystemExit(f"看不懂 trim 结果：{out!r}")
    w, h, x, y = (int(g) for g in m.groups())
    return x, y, w, h


def main() -> int:
    ap = argparse.ArgumentParser(description="把查看器的渲染结果导成贴边的独立 SVG")
    ap.add_argument("data", help="metro-lang / 编辑器 JSON 数据文件")
    ap.add_argument("out", nargs="?", default=os.path.join(ROOT, "preview.svg"),
                    help="输出 SVG（默认 map_view/preview.svg）")
    ap.add_argument("--size", default="1600x1000", help="画布尺寸，即查看器窗口，默认 1600x1000")
    ap.add_argument("--scale", type=float, default=2.0, help="viewBox 之外的放大倍数，默认 2")
    ap.add_argument("--pad", type=float, default=24.0, help="裁边后留的边距（画布单位），默认 24")
    ap.add_argument("--fuzz", default="2%", help="判定背景色的容差，默认 2%")
    args = ap.parse_args()

    width, height = (int(v) for v in args.size.lower().split("x"))
    if shutil.which("node") is None:
        raise SystemExit("找不到 node：这一步要用 jsdom 跑查看器页面")

    with tempfile.TemporaryDirectory() as tmp:
        raw_svg = os.path.join(tmp, "raw.svg")
        raw_png = os.path.join(tmp, "raw.png")
        run(["node", os.path.join(HERE, "render_preview.js"),
             os.path.join(ROOT, "index.html"), os.path.abspath(args.data), raw_svg,
             str(width), str(height)])
        import cairosvg
        cairosvg.svg2png(url=raw_svg, write_to=raw_png,
                         output_width=int(width * args.scale),
                         output_height=int(height * args.scale))
        x, y, w, h = content_bbox(raw_png, args.fuzz)
        with open(raw_svg, encoding="utf-8") as fh:
            svg = fh.read()

    # 像素 -> 画布单位，再留边距
    x = max(0.0, x / args.scale - args.pad)
    y = max(0.0, y / args.scale - args.pad)
    w = min(width - x, w / args.scale + 2 * args.pad)
    h = min(height - y, h / args.scale + 2 * args.pad)

    # 换掉 <svg> 的开头：给出 viewBox，并按倍数放大 width/height（仍是矢量）
    svg = re.sub(r'<svg width="[^"]*" height="[^"]*"',
                 '<svg width="%.0f" height="%.0f" viewBox="%.2f %.2f %.2f %.2f"'
                 % (w * args.scale, h * args.scale, x, y, w, h), svg, count=1)
    # 背景矩形要盖住新的 viewBox
    svg = re.sub(r'<rect x="0" y="0" width="%d" height="%d" fill="%s"/>' % (width, height, BACKGROUND),
                 '<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill="%s"/>'
                 % (x, y, w, h, BACKGROUND), svg, count=1)

    # 坐标保留两位小数：d3 平滑曲线会吐出一堆 17 位小数，图宽才 1400 多画布单位，
    # 两位小数是亚像素精度，文件却能小一大截（近 500 KB -> 百来 KB）。
    svg = re.sub(r"-?\d+\.\d{3,}", lambda m: "%.2f" % float(m.group(0)), svg)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print("已写出 %s（%.1f×%.1f 画布单位，%d 字节，%d 条路径，%d 个站名）"
          % (args.out, w, h, len(svg), svg.count("<path"), svg.count("<text")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
