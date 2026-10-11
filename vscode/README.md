# MetroLang —— VS Code 插件

MetroLang（`.metro` / `.m`，地铁线网数据语言）的编辑器支持：

| 能力 | 说明 | 实现 |
|---|---|---|
| 语法高亮 | 关键字（块头 / `END_*` / 参数命令 / 常量）、字符串、注释、预处理指令、数字与标点 | `syntaxes/metro.tmLanguage.json`（声明式，代码零参与） |
| 块折叠 | `*_DEFINE` / `TRANSFER_TYPE` / `POLICY` / `ATTRIBUTES` 折到对应的 `END_DEFINE` / `END_POLICY` / `END_ATTRIBUTES`；嵌套照常；一行式 `DIRECTION_DEFINE … REV …` 不带收尾、不参与配对 | `src/metroFolding.js`（纯计算，与 `metro-lang` 编译器的块栈同口径） |
| 打开语言参考 | 命令面板「Metro: 打开 MetroLang 语言参考」，直接打开仓库里的 [`doc/01-metrolang-reference.md`](../doc/01-metrolang-reference.md) | `extension.js` |

设计取舍与 GramEditor / Magel 插件一致：**不依赖任何 npm 包**（`vscode` 由宿主提供），
不需要构建步骤，也不需要联网。MetroLang 前端是 C++ 写的 `metro-lang` 可执行文件、
不是 LSP 服务器，所以本插件不做诊断 / 补全 / 跳转——线网数据用
[`map_view/`](../map_view/README.md) 的交互式查看器看更合适。

## 安装（开发方式）

VS Code 里「扩展 → 从 VSIX 安装」，或直接把本目录放进 `%USERPROFILE%\.vscode\extensions\`。
打包用 `vsce package`（需要 `npm i -g @vscode/vsce`）。

## 目录

```text
vscode/
├── package.json                        清单：语言、语法、命令、默认配置
├── extension.js                        入口：注册折叠 provider 与命令
├── metro-language-configuration.json   `#` 行注释、括号/引号自动闭合、整词规则
├── syntaxes/metro.tmLanguage.json      TextMate 语法（高亮）
├── src/metroFolding.js                 折叠配对（纯计算，可单独测）
├── icon.png                            插件图标（tools/make_icon.py 生成）
└── test/smoke.js                       Node 直跑的冒烟测试（不需要 VS Code）
```

## 冒烟测试

```sh
node vscode/test/smoke.js     # 在仓库根跑：验证折叠配对与清单字段
```
