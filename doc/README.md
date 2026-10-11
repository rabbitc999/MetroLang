# MetroLang 文档索引

MetroLang 是地铁线网**数据语言**；本仓库是它的完整工具链（编译器 / 模板化反编译器 /
自包含 HTML-SVG 地图 / Dijkstra 路线查询 / 交互式查看器）。语法由
[`metrolang.gram`](../metrolang.gram) 定义，前端经
[ParseEngine](https://gitee.com/rabbitc999/ParseEngine) 文法生成器产出。

先读工具链总览 [`README.md`](../README.md)，再按下面顺序进入细节：

| 文档 | 内容 |
|---|---|
| [01 语言参考](01-metrolang-reference.md) | MetroLang 的块 / 命令 / 关键字逐条说明，含未建模范围的边界（§33） |
| [02 JSON 数据格式](02-json-format.md) | 模型 ↔ JSON 的字段口径（**v2**：站点数组、无障碍设施内联、编组/链接数组）与 HTML/SVG 地图输出 |
| [03 出行时间模型](03-travel-time-model.md) | 区间运行时间、停站、换乘与总耗时的计算模型 |

相关入口：

| 位置 | 内容 |
|---|---|
| [`../samples/`](../samples/) | 冒烟样例（`smoke.metro` / `demo.metro`）与真实城市数据（北京 / 上海 / 广州 / 深圳 / 合肥 / 南京 + `TRANSFER.m` + CSV） |
| [`../map_view/`](../map_view/README.md) | 交互式线网查看器（载入 metro-lang JSON 或编辑器旧格式 JSON） |
| [`../vscode/`](../vscode/README.md) | VS Code 插件：`.metro` / `.m` 语法高亮与块折叠 |
| [`../tests/metro_roundtrip.py`](../tests/metro_roundtrip.py) | 真实样例 `compile → decompile → compile` 幂等回归 |

## 源码与文档维护

改语法 / 语义 / JSON 口径时，权威文法（[`metrolang.gram`](../metrolang.gram)）、语义层
（[`epilogue/metro_parse.cpp`](../epilogue/metro_parse.cpp)）、模型与 API
（[`include/metro_model.hpp`](../include/metro_model.hpp)）、反编译模板
（[`template/templates/`](../template/templates/)）、样例与本文档要一起更新；验收以
`sh ci.sh` 跑出来的结果为准。
