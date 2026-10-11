'use strict';

/**
 * MetroLang VS Code 插件入口。
 *
 * 只做 MetroLang（`.metro` / `.m`）这一门语言的两件本地能力：
 *   1. **语法高亮**：由 `syntaxes/metro.tmLanguage.json` 声明式提供，代码零参与；
 *   2. **块折叠**：块头（`*_DEFINE` / `TRANSFER_TYPE` / `POLICY` / `ATTRIBUTES`）折到
 *      对应的收尾（`END_DEFINE` / `END_POLICY` / `END_ATTRIBUTES`），配对逻辑在
 *      `src/metroFolding.js`（纯计算，不引用 `vscode`，可单独测）。
 *
 * 设计取舍：
 *   - 不依赖任何 npm 包（`vscode` 由宿主提供），因此不需要构建步骤，也不需要联网；
 *   - MetroLang 没有语言服务器（前端是 C++ 写的 `metro-lang`，不是 LSP），所以这里
 *     不做诊断 / 补全 / 跳转，只提供高亮与折叠；
 *   - 另有一个命令，在编辑器里打开本项目的语言参考 `doc/01-metrolang-reference.md`。
 */

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');

const metroFolding = require('./src/metroFolding');

/** 语言 id，与 package.json 里的 contributes.languages 保持一致。 */
const LANGUAGE_ID = 'metro-lang';

/** `.metro` / `.m` 的选择器：磁盘文件与未命名文档都支持。 */
const SELECTOR = [
  { language: LANGUAGE_ID, scheme: 'file' },
  { language: LANGUAGE_ID, scheme: 'untitled' },
];

/** @type {vscode.OutputChannel|null} 输出面板（错误提示用）。 */
let outputChannel = null;

/**
 * 插件激活：注册折叠 provider 与命令。
 *
 * @param {vscode.ExtensionContext} context 扩展上下文。
 */
function activate(context) {
  outputChannel = vscode.window.createOutputChannel('MetroLang');
  context.subscriptions.push(outputChannel);

  // 1. 块折叠：`.metro` / `.m` 的 `*_DEFINE` → `END_*` 配对。
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(SELECTOR, {
      /**
       * 文档折叠区间。
       *
       * @param {vscode.TextDocument} document 文档。
       * @returns {vscode.FoldingRange[]} 折叠区间。
       */
      provideFoldingRanges: (document) => {
        const lines = [];
        for (let index = 0; index < document.lineCount; index++) {
          lines.push(document.lineAt(index).text);
        }
        return metroFolding
          .planFoldingRanges(lines)
          .map((block) => ({ start: block.start, end: block.end }));
      },
    }),
  );

  // 2. 命令：打开语言参考。
  context.subscriptions.push(
    vscode.commands.registerCommand('metro.openDoc', () => openLanguageReference()),
  );
}

/** 插件停用：没有常驻资源要释放。 */
function deactivate() {}

/**
 * 打开本项目的 MetroLang 语言参考。
 *
 * 文档就在插件旁边的 `doc/01-metrolang-reference.md`（插件目录是仓库根的 `vscode/`，
 * 所以参考文档在 `../doc/`）。定位失败给一次提示，不抛。
 */
async function openLanguageReference() {
  const docPath = path.join(__dirname, '..', 'doc', '01-metrolang-reference.md');
  if (!fs.existsSync(docPath)) {
    const message = `MetroLang：没找到 ${docPath}`;
    if (outputChannel) outputChannel.appendLine(message);
    void vscode.window.showWarningMessage(message);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(docPath));
  await vscode.window.showTextDocument(doc, { preview: true });
}

module.exports = {
  activate,
  deactivate,
  // 供测试直接使用（纯函数，不依赖 vscode）。
  planFoldingRanges: metroFolding.planFoldingRanges,
};
