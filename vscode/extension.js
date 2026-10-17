'use strict';

/**
 * MetroLang VS Code 插件入口。
 *
 * 三块本地能力，全部围绕**编译器本体**这一个可执行文件：
 *   1. **语法高亮**：由 `syntaxes/metro.tmLanguage.json` 声明式提供，代码零参与；
 *   2. **诊断（LSP）**：起一个 `metro-lang lsp`（编译器内嵌的语言服务器），
 *      编辑器打字 → publishDiagnostics，错误直接标在问题上；
 *   3. **地图预览**：命令 `metro.previewMap` 把当前文档经 LSP 的自定义请求
 *      `metro/previewMap` 编译成自包含 HTML（与 `metro-lang html` 同一条
 *      渲染管线），放进 Webview 面板实时查看。
 *
 * 设计取舍：
 *   - 不依赖任何 npm 包（`vscode` 由宿主提供，LSP 客户端是 `src/lspClient.js`
 *     手写的最小 JSON-RPC），不需要构建步骤，也不需要联网；
 *   - 服务器就是编译器：`bin/metro-lang(.exe)`（打 VSIX 时内嵌的那份），
 *     其次工作区 `build/metro-lang/`，最后 PATH；也可用设置
 *     `metro-lang.serverPath` 显式指定；
 *   - 块折叠沿用 `src/metroFolding.js`（纯计算，不引用 `vscode`）。
 */

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');

const metroFolding = require('./src/metroFolding');
const { LspClient } = require('./src/lspClient');
const locator = require('./src/locator');

/** 语言 id，与 package.json 里的 contributes.languages 保持一致。 */
const LANGUAGE_ID = 'metro-lang';

/** `.metro` / `.m` 的选择器：磁盘文件与未命名文档都支持。 */
const SELECTOR = [
  { language: LANGUAGE_ID, scheme: 'file' },
  { language: LANGUAGE_ID, scheme: 'untitled' },
];

/** @type {vscode.OutputChannel|null} 输出面板（LSP 日志与错误提示用）。 */
let outputChannel = null;

/** @type {LspClient|null} 当前的 `metro-lang lsp` 客户端。 */
let client = null;

/** @type {vscode.DiagnosticCollection|null} 诊断集合。 */
let diagnostics = null;

/** @type {Set<string>} 已同步给服务器的文档 URI。 */
let opened = new Set();

/** @type {vscode.WebviewPanel|null} 地图预览面板（复用，避免越开越多）。 */
let previewPanel = null;

/** 启动选项：服务器路径由 locator 决定，其余默认。 */
function clientOptions() {
  return { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath };
}

/**
 * 解析 `metro-lang` 可执行文件：设置 → 扩展内嵌 bin/ → 工作区 build/ → PATH。
 *
 * @returns {{server: string|null, source: string}} 可执行文件与来源说明。
 */
function locateServer() {
  const configured = vscode.workspace.getConfiguration('metro-lang').get('serverPath');
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return locator.resolveServer(workspaceDir, configured, __dirname);
}

/**
 * 启动（或重启）`metro-lang lsp`，并把当前打开的文档同步过去。
 */
async function startServer() {
  const { server: bin, source } = locateServer();
  if (!bin) {
    const message = `MetroLang：找不到 metro-lang 可执行文件（${source}）。`
      + '先在仓库根 `make`，或把设置 `metro-lang.serverPath` 指到编译好的二进制。';
    outputChannel.appendLine(message);
    void vscode.window.showWarningMessage(message);
    return;
  }
  outputChannel.appendLine(`[lsp] 启动 ${bin} lsp（来源：${source}）`);

  const instance = new LspClient(bin, ['lsp'], clientOptions());
  instance.on('log', (line) => outputChannel.appendLine(`[lsp:stderr] ${line}`));
  instance.on('exit', (code) => {
    outputChannel.appendLine(`[lsp] 服务器退出（code=${code}）`);
    if (client === instance) client = null;
  });
  instance.on('diagnostics', ({ uri, diagnostics: items }) => {
    diagnostics.set(vscode.Uri.parse(uri), items.map(toVscodeDiagnostic));
  });

  try {
    await instance.start();
    await instance.initialize();
  } catch (error) {
    outputChannel.appendLine(`[lsp] 启动失败：${error.message}`);
    void vscode.window.showErrorMessage(`MetroLang：语言服务器启动失败（${error.message}）`);
    return;
  }

  client = instance;
  opened = new Set();

  // 把编辑器里已打开的文档同步给新服务器，别让用户重开一遍。
  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === LANGUAGE_ID) syncOpen(document);
  }
}

/** 停掉当前服务器并清空诊断。 */
async function stopServer() {
  if (client) {
    const instance = client;
    client = null;
    await instance.stop().catch(() => {});
  }
  diagnostics.clear();
}

/**
 * didOpen / didChange：把文档全文推给服务器（全量同步）。
 *
 * @param {vscode.TextDocument} document 文档。
 */
function syncOpen(document) {
  if (!client || !client.running) return;
  const uri = document.uri.toString();
  if (opened.has(uri)) {
    // 已同步过：走 didChange 全量同步。
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: document.version },
      contentChanges: [{ text: document.getText() }],
    });
    return;
  }
  opened.add(uri);
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: LANGUAGE_ID, version: document.version, text: document.getText() },
  });
}

/** didClose：让服务器清掉状态与诊断。 @param {vscode.Uri} uri 文档 URI。 */
function syncClose(uri) {
  if (!client || !client.running) return;
  opened.delete(uri.toString());
  client.notify('textDocument/didClose', { textDocument: { uri: uri.toString() } });
  diagnostics.delete(uri);
}

/**
 * LSP 诊断 → VS Code 诊断。
 *
 * @param {any} item LSP 诊断项。
 * @returns {vscode.Diagnostic} 编辑器诊断。
 */
function toVscodeDiagnostic(item) {
  const start = new vscode.Position(item.range.start.line, item.range.start.character);
  const end = new vscode.Position(item.range.end.line, item.range.end.character);
  const severity = item.severity === 2 ? vscode.DiagnosticSeverity.Warning
    : item.severity === 3 ? vscode.DiagnosticSeverity.Information
    : item.severity === 4 ? vscode.DiagnosticSeverity.Hint
    : vscode.DiagnosticSeverity.Error;
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(start, end), item.message || '未知错误', severity);
  diagnostic.source = item.source || 'metro-lang';
  diagnostic.code = item.code;
  return diagnostic;
}

/**
 * 打开（或刷新）地图预览面板。
 *
 * 当前文档经 LSP 的 `metro/previewMap` 编译成自包含 HTML；编译失败时
 * 面板里列出错误，不弹窗打断。
 */
async function previewMap() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE_ID) {
    void vscode.window.showWarningMessage('MetroLang：先把一个 .metro 文档设为活动编辑器。');
    return;
  }
  const document = editor.document;
  if (!client || !client.running) {
    await startServer();
  }
  if (!client || !client.running) return;

  // 未打开过的文档先补一次 didOpen，服务器端才有内容。
  syncOpen(document);

  let result;
  try {
    result = await client.request('metro/previewMap', {
      textDocument: { uri: document.uri.toString() },
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`MetroLang：地图预览失败（${error.message}）`);
    return;
  }
  if (!result || !result.ok) {
    const lines = (result && result.errors ? result.errors : ['未知错误']).join('\n');
    showPreviewHtml(`<!doctype html><meta charset="utf-8"><title>MetroLang 地图预览</title>
      <body style="font-family: sans-serif; background: #faf7fa; color: #333; padding: 24px;">
      <h2>编译失败，暂时出不了图</h2><pre style="white-space: pre-wrap;">${escapeHtml(lines)}</pre></body>`);
    return;
  }
  showPreviewHtml(result.html);
  outputChannel.appendLine(`[preview] ${document.fileName} → ${result.html.length} 字节`);
}

/**
 * 显示（或复用）预览面板。
 *
 * @param {string} html 面板内容。
 */
function showPreviewHtml(html) {
  if (previewPanel) {
    previewPanel.webview.html = html;
    previewPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  previewPanel = vscode.window.createWebviewPanel(
    'metroPreview', 'MetroLang 地图预览', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  previewPanel.webview.html = html;
  previewPanel.onDidDispose(() => { previewPanel = null; }, null, []);
}

/** @param {string} text 待转义的文本。 @returns {string} HTML 转义结果。 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 插件激活：注册折叠 provider、诊断与命令。
 *
 * @param {vscode.ExtensionContext} context 扩展上下文。
 */
function activate(context) {
  outputChannel = vscode.window.createOutputChannel('MetroLang');
  context.subscriptions.push(outputChannel);
  diagnostics = vscode.languages.createDiagnosticCollection('metro-lang');
  context.subscriptions.push(diagnostics);

  // 1. 块折叠：`.metro` / `.m` 的 `*_DEFINE` → `END_*` 配对。
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(SELECTOR, {
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

  // 2. LSP：激活即起服务器，文档开/改/关全量同步，诊断走推送。
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === LANGUAGE_ID) syncOpen(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === LANGUAGE_ID) syncOpen(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === LANGUAGE_ID) syncClose(document.uri);
    }),
  );
  void startServer();

  // 3. 命令。
  context.subscriptions.push(
    vscode.commands.registerCommand('metro.openDoc', () => openLanguageReference()),
    vscode.commands.registerCommand('metro.previewMap', () => previewMap()),
    vscode.commands.registerCommand('metro.restartServer', async () => {
      await stopServer();
      await startServer();
      void vscode.window.showInformationMessage('MetroLang：语言服务器已重启。');
    }),
  );
}

/** 插件停用：关服务器、释放面板。 */
function deactivate() {
  void stopServer();
}

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
