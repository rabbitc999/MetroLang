# MetroLang —— VS Code 插件

MetroLang（`.metro` / `.m`，地铁线网数据语言）的编辑器支持：

| 能力 | 说明 | 实现 |
|---|---|---|
| 语法高亮 | 关键字（块头 / `END_*` / 参数命令 / 常量）、字符串、注释、预处理指令、数字与标点 | `syntaxes/metro.tmLanguage.json`（声明式，代码零参与） |
| 块折叠 | `*_DEFINE` / `TRANSFER_TYPE` / `POLICY` / `ATTRIBUTES` 折到对应的 `END_DEFINE` / `END_POLICY` / `END_ATTRIBUTES`；嵌套照常；一行式 `DIRECTION_DEFINE … REV …` 不带收尾、不参与配对 | `src/metroFolding.js`（纯计算，与 `metro-lang` 编译器的块栈同口径） |
| 实时诊断 | 编辑器打字即检查：服务器就是编译器本体（`metro-lang lsp`，见 [`src/lsp.cpp`](../src/lsp.cpp)），走与磁盘编译同一条预处理 + 文法管线，错误直接标在问题上 | `src/lspClient.js`（手写最小 JSON-RPC 客户端）+ 编译器内嵌 LSP |
| 地图预览 | 命令「Metro: 预览地图」：当前 `.m` / `.metro` 文档经 LSP 自定义请求 `metro/previewMap` 编译成自包含 HTML（与 `metro-lang html` 同一条渲染管线），在旁边面板打开；**保存即重绘**。另有「Metro: 从文件预览地图」，选一个模型文件就出图，不必先打开它；编译失败时面板里列错误 | `extension.js` + 编译器内嵌 LSP |
| 打开语言参考 | 命令面板「Metro: 打开 MetroLang 语言参考」，直接打开仓库里的 [`doc/01-metrolang-reference.md`](../doc/01-metrolang-reference.md) | `extension.js` |

设计取舍与 GramEditor / Magel 插件一致：**不依赖任何 npm 包**（`vscode` 由宿主提供，
LSP 客户端是手写的最小 JSON-RPC），运行时不需要构建步骤，也不需要联网。语言服务器与
编译器共用一个可执行文件：打 VSIX 时由 `tools/embed-compiler.js` 把它内嵌进 `bin/`，
装完就能用；开发期则按 设置 `metro-lang.serverPath` → 内嵌 `bin/` → 工作区
`build/metro-lang/` → PATH 的顺序找。线网数据的交互查看仍推荐
[`map_view/`](../map_view/README.md)；编辑器里的预览适合写文档时随手核对。

## 安装（开发方式）

VS Code 里「扩展 → 从 VSIX 安装」，或直接把本目录放进 `%USERPROFILE%\.vscode\extensions\`。
打包用 `vsce package`（需要 `npm i -g @vscode/vsce`）。

## 目录

```text
vscode/
├── package.json                        清单：语言、语法、命令、LSP 服务器路径配置、npm 脚本
├── extension.js                        入口：折叠 provider、LSP 生命周期、地图预览命令
├── metro-language-configuration.json   `#` 行注释、括号/引号自动闭合、整词规则
├── syntaxes/metro.tmLanguage.json      TextMate 语法（高亮）
├── src/metroFolding.js                 折叠配对（纯计算，可单独测）
├── src/lspClient.js                    最小 LSP 客户端（stdio JSON-RPC，纯 Node 可跑）
├── src/locator.js                      找编译器：设置 → 内嵌 bin/ → 工作区 build/ → PATH
├── tools/embed-compiler.js             打包前把编译器复制进 bin/（内嵌）
├── tools/check-manifest.js             清单自检（语言/语法/命令/图标/内嵌二进制）
├── tools/package.js                    一条龙打包：内嵌 → 自检 → 测试 → vsce
├── icon.png                            插件图标（tools/make_icon.py 生成）
├── test/smoke.js                       Node 直跑的冒烟测试（不需要 VS Code）
└── test/lsp.js                         LSP 端到端测试：真服务器 + 地图预览
```

## 打包（npm）

照搬 Magel 的做法：**编译器内嵌进 VSIX**，装完即用，不需要用户先构建工具链。

```sh
cd vscode
npm install            # 只装 @vscode/vsce（本地优先，没装就退回 npx）
npm run package        # 内嵌编译器 → 清单自检 → 冒烟 + LSP 测试 → vsce package
```

产物：`vscode/dist/metro-lang-editor-<版本>.vsix`，安装：

```sh
code --install-extension vscode/dist/metro-lang-editor-1.0.0.vsix
```

可用的开关：

| 命令 | 作用 |
|---|---|
| `npm run embed` | 只把 `build/metro-lang/metro-lang(.exe)` 复制进 `bin/`（`--from <路径>` / `METRO_LANG_BIN` 可指定源） |
| `npm run check` | 只跑清单自检 |
| `npm test` | 冒烟 + LSP 端到端 |
| `npm run package -- --skip-tests` | 跳过测试直接打包 |
| `node tools/package.js --dry-run` | 只打印要跑的命令 |

`vsce package` 由 `vscode:prepublish` 钩子再自动跑一次内嵌，所以单独用 `vsce` 也不会漏掉编译器。
`bin/`、`node_modules/`、`dist/` 都不进版本库（见仓库根 `.gitignore`）。
