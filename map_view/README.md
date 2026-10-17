# map_view —— 交互式地铁线网查看器

把 `metro_editor/Page/map.html` 拆开后的**独立查看器**：同一个 d3 绘图逻辑，
但去掉了"必须由编辑器喂数据"的绑定，改成**自己选数据源**——可以直接载入
`metro-lang` 解析器写出的 JSON，也可以载入地铁编辑器导出的旧格式 JSON。

几何计算（索引站表、投影、平滑、连线）全在 `js/metro_mapcore.js` 里，那一份文件
**同时被本查看器、`metro-lang html` 生成的静态页、`metro/previewMap` 的 webview
复用**——纯函数、不碰 DOM，浏览器和 C++ 都吃同一套坐标。

![查看器效果图](preview.svg)

上图就是本页显示的效果：深圳地铁全量线网（16 条线路 / 354 座车站）在
`metro-lang compile samples/shenzhen.m -o shenzhen.json` 之后拖进查看器的样子。

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 页面骨架 + 左上角"数据源 / 解释器位置 / 选择文件"工具栏 |
| `css/style.css` | 原 `map.html` 的样式（只追加了工具栏的几行样式） |
| `js/d3.min.js` | 原 `map.html` 内联的 d3 v7.9.0，拆成独立文件 |
| `js/metro_mapcore.js` | **绘图内核**：纯计算，无 DOM 无 d3。站表索引、模型归一化、投影、Catmull-Rom 平滑、路径 `d`、图例 |
| `js/app.js` | 交互层：读内核对模型算好的坐标，用 d3 拼 SVG，管 tooltip / 缩放 / 筛选 / 状态栏 |
| `js/loader.js` | 新增的数据加载层：识别格式 → 归一化 → 交给 `drawMap()` |
| `test/mapcore.js` | 内核单测，纯 `node` 跑，不需要浏览器 |
| `preview.svg` | README / 文档用的效果图（矢量图，贴边裁好） |
| `tools/render_preview.js` | 无头出图第一步：jsdom 跑页面 → 抠出 `<svg>` |
| `tools/make_preview.py` | 无头出图第二步：量内容包围盒 → 写成贴边的 `preview.svg` |

拆成多个文件只是为了让每份都可读：原来 416 KB 的单文件里 348 KB 是 d3，
剩下的绘图代码和样式也各自独立了。`index.html` 用普通 `<script>` 按
`d3 → metro_mapcore → app → loader` 的顺序加载（**内核必须在 `app.js` 前面**，
`app.js` 只在 `drawMap()` 里取 `window.MetroMapCore`，所以顺序错了会在第一次
渲染时直接抛错而不是静默画错），`file://` 直接双击也能跑。

## 内核 API

`js/metro_mapcore.js` 是 UMD 包装：浏览器里挂 `window.MetroMapCore`，
Node 里 `require()` 也能拿到。全部是纯函数，输入输出都是普通对象：

| 函数 | 作用 |
|---|---|
| `indexStations(stations)` | 数组或字典两种站表都吃，统一成"站名 → 站点"的字典，保留站点原有字段 |
| `buildModel(data)` | 归一化整个 JSON：`stations` / `lines` / `zones` / `platformCoordLookup` / 方向表 / 换乘与快车索引 / `visible()` |
| `computeLayout(model, canvas, margin)` | 等比投影（1 度经度按 1 度纬度算长度），返回 `width` / `height` / `scale` / `project(lon, lat)` |
| `planRoute(model, layout, options)` | 每个方向一条：站点序列 → 投影点 → 平滑点 → SVG 路径 `d`（环线自动闭合） |
| `toPathData(points, closed)` | 点数组转 `M…L…`，`closed` 时补 `Z` |
| `collectStationInfo(model)` | 每站的线路颜色、快车、在建、无障碍，给 tooltip 用 |
| `buildLegend(model)` | 图例项（已按线路名排序，带对比文字色） |
| `generateSmoothPoints(points, closed, segments)` | Catmull-Rom 插值，4 点以上才动手，每段默认采 10 个点 |

跑一遍单测：

```sh
node map_view/test/mapcore.js      # 21 项，全绿才算没改坏
```

改动内核之后请**同时**看一眼两条消费路径：`metro-lang html`（静态页）和
本查看器（交互页）。两者走的是同一份代码，但序列化出来的模型字段不完全一致。

## 用法

1. 打开 `index.html`（双击即可，不需要服务器）。
2. 左上角"数据源"选一种：

   | 选项 | 什么时候用 |
   |---|---|
   | 自动识别 | 默认。`stations` 是数组 → 按 metro-lang 读；是字典 → 按编辑器旧格式读 |
   | metro-lang 解析器（JSON v2） | 数据是 `metro-lang compile` / `decompile` 写出的 JSON |
   | 地铁编辑器 JSON（旧格式） | 数据是 `metro_editor` 里 `route_data.json` 那种 |

3. 点"选择文件"选 JSON，或者把 JSON **直接拖进窗口**。也可在控制台调用
   `metroViewer.loadText(jsonText)` 喂字符串。

拿到 metro-lang 的 JSON：

```sh
make -C ..                                   # 生成 ../build/metro-lang/metro-lang
../build/metro-lang/metro-lang compile ../samples/shenzhen.m -o shenzhen.json
```

## 解释器位置

左上角"解释器位置"是 **metro-lang 可执行文件的路径**，默认
`../build/metro-lang/metro-lang`（就是源码树里 `make -C metro-lang` 的产物），
改过之后记在 `localStorage`，下次打开还在。它用在三处：

- **拖进 `.m` / `.metro` 源码时**：页面不会自己解析源码（浏览器里没有 MetroLang
  前端），而是用这个路径拼出编译命令交给你；
- **"复制编译命令"按钮**：把 `解释器 compile 源码 -o 源码.json` 复制到剪贴板；
- **宿主窗口里**（见下）：真的用它代跑一次解释器。

"选择…"按钮在浏览器里只能拿到文件名（安全限制不暴露完整路径），所以 **完整路径
请直接手填或粘贴**；在 Electron 这类会给出 `file.path` 的宿主里才能一键选中。

### 宿主桥

页面检测到 `window.chrome && window.chrome.webview` 时（metro_editor 用的
WebView2 就是这种），拖进源码会 `postMessage` 给宿主：

```js
{ type: 'metro-lang-compile', interpreter: '<解释器路径>', source: '上海.m', text: '…源码…' }
```

宿主跑完解释器，把结果发回来即可（两种都行）：

```js
// 方式一：发事件
window.chrome.webview.postMessage({ type: 'metro-lang-data', json: '…JSON 文本…' });
// 方式二：直接调页面入口
window.metroViewer.loadText('…JSON 文本…', '宿主解释器');
```

出错时回 `{ type: 'metro-lang-error', message: '…' }`，页面会把它显示在状态栏。
纯浏览器（`file://` 双击打开）里没有宿主，走"复制命令自己跑"这条路。

## 两种 JSON 的差异

| | metro-lang（v2，`metro-lang/doc/02-json-format.md`） | 编辑器旧格式 |
|---|---|---|
| `stations` | **数组**，每项 `name` / `city` / `lon` / `lat` / `otherNames` / `accessibility` | **以站名为键的字典** |
| 无障碍 | 内联在 `stations[].accessibility` | 根级 `facilities` |
| `formation` / `link` | 数组（同一线路可声明多条） | 单字符串 |
| `lines` | 字典，键为线路 ID | 字典，键为线路 ID |

`js/loader.js` 把数组站表按站名索引成字典、把数组化的 `formation` / `link` 拉平成
字符串，之后就完全走原来的绘图模型，所以两种来源画出来的图一致。

**`.m` / `.metro` 源码不能直接拖进来**：浏览器里没有 MetroLang 前端（解析器是 C++
写的）。拖源码进去会提示先用 `metro-lang compile` 转成 JSON。

## 显示范围

默认 `activeStationSet` 为空，也就是**不做任何筛选**：所有线路、所有方向、
在建（`is_future`）车站都会画出来，看到的是完整线网。查看器不提供筛选 UI，
筛选是编辑器 `edit.html` 的职责。

## 效果图怎么重新生成

`preview.svg` 不是手截的，是脚本跑出来的，**不需要装浏览器**：

```sh
cd map_view
npm i jsdom
../build/metro-lang/metro-lang compile ../samples/shenzhen.m -o /tmp/shenzhen.json
python3 tools/make_preview.py /tmp/shenzhen.json      # -> preview.svg
```

`tools/make_preview.py` 串了三步：

1. `node tools/render_preview.js` 用 jsdom 把 `index.html` / `metro_mapcore.js` /
   `app.js` / `loader.js` 原样跑一遍（d3 画图是纯 DOM 操作，不需要排版引擎），
   抠出生成的那段 `<svg>`；
   顺带把 `css/style.css` 里跟 SVG 有关的规则内联进去——少了 `.line-path{fill:none}`，
   线路会按 SVG 默认值填成黑色；
2. cairosvg 栅格化（2 倍超采样），再用 `convert -format %@` 量出非背景像素的包围盒，
   这样站名字宽也算得进去，比在 JS 里猜文本宽度靠谱；
3. 把包围盒写进 `viewBox`，`width` / `height` 按 `--scale`（默认 2）放大。裁掉空边
   之后**仍然是矢量**，放大不掉清晰度；顺手把坐标从 17 位小数压到 2 位，文件小一半。

要 PNG 就自己再 `cairosvg.svg2png` 一次；仓库里只放矢量图。

## 已知差异（都来自输入数据，不是绘图改动）

- metro-lang 的 `stations[].lines` 目前是空数组，所以站点 tooltip 里的"在建线路"
  一栏不会出现；线路颜色、方向、换乘判断都取自 `lines[].direction[]`，不受影响。
- metro-lang 的方向里没有 `segment_types` / `express_stops`（对应段类型与快车停靠），
  从编辑器 JSON 载入时这两项照常生效。
