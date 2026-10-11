# MetroLang JSON 数据格式（v2）

本文描述 `metro-lang compile` 产出的 JSON 结构，也是 `metro-lang decompile` / `html` /
`route` 的输入。字段全部可选，缺失按默认值处理；反编译器会把缺省值回填成显式写法。

## 0. 与 v1（`metro_editor/route_data.json`）的差异

v1 的口径来自 `metro_editor/doc/Json格式参考文档.md`。v2 在**保持同名字段含义**的前提下
做两处结构性升级，其余字段原样兼容：

| 变化 | v1 | v2 | 理由 |
|---|---|---|---|
| 站点容器 | `stations` 是**以站名为键的字典** | `stations` 是**数组**，站名放进元素的 `name` | 同名车站可能出现在不同城市（如两市各有一个"人民广场"），用站名当键会静默互相覆盖 |
| 无障碍设施 | 根级 `facilities` 字典（键为站名），站点再用站名回指 | **内联进 `stations[].accessibility`** | 站点数据只存一处，地图 / 查询不必二次查表；与"站点是数组"一起，站点条目自带身份 |
| 编组 / 链接 | `formation` / `link` 各是一个字符串 | **数组**，可声明多条 | `FORMATION` / `LINK` 在源码里本来就可以重复出现，v1 的字符串写法会静默丢数据 |

读取端对这三种旧写法都保留兼容：`stations` 仍接受字典形式（键当站名）、
`formation` / `link` 仍接受单个字符串，所以 v1 产物能直接读进来；写出的一律是 v2 形式。

## 1. 根对象

```json
{
  "key_city": "深圳",
  "author": "路网数据",
  "version": "V1.0",
  "create_date": "2024-01-01",
  "update_date": "2026-07-11",
  "other_cities": ["东莞"],
  "operation_params": { },
  "price": { },
  "transfer_types": [],
  "stations": [],
  "lines": { },
  "transfers": [],
  "open_times": []
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `key_city` | string | 主城市（`KEY_CITY`） |
| `author` / `version` | string | 默认 `"匿名"` / `"V1.0"` |
| `create_date` / `update_date` | string | `YYYY-MM-DD`，未写则为空串 |
| `other_cities` | string[] | `OTHER_CITY` 列表 |
| `operation_params` | object | 运营参数（§2） |
| `price` | object | 票价规则（§3） |
| `transfer_types` | array | `TRANSFER_TYPE` 定义（§4） |
| `stations` | array | 站点数组，每项自带 `name`（§5） |
| `lines` | object | 线路字典，键为线路 ID（§6） |
| `transfers` | array | 换乘规则（§7） |
| `open_times` | array | 运营时间（§8） |

**未建模的语句不进 JSON。** `metro-lang` 只把认得的块与命令写进模型，其余原样留在
`Program::raw`（`metro-lang check` 打印的"未建模块 N 行"就是它）。因此 JSON 只是一份
"已建模数据"的快照，不承诺保存未建模语法；需要完整原文请保留 `.m` 源文件。

## 2. `operation_params`

```json
{ "inner_transfer_time": 180, "out_station_transfer_time": 300,
  "dwell_time": 30, "entry_time": 120, "avg_board_time": 3 }
```

| 字段 | 单位 | 默认 | 来源 |
|---|---|---|---|
| `inner_transfer_time` | 秒 | 180 | `TRANSFER_TIME` |
| `out_station_transfer_time` | 秒 | 300 | `OUT_STATION_TRANSFER_TIME` |
| `dwell_time` | 秒 | 30 | `DWELL_TIME` |
| `entry_time` | 秒 | 120 | `ENTRY_TIME` |
| `avg_board_time` | 秒 | 3 | `AVG_BOARD_TIME` |

## 3. `price`

```json
{
  "currency": "CNY",
  "pricingType": "distance",
  "default_fare": 2,
  "segments": [ { "rangeStart": 0, "rangeEnd": 6, "fare": 2 } ],
  "linearExtension": { "threshold": 12, "baseFare": 3, "ratePerKm": 0.3 }
}
```

| 字段 | 说明 |
|---|---|
| `currency` | 货币代码，默认 `"CNY"`（`CURRENCY`） |
| `pricingType` | 固定 `"distance"` |
| `default_fare` | 起步价（`DEFAULT_FARE`） |
| `segments` | 分段票价：`rangeStart` / `rangeEnd` 公里区间 + `fare`（`SEGMENT lo hi fare`） |
| `linearExtension` | 线性延伸：`threshold` 起按 `baseFare + ratePerKm × (公里数 − threshold)`；只在源码写过 `LINEAR_EXTENSION` 时出现 |

`fare_cap`、`transferDiscount`、`specialLines` 目前只在模型里保留、**尚未写入 JSON**。
里程表以外还没建模的票价写法会按 §1 的规则留在 `raw`。

## 4. `transfer_types`

```json
[ { "id": "SAME", "name": "同台换乘", "time": 120,
    "status": "OPERATING", "security_check": false } ]
```

`id` 是第一列关键字，`name` 是紧随的显示名；`TIME` 缺省为 0，`SECURITY_CHECK` 出现即为 true。

## 5. `stations`（数组）

```json
[
  {
    "name": "福田口岸",
    "lon": 114.0693, "lat": 22.5201, "city": "深圳",
    "otherNames": [],
    "lines": [ { "id": "SZ4", "start": "福田口岸", "end": "牛湖", "status": "" } ],
    "accessibility": {
      "toilet": { "position": "paid_area", "accessible": true, "gender": "mixed" },
      "accessible_toilet": { "position": "paid_area", "accessible": true, "gender": "mixed" },
      "elevators": [ { "location": "A口出口旁", "accessible": true } ],
      "wide_gate": { "quantity": 2 },
      "escalators": [ { "quantity": 4, "direction": "both" } ],
      "tactile_paving": { "status": "available" },
      "accessible": true
    }
  }
]
```

| 字段 | 说明 |
|---|---|
| `name` | 站名（**身份字段**，数组不按站名建索引） |
| `lon` / `lat` | WGS-84 经纬度，来自 `NODE … COORD lo, la` |
| `city` | 所属城市 |
| `otherNames` | 多语言别名（`OTHER_NAME` / `OTHER_NAMES`） |
| `lines` | 该站所属方向摘要（`StationLineRef`）：`id` / `start` / `end` / `status` |
| `accessibility` | **v2 新增**：无障碍设施，直接绑在站点上（§5.1） |

站点是数组后，**同名车站可以共存**：不同城市各有一个"人民广场"时就是两条独立记录，
各带自己的 `city`。引用站点的地方（方向的 `station[].name`、换乘的 `station`）写的是
站名，跨城市同名时按出现顺序解析到第一条——需要无歧义引用时请让站名保持唯一。

### 5.1 `accessibility`（无障碍设施）

由 `FACILITY_DEFINE` 块产生，每个成员行对应一个站点的一条设施：

```metro
FACILITY_DEFINE
    TOILET '福田口岸' POSITION PAID_AREA ACCESSIBLE GENDER MIXED
    ELEVATOR '福田口岸' LOCATION 'A口出口旁' ACCESSIBLE
    WIDE_GATE '福田口岸' QUANTITY 2
END_DEFINE
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `toilet` | ToiletInfo | 普通卫生间（`TOILET`） |
| `accessible_toilet` | ToiletInfo | 无障碍卫生间（`ACCESSIBLE_TOILET`），`accessible` 恒为 true |
| `elevators` | ElevatorInfo[] | 无障碍电梯（`ELEVATOR`） |
| `wide_gate` | WideGateInfo | 宽闸机（`WIDE_GATE`） |
| `escalators` | EscalatorInfo[] | 自动扶梯（`ESCALATOR`） |
| `tactile_paving` | TactilePavingInfo | 盲道（`TACTILE_PAVING`） |
| `accessible` | bool | 该站出现过任意一条 `ACCESSIBLE` 标记 |

- **ToiletInfo**：`position`（`paid_area` / `unpaid_area`）、`accessible`（bool）、
  `gender`（`mixed` / `male` / `female`）。
- **ElevatorInfo**：`location`（位置描述）、`accessible`（bool，电梯默认视为无障碍设施）。
- **WideGateInfo**：`quantity`（数量）。
- **EscalatorInfo**：`quantity`、`direction`（`up` / `down` / `both`，默认 `both`）。
- **TactilePavingInfo**：`status`（`available` / `partial` / `none`）。

只写出真正出现过的条目；整站没有任何设施时**不产生** `accessibility` 字段。
这些数据只用于展示与查询，**不参与路径规划和票价计算**。

## 6. `lines`（键 = 线路 ID）

```json
{
  "SZ4": {
    "name": "4号线", "color": "#D2273C", "city": "深圳",
    "formation": ["6A"], "maxspeed": 80, "open_year": 2004,
    "power_kw": 0, "brake": 0, "link": ["https://..."], "image": "",
    "disabled": false, "special": false, "pending": [],
    "direction": [
      {
        "id": "SZ4_0", "start": "福田口岸", "end": "牛湖",
        "is_loop": false, "is_future": false, "direction_type": "",
        "station": [ { "name": "福田口岸", "city": "深圳", "next": 1.21, "dwell_time": null } ],
        "routings": [ { "name": "全程交路", "stations": ["福田口岸", "牛湖"] } ]
      }
    ]
  }
}
```

| 字段 | 说明 |
|---|---|
| `name` / `color` / `city` | 线路名 / 颜色 `#RRGGBB` / 城市 |
| `formation` | **v2 数组**：编组，可多条（`FORMATION`） |
| `link` | **v2 数组**：百科链接，可多条（`LINK`） |
| `maxspeed` | 最高速度 km/h |
| `open_year` / `power_kw` / `brake` / `image` | 开通年份 / 牵引功率 / 制动减速度 / 示意图 |
| `disabled` / `special` | 停运 / 特殊线路 |
| `pending` | 暂缓开通站点（`PENDING`） |
| `direction` | 方向数组 |

`Direction`：`id`、`start` / `end`（首末站）、`is_loop`、`is_future`、
`direction_type`（`INNER` / `OUTER`，仅环线）、`station`、`routings`。

- `DirectionStation`：`name`（站名）、`city`（所属城市）、`next`（到下一站的距离 km，
  未知为 `null`）、`dwell_time`（秒，未设置为 `null`）。
  方向里带 `city` 是为了让站点引用**无歧义**：站名允许跨城市重名（§5），只写名字时读端
  无法判断指向哪一座；城市取自站点表，站点没写城市时退回该线路的 `CITY`。
- `Routing`：`{ "name": "交路名称", "stations": [ … ] }`。
- `next` 是**按站序对齐**的：非环线有 `站数 − 1` 段；环线末站还会带一段"绕回起点"的距离，
  所以是 `站数` 段。某一段距离未知时该位置为 `null`（源码里写 `NIL`），不会把后面的距离挤上来。

## 7. `transfers`

```json
[ { "type": "OUT", "station": "福田口岸", "from": "SZ4", "to": "SZ10", "time": 600 } ]
```

`type` 取自 `TRANSFER_DEFINE` 块里的 `STATUS`、或单行 `TRANSFER <类型> …` 的第一个词；
`time` 的单位是秒。源码里没写 `TIME` 时取换乘类型 / 全局默认值。

两种写法都建模：

```metro
TRANSFER_DEFINE '福田口岸' SZ4 SZ10
    STATUS OUT_STATION
    TIME 600
END_DEFINE

TRANSFER OUT "湖贝" SZ5 SZ2_8
```

## 8. `open_times`

```json
[ { "id": "GLOBAL", "from": "06:00", "to": "23:30", "days": "WORKDAY" } ]
```

`id` 为线路 ID 或 `GLOBAL`；`from` / `to` 为 `HH:mm`；`days` 保留源码里的星期修饰符原文。

## 9. 校验规则

- 线路 ID / 方向 ID 唯一；站名**不要求全局唯一**（同名车站按数组条目区分，见 §5），
  但需要按站名互相引用时建议保持唯一。
- `STATIONS` 里的站名必须已在 `STATION_DEFINE` 出现（或由 `%IMPORT` 生成）。
- `DISTANCE` 项数：非环线 = 站数 − 1（可含 `NIL` 占位）、环线 = 站数。
- `EXPRESS_STOPS` ⊂ `STATIONS` 且 ≥ 2；`ROUTING.stations` ⊂ `STATIONS` 且 ≥ 1。
- 换乘引用的线路必须存在。
- 时间统一为秒；`TIME_RANGE` 的起止必须同序。
- 反编译器对同一份 JSON 是**幂等**的：`compile → decompile → compile` 得到同一份 JSON
  （样例目录下 7 份真实线网都跑过这条不变式）。

## 10. HTML / SVG 地图输出

`metro-lang html <线路.m> -o 地图.html` 把同一份模型渲染成一个**自包含**网页：无外链、
无脚本依赖，双击即可离线查看。页面里的 SVG 就是线网图本体：

- **每条方向一条 `<polyline>`**，颜色取线路 `color`，线宽 7（画布单位），坐标由
  `stations` 的经纬度投影到 Web 墨卡托，再按范围等比缩放居中到 **1600×1200** 视口；
- **每座有坐标的车站一个 `<circle>`**，站名带白色描边（`paint-order: stroke`）；
- 带无障碍设施的站点用绿色描边标出，并在站名后追加 `♿`；右上角图例固定列出
  `♿ 无障碍设施` 与各线路色块。
- **站名密度控制**：站点超过 150 座时只标"换乘站"（线路数 ≥ 2，圆点更大）与带无障碍
  设施的站，否则全标——几百座站的站名全画出来会把图糊成一片。

以深圳样例为例（`metro-lang html samples/shenzhen.m`）：SVG 里有 **32 条折线**
（16 条线路 × 2 个方向）与 **354 座车站圆点**，即整张深圳地铁线网；北京、上海、广州等
样例同理，折线数 = 方向数、圆点数 = 有坐标的站点数。

```sh
build/metro-lang/metro-lang html samples/shenzhen.m -o shenzhen.html
```

**独立 SVG**：`tools/export_svg.py`（`make -C metro-lang svg`）把页面里的那段 `<svg>`
抠出来，补宽高、`<title>` 与深色背景，得到能直接 `<img>` 进 README 的独立文件。
它默认 **`--no-labels`：不打印站名**，只留线网、换乘站与无障碍标记；`--labels` 才保留
站名。`--scale`（默认 2）只把内联 `width`/`height` 放大到 3200×2400，`viewBox` 不变，
矢量图放大不掉清晰度。产物是 `doc/shenzhen-metro.svg`。

## 11. 扩展性

未知字段应被忽略；新增字段必须可选且给出默认值。反编译器是模板化生成：JSON → 模板变量 →
`template/templates/` 下的 `.tmpl`，模板在构建期固化成 C++ 头（`build/metro-lang/gen/metro_templates.hpp`），
运行时不读磁盘模板。
