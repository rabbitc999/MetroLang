# 语言服务器：诊断与语义提示

`metro-lang lsp` 就是编译器本体的一个子命令——**没有第二个可执行文件**。它通过 stdio
收发 LSP（JSON-RPC 2.0 + `Content-Length` 帧），把编译前端的能力暴露给编辑器。

## 1. 启动与握手

```sh
metro-lang lsp            # stdin/stdout 走协议，日志走 stderr
```

`initialize` 返回的能力：

| 能力 | 值 | 说明 |
|---|---|---|
| `textDocumentSync` | `1`（Full） | 每次改动全文重发，实现最省心 |
| `hoverProvider` | `true` | 悬停显示类型与说明，`contentFormat: markdown` |
| `definitionProvider` | `true` | 跳转到标识符定义处 |
| `documentSymbolProvider` | `true` | 文档大纲（块头 + 关键字段） |
| `completionProvider` | `true` | 触发字符为空格与单引号；补全站名、线路 ID、方向 ID、关键字 |

`serverInfo.version` 跟二进制版本同步。

## 2. 诊断

`textDocument/didOpen` / `didChange` 之后，服务器编译当前文本并把错误按
`Diagnostic` 推回（`textDocument/publishDiagnostics`）。诊断来自与 `check` 命令**同一套**
语义层，所以命令行报的错和编辑器里看到的完全一致，包括行号与列号（列按 UTF-8 字节
换算成 LSP 的 UTF-16 码元）。

编译失败时**不会清空**上一次成功的模型：索引与语义提示继续基于旧模型工作，
这样打字中途的语法错误不会让整个文件失去 hover。

## 3. 语义提示（标识符预览）

核心是 `SourceIndex`（`src/lsp_index.cpp`）：一行一行切词，记录每个词素的
**种类 / 名字 / 签名 / 说明 / 位置 / 是否定义处**。

### 3.1 索引哪些东西

| 种类 | 来源写法 |
|---|---|
| 线路 | `LINE_DEFINE G1` / `LINE_MODIFY` / `LINE_TEMPLATE` |
| 车站 | `STATION_DEFINE` 块里的 `NODE '甲站'` / `STATION_MODIFY` |
| 方向 | `DIRECTION_DEFINE G1_0` / `DIRECTION_MODIFY` |
| 运营参数 | `ENTRY_TIME` / `TRANSFER_TIME` / `DWELL_TIME` … |
| 票价参数 | `DEFAULT_FARE` / `SEGMENT` / `LINEAR_EXTENSION` … |
| 运营规则块 | `HEADWAY_PROFILE` / `CROWD_PROFILE` / `DWELL_TIME_DEFINE` / `SPEED_LIMIT_DEFINE` |

其余词素按「站名 / 线路 ID / 方向 ID」记为**引用**，靠名字回查定义。

### 3.2 悬停

`textDocument/hover` 返回 markdown，形如：

```text
**线路**　`LINE_DEFINE G1`

名称：1号线
颜色：#E4002B
最高速度：80 km/h
车型：6A
```

车站会额外给出坐标与所属线路数，运营参数会给出**当前值**与单位
（例如 `ENTRY_TIME = 120 秒（2 分 0 秒）`）。悬停在引用处与定义处得到的信息一致，
只是标题会标注"（定义于第 N 行）"。

### 3.3 跳转定义

`textDocument/definition` 返回所有同名定义位置（数组）。同名多义时按
「距离最近 + 优先定义处」排序，第一条通常就是用户想看的那个。

### 3.4 文档大纲

`textDocument/documentSymbol` 把块结构摊平成平铺列表：线路 / 车站 / 方向 / 运营参数 /
票价分段都在里面，`kind` 分别是 `Class` / `Field` / `Namespace` / `Constant` / `Property`。
编辑器侧显示为可折叠大纲，点一下直接跳过去。

### 3.5 补全

`textDocument/completion` 在任意位置给出：已定义的车站名（带引号形态）、线路 ID、
方向 ID、常用关键字。触发器是空格与单引号，所以 `STATIONS '` 之后立刻能列出站名。

## 4. 自定义请求

除了标准 LSP，服务器还接受三个私有请求，供插件与查看器直接调用。

### `metro/previewMap`

```jsonc
// 请求
{ "textDocument": { "uri": "file:///x.metro" } }
// 结果
{ "ok": true, "html": "<!DOCTYPE html>…", "stations": 465, "lines": 23 }
```

把当前编辑器里的**最新文本**重新编译并渲染成自包含 HTML 地图（与 `metro-lang html`
同一份渲染内核）。编译失败时返回 `{ok:false, error}`。

### `metro/route`

```jsonc
// 请求
{ "textDocument": { "uri": "file:///x.metro" }, "from": "广州南站", "to": "机场南(T1)" }
// 结果
{
  "ok": true,
  "guidance": "在【广州南站】上车，先乘坐开往嘉禾望岗方向的2号线……",
  "distanceKm": 47.2,
  "totalSeconds": 3876.5,
  "fare": 9,
  "transfers": 1,
  "lines": ["2号线（开往 嘉禾望岗）  广州南站 → 嘉禾望岗  23 站 / 30.38 km", "…"]
}
```

站名不存在时返回 `{ok:false, error:"找不到起点站：…"}`，而不是协议层错误——
这样客户端可以把它当普通结果渲染。

### `metro/dataSummary`

```jsonc
{ "ok": true, "rows": [["主城市","广州"], ["线路","23"], ["车站","465"], …] }
```

14 行统计：主城市、线路、车站、有坐标的站、方向、换乘规则、运营时间、发车间隔表、
拥挤度表、停站覆盖、区间限速、特殊线路票价、票价阶梯、未建模块。
`rows` 是 `[标签, 值]` 二元数组，直接铺成表格即可。

## 5. VS Code 插件

`vscode/` 下的插件把上面这些接成命令：

| 命令 | 走哪条路 |
|---|---|
| `Metro: 预览地图` | 当前 `.m` / `.metro` 文档 → `metro/previewMap` → 打开 Webview，**保存即重绘** |
| `Metro: 从文件预览地图` | 选一个 `.m` / `.metro` → 同上；不必先把它打开成活动编辑器 |
| `Metro: 数据预览（统计摘要）` | `metro/dataSummary` → Webview 表格 |
| `Metro: 查询路线（起终点 → 耗时票价）` | `metro/route` → 输出面板 |

预览**不要求**先选数据文件、也不要求配解释器路径：编译器已经内嵌在插件里
（`bin/metro-lang`，`vsce package` 时由 `tools/embed-compiler.js` 自动放进去），
`metro/previewMap` 直接把当前缓冲区的文本编成自包含 HTML。焦点移到预览面板后
`activeTextEditor` 会变空，插件用"最近激活过的模型文档"兜底，不用回来点一下源码。

hover / 跳转定义 / 大纲 / 补全由 VS Code 原生的 LSP 通道处理，插件只负责
`registerHoverProvider` 等三个 provider 的转发（服务端算，客户端只做位置换算）。

## 6. Windows 上的两个坑

1. **argv 编码**：Windows 控制台按本地代码页传参，中文站名会变成乱码。主程序统一用
   `GetCommandLineW` + `CommandLineToArgvW` + `WideCharToMultiByte(CP_UTF8)` 重新取参，
   并 `SetConsoleOutputCP(CP_UTF8)`。
2. **产物名**：Windows 下是 `metro-lang.exe`。脚本里一律写成 `./build/metro-lang/metro-lang`
   （带 `./`），这样 Git Bash / MSYS 能自动补 `.exe`，也不会被当成 PATH 查找。
