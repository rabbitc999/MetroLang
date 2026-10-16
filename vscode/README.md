# MetroLang —— VS Code 插件

MetroLang（`.metro` / `.m`，地铁线网数据语言）的编辑器支持：

| 能力 | 说明 | 实现 |
|---|---|---|
| 语法高亮 | 关键字（块头 / `END_*` / 参数命令 / 常量）、字符串、注释、预处理指令、数字与标点 | `syntaxes/metro.tmLanguage.json`（声明式，代码零参与） |
| 块折叠 | `*_DEFINE` / `TRANSFER_TYPE` / `POLICY` / `ATTRIBUTES` 折到对应的 `END_DEFINE` / `END_POLICY` / `END_ATTRIBUTES`；嵌套照常；一行式 `DIRECTION_DEFINE … REV …` 不带收尾、不参与配对 | `src/metroFolding.js`（纯计算，与 `metro-lang` 编译器的块栈同口径） |
| 实时诊断 | 编辑器打字即检查：服务器就是编译器本体（`metro-lang lsp`，见 [`src/lsp.cpp`](../src/lsp.cpp)），走与磁盘编译同一条预处理 + 文法管线，错误直接标在问题上 | `src/lspClient.js`（手写最小 JSON-RPC 客户端）+ 编译器内嵌 LSP |
| 地图预览 | 命令「Metro: 预览地图（编译当前文档）」：当前文档经 LSP 自定义请求 `metro/previewMap` 编译成自包含 HTML（与 `metro-lang html` 同一条渲染管线），在旁边面板打开；编译失败时面板里列错误 | `extension.js` + 编译器内嵌 LSP |
| 打开语言参考 | 命令面板「Metro: 打开 MetroLang 语言参考」，直接打开仓库里的 [`doc/01-metrolang-reference.md`](../doc/01-metrolang-reference.md) | `extension.js` |

设计取舍与 GramEditor / Magel 插件一致：**不依赖任何 npm 包**（`vscode` 由宿主提供，
LSP 客户端是手写的最小 JSON-RPC），不需要构建步骤，也不需要联网。语言服务器与
编译器共用一个可执行文件：先在仓库根 `make` 出 `build/metro-lang/metro-lang(.exe)`，
或用设置 `metro-lang.serverPath` 指到别处编好的二进制。线网数据的交互查看仍推荐
[`map_view/`](../map_view/README.md)；编辑器里的预览适合写文档时随手核对。

## 安装（开发方式）

VS Code 里「扩展 → 从 VSIX 安装」，或直接把本目录放进 `%USERPROFILE%\.vscode\extensions\`。
打包用 `vsce package`（需要 `npm i -g @vscode/vsce`）。

## 目录

```text
vscode/
├── package.json                        清单：语言、语法、命令、LSP 服务器路径配置
├── extension.js                        入口：折叠 provider、LSP 生命周期、地图预览命令
├── metro-language-configuration.json   `#` 行注释、括号/引号自动闭合、整词规则
├── syntaxes/metro.tmLanguage.json      TextMate 语法（高亮）
├── src/metroFolding.js                 折叠配对（纯计算，可单独测）
├── src/lspClient.js                    最小 LSP 客户端（stdio JSON-RPC，纯 Node 可跑）
├── icon.png                            插件图标（tools/make_icon.py 生成）
├── test/smoke.js                       Node 直跑的冒烟测试（不需要 VS Code）
└── test/lsp.js                         LSP 端到端测试：真服务器 + 地图预览
```

## 测试

```sh
node vscode/test/smoke.js    # 在仓库根跑：验证折叠配对与清单字段
node vscode/test/lsp.js      # 验证 LSP 诊断与地图预览（需先 make）
```
