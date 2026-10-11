#!/usr/bin/env python3
"""生成 MetroLang 的插件图标（`vscode/icon.png`）。

图标语义：**线路图**——一条折线串起若干站点圆点，换乘站用更大的实心圆，
深蓝底色配金色强调。产物入库、脚本随时可重跑（确定性：同样输入必然同样字节）。

用法：
    python3 tools/make_icon.py            # 写成 vscode/icon.png（256×256）
    python3 tools/make_icon.py --size 512

依赖：Pillow（`pip install pillow`）。
"""
from __future__ import annotations

import argparse
import math
import os

from PIL import Image, ImageDraw

# 画法约定（与 Magel 的 make_icon.py 同口径）：在 3 倍逻辑画布上画再用 LANCZOS
# 降采样，线端补圆（draw.line 没有圆头）。
SUPERSAMPLE = 3

# 配色（深色版式）。
BG_TOP = (27, 43, 75)        # #1b2b4b
BG_BOTTOM = (13, 23, 40)     # #0d1728
BG_BORDER = (52, 84, 128)    # #345480
GOLD = (255, 209, 102)       # #ffd166
LINE = (244, 247, 251)       # #f4f7fb
GHOST = (120, 150, 195)      # 次级线路

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # 仓库根
DEFAULT_OUT = os.path.join(ROOT, "vscode", "icon.png")


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """竖直线性渐变底（上 top → 下 bottom）。"""
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return grad.resize((size, size))


def rounded_mask(size: int, radius: int) -> Image.Image:
    """圆角矩形蒙版。"""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def disc(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    """画一个实心圆点。"""
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def thick_line(draw: ImageDraw.ImageDraw, points, width: int, fill) -> None:
    """画折线并给每个顶点补圆头（弥补 draw.line 没有圆头）。"""
    draw.line(points, fill=fill, width=width, joint="curve")
    for x, y in points:
        disc(draw, x, y, width / 2, fill)


def draw_icon(size: int) -> Image.Image:
    """按逻辑尺寸 size 画图标（内部按 SUPERSAMPLE 放大再降采样）。"""
    s = size * SUPERSAMPLE
    img = vertical_gradient(s, BG_TOP, BG_BOTTOM).convert("RGBA")

    # 圆角底 + 内描边。
    mask = rounded_mask(s, radius=int(s * 0.22))
    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    base.paste(img, (0, 0), mask)
    draw = ImageDraw.Draw(base)
    inset = int(s * 0.02)
    draw.rounded_rectangle(
        [inset, inset, s - 1 - inset, s - 1 - inset],
        radius=int(s * 0.20),
        outline=BG_BORDER,
        width=max(1, int(s * 0.012)),
    )

    # 主线路：一条折线（上中 → 右下），中间两个换乘站。
    lw = max(2, int(s * 0.045))
    main_pts = [
        (s * 0.28, s * 0.26),
        (s * 0.52, s * 0.42),
        (s * 0.46, s * 0.66),
        (s * 0.72, s * 0.78),
    ]
    thick_line(draw, main_pts, lw, LINE)

    # 次级线路：从左下接入中间换乘站。
    ghost_pts = [
        (s * 0.24, s * 0.72),
        (s * 0.46, s * 0.66),
    ]
    thick_line(draw, ghost_pts, int(lw * 0.8), GHOST)

    # 站点：普通站小圆（底色描金），换乘站大实心金圆。
    for (x, y), is_hub in zip(main_pts, [False, True, True, False]):
        if is_hub:
            disc(draw, x, y, s * 0.062, GOLD)
        else:
            disc(draw, x, y, s * 0.042, BG_BOTTOM)
            draw.ellipse(
                [x - s * 0.042, y - s * 0.042, x + s * 0.042, y + s * 0.042],
                outline=GOLD,
                width=max(1, int(s * 0.016)),
            )

    return base.resize((size, size), Image.LANCZOS)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 MetroLang 插件图标")
    parser.add_argument("--size", type=int, default=256, help="输出边长（默认 256）")
    parser.add_argument("--out", default=DEFAULT_OUT, help="输出路径（默认 vscode/icon.png）")
    args = parser.parse_args()

    # 先按 3 倍逻辑画布画，再降采样，边缘更干净。
    icon = draw_icon(args.size)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    icon.save(args.out, "PNG")
    print(f"已生成图标：{args.out}（{args.size}×{args.size}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
