#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 MetroLang 总览图（PNG + SVG），画布与配色复用 overview_canvas.py。

运行：python tools/make_overview.py     # 产物落 doc/overview/
"""

from __future__ import annotations

from pathlib import Path

from overview_canvas import (
    CARD, CARD_EDGE, FONT_SANS, FONT_SANS_BOLD, NOTE, PANEL, PANEL_EDGE,
    PTITLE, SUBTITLE, TITLE, Canvas, font,
)


COL_X = (40, 410, 780, 1150)
COL_W = 360


def draw() -> Canvas:
    heading = font(FONT_SANS_BOLD, 31)
    subtitle = font(FONT_SANS, 15)
    panel_title = font(FONT_SANS_BOLD, 17)
    section_title = font(FONT_SANS_BOLD, 13)
    item_title = font(FONT_SANS_BOLD, 12)
    item_detail = font(FONT_SANS, 11)
    footer = font(FONT_SANS, 12)

    canvas = Canvas()
    canvas.text(40, 58, "MetroLang · 线网 DSL 与工具链总览", heading, TITLE)
    canvas.text(40, 88,
                "根目录独立工程 · 文法 / 编译 / 反编译与地图 / 路线查询四层",
                subtitle, SUBTITLE)

    columns = (
        (
            "① 文法与解析", "metro-lang/metrolang.gram · include/",
            (
                ("词法层", (
                    ("关键字 Token", "169 个关键字各占一个 %token"),
                    ("字面量", "字符串 / 数字 / 标识符：%token regex · %identifier"),
                    ("注释与空白", "# 到行尾走 %trivia；空白走 %space"),
                )),
                ("文法结构", (
                    ("块与单行命令", "命令 … END_DEFINE；块内顺序自由、可嵌套"),
                    ("显式产生式", "文档 / 块 / 语句 / 参数 / 列表都写产生式"),
                )),
                ("分析器", (
                    ("LALR(1) 解析器", "由 ParseEngine 生成，零冲突"),
                    ("驱动内嵌", "%epilogue：块栈 / 逐行折叠 / runText"),
                    ("空行与注释行", "块成员循环显式接受 NL"),
                )),
            ),
        ),
        (
            "② 编译管线", "metro-lang/src · preprocess/",
            (
                ("预处理（preprocess/）", (
                    ("条件编译", "%DEFINE / %UNDEFINE / %IF / %ELSE / %ENDIF"),
                    ("包含", "%INCLUDE 'x'：嵌入外部文件、自动防循环"),
                    ("导入", "%IMPORT 'x.csv' AS STATIONS → NODE"),
                )),
                ("数据接入", (
                    ("CSV → 站点", "站名 / 经度 / 纬度（城市可选）"),
                    ("简写规范化", "一行式 DIRECTION_DEFINE 先拆成块"),
                )),
                ("产物", (
                    ("JSON v2", "stations 数组 / 无障碍内联 / 编组链接数组"),
                    ("兼容 v1", "读取端兼容字典与单字符串写法"),
                    ("往返幂等", "compile → decompile → compile 逐字段一致"),
                )),
            ),
        ),
        (
            "③ 反编译与地图", "metro-lang/src · template/templates/",
            (
                ("模板化反编译", (
                    ("模板固化", "*.tmpl 构建期内嵌，运行时不读磁盘"),
                    ("渲染链", "模型 → tmpl::Value → 模板 → .metro"),
                    ("原文保留", "未建模块留在 raw，反编译原样写回"),
                )),
                ("线网地图", (
                    ("HTML 地图", "自包含 SVG：只画线路 / 换乘 / 无障碍"),
                    ("导出", "tools/export_svg.py；make svg 重生成"),
                )),
                ("交互式查看器", (
                    ("map_view/", "缩放 / 悬停看站点 / 点图例筛线路"),
                    ("双格式", "载入 metro-lang JSON 或编辑器 JSON"),
                    ("解释器位置", "界面上指定 metro-lang 可执行文件"),
                )),
            ),
        ),
        (
            "④ 查询与验收", "metro-lang/src/route.cpp · samples/",
            (
                ("路线查询", (
                    ("最短路", "站点 / 线路图上的 Dijkstra"),
                    ("权重", "区间运行时间 segmentRunTimeSeconds"),
                    ("时间模型", "牵引 → 巡航 → 惰行 → 制动；Davis 阻力"),
                )),
                ("样例与规模", (
                    ("真实样例", "北京 / 上海 / 广州 / 深圳 / 合肥 / 南京"),
                    ("规模", "北京 1350 行 · 455 站 · 66 方向"),
                )),
                ("验收", (
                    ("构建", "make -C metro-lang / gen / check"),
                    ("全链路", "compile → JSON → decompile → HTML → route"),
                    ("依赖副本", "preprocess / template / json 各拷一份"),
                )),
            ),
        ),
    )

    section_ys = (202, 416, 568)
    item_ys = ((216, 278, 340), (430, 492), (582, 644, 706))
    for x, (title, location, groups) in zip(COL_X, columns):
        canvas.rect(x, 118, COL_W, 700, PANEL, PANEL_EDGE, radius=14, width=1.5)
        canvas.text(x + 18, 148, title, panel_title, PTITLE)
        canvas.text(x + 18, 170, location, item_detail, NOTE)
        for section_y, ys, (group_title, entries) in zip(section_ys, item_ys, groups):
            canvas.text(x + 18, section_y, group_title, section_title, TITLE)
            for y, (name, detail) in zip(ys, entries):
                canvas.rect(x + 18, y, COL_W - 36, 52, CARD, CARD_EDGE, radius=8)
                canvas.text(x + 29, y + 21, name, item_title, PTITLE)
                canvas.text(x + 29, y + 41, detail, item_detail, NOTE)

    canvas.text(40, 859,
                "仓库关系：metro-lang 是独立仓库，解析器由外部的 ParseEngine 生成器"
                "（gen.sh 拉起）产出，三个库（preprocess / template / json）随仓自持，"
                "可独立构建出单个 metro-lang 可执行文件。",
                footer, NOTE)
    canvas.text(40, 885,
                "语言、JSON（v2）、区间与出行时间模型、样例与查看器的完整说明见 "
                "README.md 与 doc/。",
                footer, NOTE)
    return canvas


def main() -> None:
    image_dir = Path(__file__).resolve().parents[1] / "doc" / "overview"
    canvas = draw()
    canvas.save(str(image_dir / "MetroLang-overview.png"),
                str(image_dir / "MetroLang-overview.svg"))
    print("doc/overview/MetroLang-overview.png + .svg")


if __name__ == "__main__":
    main()
