# MetroLang 语言参考（metro-lang 版）

MetroLang 是描述地铁线网的领域特定语言（DSL）：可读、便于版本控制、可人工编辑也可
自动编译。本文整理自 `metro_editor/doc/MetroLang参考文档.md`，口径与之一致；由
`metro-lang/metrolang.gram` 生成的 `metro-lang` 解析器实现。

约定：
- **块**：`命令 … END_DEFINE` 界定，块内子命令顺序自由，允许嵌套。
- **单行命令**：一行一条，行尾换行结束。
- 本文的“支持情况”指的是 `metro-lang` 的建模程度；未建模的块会按原文保留在
  `Program::raw`（JSON 的 `raw` 字段），不丢内容，但暂不参与查询/渲染。

## 1. 基本约定

- **关键字不区分大小写**：`PROGRAM_DEFINE` 与 `program_DEFINE` 等效。
- **字符串**：单引号 `'…'` 或双引号 `"…"`，支持 `\'` / `\"` 转义。
- **数字**：整数与小数；`DISTANCE` 列表里的 `NIL` 表示无效项。
- **标识符**：线路/方向 ID 由字母、数字、下划线组成，不能以数字开头。
- **注释**：`#` 到行尾。
- **换行与缩进**：命令独占一行；列表元素可用逗号或换行分隔；缩进不影响语义。
- **时间值**：统一换算成**秒**——`30` → 30 s；`1:` → 60 s；`1:30` → 90 s。
- **通配符**：`COPY` / `RENAME` / `DELETE` 类命令的 ID 支持 `*`。
- **空行**：块内外的空行与纯注释行都被忽略（文法里显式接受）。

## 2. 预处理指令（`%` 开头，独占一行）

| 指令 | 语法 | 说明 |
|---|---|---|
| `%DEFINE` | `%DEFINE 符号名` | 定义编译期符号（大小写不敏感） |
| `%UNDEFINE` | `%UNDEFINE 符号名` | 移除符号 |
| `%IF` | `%IF 符号名` | 条件编译开始 |
| `%ELSE` | `%ELSE` | 与最近 `%IF` 配对 |
| `%ENDIF` | `%ENDIF` | 结束条件编译 |
| `%INCLUDE` | `%INCLUDE "文件路径"` 或 `%INCLUDE '文件路径'` | 嵌入外部文件，自动防循环 |
| `%IMPORT` | `%IMPORT "文件路径" AS STATIONS` | 从 CSV 导入站点，等价生成 `STATION_DEFINE` |

实现说明：预处理在 `library/preprocess` 的 `Preprocessor::forMetro()` 上运行；本仓库
的副本把包含路径放宽为“取开头的带引号字面量，忽略后面的 `AS …` 子句”，因此单引号、
双引号、以及 `%IMPORT 'x.csv' AS STATIONS` 都能用。

```metro
%DEFINE CITY_BJ
%IF CITY_BJ
    %INCLUDE 'beijing_config.metro'
%ELSE
    %INCLUDE 'shanghai_config.metro'
%ENDIF

%IMPORT 'BEIJING.csv' AS STATIONS
```

CSV 至少要有站名、经度、纬度三列；表头用 `站名/name`、`经度/lon`、`纬度/lat`、
`城市/city` 识别（顺序无关），读取后展开成逐行 `NODE '站名' COORD 经度, 纬度 [CITY '城市']`。

## 3. 程序定义 `PROGRAM_DEFINE`

```metro
PROGRAM_DEFINE
    KEY_CITY '广州'                     # 必填
    OTHER_CITY ['佛山', '中山']         # 可选，字符串或列表
    VERSION 'V1.0'                      # 可选，默认 V1.0
    UPDATE_DATE '2026-07-11'            # 可选
    AUTHOR '作者名'                     # 可选，默认“匿名”
    CREATE_DATE '2026-01-01'            # 可选
END_DEFINE
```

## 4. 站点定义 `STATION_DEFINE`

```metro
STATION_DEFINE
    NODE '站名' COORD 经度, 纬度 [CITY '城市']
    OTHER_NAME '别名'
    OTHER_NAMES ['别名1', '别名2']
END_DEFINE
```

`OTHER_NAME(S)` 作用于紧随的 `NODE`。未写 `CITY` 时编译期按途经线路推断。同名站跨城市
时内部键为 `城市::站名`，导出 JSON 用 `站名 (城市)`。

## 5. 站点操作（单行 / 块，支持 `*`）

| 命令 | 语法 |
|---|---|
| `STATION_COPY` | `STATION_COPY 旧站名 新站名` |
| `STATION_RENAME` | `STATION_RENAME 旧站名 新站名` |
| `STATION_DELETE` | `STATION_DELETE 站名 [站名…]` |
| `STATION_MODIFY` | `STATION_MODIFY '站名' … END_DEFINE` |

```metro
STATION_MODIFY '旧站名'
    SET COORD 经度, 纬度
    SET CITY '城市'
    SET OTHER_NAMES ['别名1', '别名2']
    ADD OTHER_NAME '别名'
    REMOVE OTHER_NAME '别名'
END_DEFINE
```

## 6. 线路模板 `LINE_TEMPLATE`

```metro
LINE_TEMPLATE 模板ID [INHERITS 父模板ID]
    NAME '名称'          COLOR '颜色'        CITY '城市'
    OPEN_YEAR 年份       FORMATION '编组'     MAXSPEED 速度
    POWER 功率           BRAKE 减速度        DISABLED TRUE|FALSE
    IMAGE '图片路径'     LINK 'URL'          SPECIAL
END_DEFINE
```

`LINE_DEFINE` 里用 `INHERITS 模板ID` 套用并可覆盖。
`FORMATION` 与 `LINK` 可以**重复声明多条**（例如同一线路不同区段的编组、多个百科链接），
取值范围参数（字符串或多个字符串），JSON 里对应数组；`LINE_MODIFY` 下 `SET FORMATION` /
`SET LINK` 覆盖全部，`ADD FORMATION` / `ADD LINK` 追加。

## 7. 线路定义 `LINE_DEFINE`

```metro
LINE_DEFINE 线路ID [INHERITS 模板ID]
    NAME '线路名称'      # 必填
    COLOR '颜色'         # 必填
    CITY '城市'          # 可选，默认 KEY_CITY
    FORMATION '6B'       MAXSPEED 80      OPEN_YEAR 2000
    POWER 3680           BRAKE 0.85       LINK 'URL'      IMAGE '图片路径'
    DISABLE              SPECIAL          PENDING ['站1', '站2']
    DEPOT '站名' [方向ID] [HH:mm]
    DIRECTION_DEFINE … END_DEFINE          # 嵌套方向
    SPECIAL_DEFINE … END_DEFINE            # 嵌套特殊票价
END_DEFINE
```

嵌套方向自动继承外层线路 ID。`PENDING` 支持单站或列表。

## 8. 线路操作（单行，支持 `*`）

| 命令 | 语法 |
|---|---|
| `LINE_COPY` | `LINE_COPY 源模式 目标模式` |
| `LINE_RENAME` | `LINE_RENAME 源模式 目标模式` |
| `LINE_DELETE` | `LINE_DELETE 线路ID [线路ID…]` |
| `LINE_MERGE` | `LINE_MERGE 线路1 线路2 … INTO 新线路 [KEEP_ORIGINAL]` |
| `LINE_MODIFY` | `LINE_MODIFY 线路ID … END_DEFINE` |

```metro
LINE_MODIFY 线路ID
    SET NAME '新名称'    SET COLOR '#新颜色'    SET MAXSPEED 新速度
    SET IMAGE '新图片'   SET OPEN_YEAR 2028
    ADD SPECIAL          REMOVE SPECIAL
END_DEFINE
```

## 9. 方向模板 `DIRECTION_TEMPLATE`

```metro
DIRECTION_TEMPLATE 模板ID [INHERITS 父模板ID]
    IS_FUTURE TRUE|FALSE     CONNECT_STATION '站名'     LOOP [INNER | OUTER]
END_DEFINE
```

## 10. 方向定义 `DIRECTION_DEFINE`

```metro
DIRECTION_DEFINE 方向ID [INHERITS 模板ID] [线路ID]
    STATIONS ['站1', '站2', …]        # 必填（MERGE / REVERSE 除外）
    DISTANCE AUTO | [距离列表]         # AUTO 自动按经纬度计算
    SEGMENT_TYPE '站A' '站B' ELEVATED  # 高架 / UNDERGROUND / GROUND
    LOOP [INNER | OUTER]              EXPRESS_STOPS ['站1', …]
    ROUTING '交路名称' ['站1', …]      # 可多条
    FUTURE                            SPEED_LIMIT '站A' '站B' 速度
    CROWD TIME_RANGE HH:mm HH:mm 系数 [星期修饰符]
    HEADWAY TIME_RANGE HH:mm HH:mm VALUE 秒数
    DWELL_TIME '站名' 秒数             OPEN_TIME HH:mm HH:mm
    VIA 方向ID                         REVERSE 原方向ID
    MERGE 方向A 方向B
END_DEFINE
```

**反向简写（一行式，不带 `END_DEFINE`）**：

```metro
DIRECTION_DEFINE 方向ID REV 原方向ID
```

- `REV` 立即继承并反转原方向的站点与距离，**不能再追加子命令**；
- `REVERSE` 写在块内，保留追加其它子命令的能力。
- 距离列表：非环线数量 = 站点数 − 1（最后一项 `NIL`）；环线数量 = 站点数。
- `EXPRESS_STOPS` 是 `STATIONS` 的子集（≥2 且不等于全部），方向仍须列全车站。
- 星期修饰符：`MONDAY … SUNDAY`、`[MONDAY, WEDNESDAY]`、`WORKDAY`、`WEEKEND`。

> 实现说明：`metro-lang` 在进入分析器之前把一行式 `DIRECTION_DEFINE X REV Y` 规范化成
> 等价的 `DIRECTION_DEFINE X` + `REV Y` + `END_DEFINE` 块。这样文法里不必造一条和
> 块头抢同一个 Token 的产生式（LALR(1) 下 `REV` 同时是方向块成员）。

## 11. 方向操作（单行，支持 `*`）

| 命令 | 语法 |
|---|---|
| `DIRECTION_COPY` | `DIRECTION_COPY 源模式 目标模式` |
| `DIRECTION_RENAME` | `DIRECTION_RENAME 源模式 目标模式` |
| `DIRECTION_DELETE` | `DIRECTION_DELETE 方向ID [方向ID…]` |
| `DIRECTION_SPLIT` | `DIRECTION_SPLIT 方向ID AT '站名' INTO 新方向1 新方向2` |
| `DIRECTION_REVERSE` | `DIRECTION_REVERSE 方向ID [新方向ID]` |
| `DIRECTION_MODIFY` | `DIRECTION_MODIFY 方向ID … END_DEFINE` |

```metro
DIRECTION_MODIFY 方向ID
    ADD LOOP            REMOVE LOOP
    ADD ROUTING '交路名称' ['站1', …]     REMOVE ROUTING '交路名称'
    SET ROUTING '交路名称' ['站1', …]     SET CONNECT_STATION '站名'
    SET IS_FUTURE TRUE|FALSE             SET DIRECTION_TYPE INNER|OUTER
    SET EXPRESS_STOPS ['站1', …]
END_DEFINE
```

## 12. 票价定义 `PRICE_DEFINE`

```metro
PRICE_DEFINE
    CURRENCY 'CNY'
    DEFAULT_FARE 2                      # 起步价
    SEGMENT 0 6 2                       # 里程区间 [起, 止) 票价
    SEGMENT 6 12 3
    LINEAR_EXTENSION THRESHOLD 12 BASE_FARE 3 RATE_PER_KM 0.3
    TRANSFER_DISCOUNT ENABLED TRUE DISCOUNT_AMOUNT 1 TIME_LIMIT 120
    FARE_CAP 15                         # 0 = 不封顶
    SPECIAL_LINE 线路ID ALL 票价
    SPECIAL_LINE 线路ID SEGMENT '站A' '站B' 票价
END_DEFINE
```

## 13. 换乘定义

```metro
TRANSFER_TYPE 类型ID '类型名称'
    TIME 秒数
    STATUS OPERATING | PENDING | OUT_STATION
    SECURITY_CHECK
END_DEFINE

TRANSFER 类型ID '站名' 线路A [线路B]     # 只给一条线路 = 与该站其它线路通配配对

TRANSFER_DEFINE '站名' 线路A 线路B
    TIME 秒数    STATUS …    SECURITY_CHECK
END_DEFINE

VIRTUAL_TRANSFER_DEFINE '站A' '站B'
    TIME_MINUTES 分钟数    SECURITY_CHECK    VIA_DIRECTIONS [方向ID…]
END_DEFINE
```

## 14. 运营参数 `OPERATION_DEFINE`

```metro
OPERATION_DEFINE
    TRANSFER_TIME 180               # 站内换乘，默认 180
    DWELL_TIME 30                   # 默认停站，默认 30
    OUT_STATION_TRANSFER_TIME 300   # 出站换乘，默认 300
    ENTRY_TIME 120                  # 进站（闸机→站台），默认 120
    AVG_BOARD_TIME 3                # 平均上车，默认 3
END_DEFINE
```

## 15. 时段配置

```metro
HEADWAY_PROFILE 线路ID
    PERIOD HH:mm HH:mm 秒数 [星期修饰符]
END_DEFINE

CROWD_PROFILE 方向ID
    PERIOD HH:mm HH:mm 系数 [星期修饰符]     # 系数 ≥ 1.0
END_DEFINE
```

## 16. 停站时间 `DWELL_TIME_DEFINE`

```metro
DWELL_TIME_DEFINE
    NODE '站名' 线路ID 秒数
    LINE 线路ID 秒数
    DIRECTION 方向ID 秒数
END_DEFINE
```

优先级 `NODE` > `DIRECTION` > `LINE`。

## 17. 限速 `SPEED_LIMIT_DEFINE`

```metro
SPEED_LIMIT_DEFINE 方向ID
    NODE '站A' '站B' 速度(km/h)
END_DEFINE
```

## 18–23. 其余单行命令

```metro
STATION_MODE '站名' ENTRY_ONLY|EXIT_ONLY|BOTH [TIME_RANGE HH:mm HH:mm] [星期修饰符]
OPEN_TIME [GLOBAL | 线路ID] HH:mm HH:mm [星期修饰符]
DEPOT 线路ID '站名' [方向ID] [HH:mm]
VIA 方向A 方向B                                  # 共线/跨线
STATION_STATUS ['站1', '站2'] [线路ID] OPERATING|PENDING|OUT_STATION
```

## 22. 标签 `LABEL_DEFINE`

```metro
LABEL_DEFINE
    NODE '标签文本' COORD 经度, 纬度
END_DEFINE
```

## 24. 无障碍设施 `FACILITY_DEFINE`

> 仅用于展示/查询，**不参与**路径规划与票价计算。

```metro
FACILITY_DEFINE
    TOILET '站名' POSITION PAID_AREA|UNPAID_AREA [ACCESSIBLE] [GENDER MALE|FEMALE|MIXED]
    ACCESSIBLE_TOILET '站名' POSITION … [ACCESSIBLE] [GENDER …]
    ELEVATOR '站名' LOCATION '具体位置' [ACCESSIBLE]
    WIDE_GATE '站名' QUANTITY 数量
    ESCALATOR '站名' QUANTITY 数量 [DIRECTION up|down|both]
    TACTILE_PAVING '站名' STATUS available|partial|none
END_DEFINE
```

**建模结果**：这些行会挂到对应站点的无障碍信息上（JSON v2 的
`stations[].accessibility`，见 `doc/02-json-format.md` §5.1），不再是根级的独立字典。
站名取行里第一个字符串参数；站点尚未定义时按该站名补一条空站点，数据不会丢。
未建模的块（如 `PROMOTION_DEFINE`）仍原样留在 `raw`。

## 25. 票价优惠 `PROMOTION_DEFINE`

```metro
PROMOTION_DEFINE 策略ID '策略名称'
    TYPE FIXED|FIXED_DISCOUNT|PERCENT     # 具体折扣
    DISCOUNT_AMOUNT 金额
    APPLICABLE_LINES ['线路1', …]  |  ALL
    POLICY … END_POLICY
END_DEFINE
```

## 26. 编译期断言 `ASSERT`

```metro
ASSERT 条件 '失败提示'
```

## 27. 后处理输出 `ECHO`

```metro
ECHO '文本' [格式化参数…]
```

## 28. 平台坐标与自动换乘时间

```metro
PLATFORM_COORD '站名' 线路ID 经度, 纬度
GEN_TRANSFER [GLOBAL] [WALK_SPEED 速度] [AVG_BOARD_TIME 秒数]
```

## 29. 区域定义 `ZONE_DEFINE`

```metro
ZONE_DEFINE 区域ID
    TYPE RESIDENTIAL|COMMERCIAL|CBD|EDUCATIONAL|MEDICAL|GOVERNMENT|TRANSPORT_HUB|MIXED|TOURIST|OTHER
    CENTER 经度, 纬度   RADIUS 半径
    PEAK_HOURS …        POPULATION_DENSITY …      AVG_RENT …
    ATTRIBUTES … END_ATTRIBUTES
END_DEFINE
```

## 30. 运营公司 `OPERATOR_DEFINE`

```metro
OPERATOR_DEFINE 公司ID
    NAME '全称'      SHORT_NAME '简称'   EN_NAME '英文名'   COUNTRY '国家'
    CITY '城市'      FOUNDED 年         WEBSITE 'URL'      HOTLINE '电话'
    DESCRIPTION '简介'                  LINES ['线路1', …]
END_DEFINE
```

## 31. 背景图片 `BACKGROUND_DEFINE`

```metro
BACKGROUND_DEFINE
    IMAGE '图片'      OPACITY 0.5      POSITION 经度, 纬度
    BOUNDS 南, 西, 北, 东              POLYGON ['经度,纬度', …]
END_DEFINE
```

## 32. 路段类型子命令 `SEGMENT_TYPE`

```metro
SEGMENT_TYPE '起点站' '终点站' ELEVATED|UNDERGROUND|GROUND
```

## 33. 编译与查询（`metro-lang` 工具链）

JSON 口径见 `doc/02-json-format.md`（v2：站点是数组、无障碍设施内联在站点里、
编组 / 链接是数组）。


```text
metro-lang check   文件.m                # 只编译，打印线路/车站/换乘统计
metro-lang compile 文件.m -o 输出.json    # 编译成 JSON
metro-lang decompile 输入.json -o 输出.metro   # 模板化反编译
metro-lang html    文件.m -o 输出.html    # 自包含 SVG 地图
metro-lang route   文件.m --from 站A --to 站B  # 最短路查询
```

建模覆盖：`PROGRAM_DEFINE`、`STATION_DEFINE`、`OPERATION_DEFINE`、`PRICE_DEFINE`、
`TRANSFER_TYPE`、`TRANSFER`（单行）与 `TRANSFER_DEFINE`（块）、
`FACILITY_DEFINE`（落到站点 `accessibility`）、
`LINE_DEFINE`（含嵌套 `DIRECTION_DEFINE` / `SPECIAL_DEFINE`）、
`DIRECTION_DEFINE`（含 `REV` / `REVERSE` / `MERGE` / `ROUTING` / `EXPRESS_STOPS` /
`SEGMENT_TYPE`）、以及各类 `*_MODIFY`。其余命令被文法接受并原样保留（`raw`），
保证“解析不丢内容”；`check` 打印的“未建模块 N 行”就是这个 `raw` 的长度。
