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

/** @type {vscode.TextDocument|null} 最近一次激活过的模型文档（面板夺焦时兜底）。 */
let lastMetroDocument = null;

/** @type {string} 预览面板当前展示的文档 URI；保存自动重绘只认它。 */
let previewSourceUri = '';

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
 * 当前上下文里的模型文档：活动编辑器优先，否则取最近一次激活过的 `.m` / `.metro`。
 *
 * 预览面板常驻在侧边、焦点在面板上时 `activeTextEditor` 是空的，
 * 这时用 `lastMetroDocument` 兜底，免得用户还要回来点一下源码。
 *
 * @return {vscode.TextDocument|null} 模型文档。
 */
function activeMetroDocument() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === LANGUAGE_ID) {
    lastMetroDocument = editor.document;
    return editor.document;
  }
  return lastMetroDocument || null;
}

/**
 * 「预览地图」：编辑器标题栏按钮会传入 `uri`，命令面板则是空的。
 *
 * 传了 uri 就用它——标题栏按钮上那张图，本来就该渲染它对应的文件，
 * 不能靠 `activeTextEditor` 猜（焦点在预览面板时不代表"当前文档"）。
 *
 * @param {vscode.Uri|{fsPath?: string, path?: string}|undefined} target 目标文件。
 */
async function previewMap(target) {
  let document = null;
  const uri = target instanceof vscode.Uri ? target
    : (target && typeof target === 'object' && (target.fsPath || target.path))
      ? vscode.Uri.file(target.fsPath || target.path)
      : null;

  if (uri) {
    const open = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString());
    document = open || await vscode.workspace.openTextDocument(uri);
  } else {
    document = activeMetroDocument();
  }

  if (!document) {
    void vscode.window.showWarningMessage(
      'MetroLang：当前编辑器不是 .metro / .m 文档。切到模型文件再预览，'
      + '或者用「MetroLang: 从文件预览地图」显式选一个。');
    return;
  }
  await previewDocument(document);
}

/**
 * 从文件预览：不依赖当前活动编辑器，直接挑一个 `.m` / `.metro` 出图。
 *
 * 命令行 `metro-lang html x.m` 的等价入口。用对话框只是为了"选源文件"，
 * 不要求先把它打开成活动编辑器——预览窗口可以在旁边，源码可以不开。
 */
async function previewMapFromFile() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: '预览地图',
    filters: { 'MetroLang 模型': ['m', 'metro', 'txt'] },
  });
  if (!picked || picked.length === 0) return;
  const uri = picked[0];
  const document = await vscode.workspace.openTextDocument(uri);
  await previewDocument(document);
}

/**
 * 指定文档渲染成预览面板（不要求它是活动编辑器）。
 *
 * @param {vscode.TextDocument} document 模型文档。
 */
async function previewDocument(document) {
  // 标题栏按钮/文件对话框拿到的文档可能还没被语言关联（`.txt` 之类），
  // 所以按扩展名再放行一次，而不是只认 languageId。
  const looksLikeModel = document && /\.(m|metro)$/i.test(document.fileName || '');
  if (!document || (document.languageId !== LANGUAGE_ID && !looksLikeModel)) {
    void vscode.window.showWarningMessage('MetroLang：这个文件不是 .metro / .m 模型。');
    return;
  }
  if (!client || !client.running) await startServer();
  if (!client || !client.running) return;
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
  previewSourceUri = document.uri.toString();
  showMapResult(result, document);
}

/**
 * 把 `metro/previewMap` 的结果塞进面板：成功画图，失败把诊断列出来。
 *
 * @param {any} result LSP 响应。
 * @param {vscode.TextDocument} document 源文档（只用于面板标题与日志）。
 */
function showMapResult(result, document) {
  if (!result || !result.ok) {
    const lines = (result && result.errors ? result.errors : ['未知错误']).join('\n');
    showPreviewHtml(`<!doctype html><meta charset="utf-8"><title>MetroLang 地图预览</title>
      <body style="font-family: sans-serif; background: #faf7fa; color: #333; padding: 24px;">
      <h2>编译失败，暂时出不了图</h2><pre style="white-space: pre-wrap;">${escapeHtml(lines)}</pre></body>`,
      document ? document.fileName : undefined);
    return;
  }
  showPreviewHtml(result.html, document ? document.fileName : undefined);
  outputChannel.appendLine(`[preview] ${document.fileName} → ${result.html.length} 字节`);
}

/**
 * 显示（或复用）预览面板。
 *
 * 标题带源文件名（`MetroLang 预览 — nanjing.m`）：预览面板常驻侧边，
 * 不写清是谁，很容易对着一张旧图找半天原因。
 *
 * @param {string} html 面板内容。
 * @param {string} [fileName] 源文档文件名，仅用于标题。
 */
function showPreviewHtml(html, fileName) {
  const title = 'MetroLang 预览' + (fileName ? ' — ' + fileName.replace(/^.*[\\/]/, '') : '');
  if (previewPanel) {
    previewPanel.title = title;
    previewPanel.webview.html = html;
    previewPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  previewPanel = vscode.window.createWebviewPanel(
    'metroPreview', title, vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  previewPanel.webview.html = html;
  previewPanel.onDidDispose(() => { previewPanel = null; }, null, []);
}

/** @param {string} text 待转义的文本。 @returns {string} HTML 转义结果。 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** LSP Position → VS Code Position。 @param {any} position LSP 位置。 @returns {vscode.Position} 编辑器位置。 */
function toPosition(position) {
  return new vscode.Position(position.line, position.character);
}

/**
 * 确认文档已同步给服务器；没同步过就补一次 didOpen。
 *
 * @param {vscode.TextDocument} document 文档。
 * @returns {boolean} 服务器可用时返回 true。
 */
function ensureSynced(document) {
  if (!client || !client.running) return false;
  const uri = document.uri.toString();
  if (!opened.has(uri)) syncOpen(document);
  return true;
}

/**
 * 悬停：服务器把光标下的标识符解析成模型实体（线路 / 车站 / 方向 / 运营参数），
 * 返回签名 + 属性说明 + 定义位置。
 *
 * @param {vscode.TextDocument} document 文档。
 * @param {vscode.Position} position 光标位置。
 * @returns {Promise<vscode.Hover|null>} 悬停内容。
 */
async function provideHover(document, position) {
  if (!ensureSynced(document)) return null;
  let result;
  try {
    result = await client.request('textDocument/hover', {
      textDocument: { uri: document.uri.toString() },
      position: { line: position.line, character: position.character },
    });
  } catch {
    return null;
  }
  if (!result || !result.contents) return null;

  const value = typeof result.contents === 'string' ? result.contents : result.contents.value;
  if (!value) return null;
  const markdown = new vscode.MarkdownString(value);
  markdown.isTrusted = false;

  const range = result.range
    ? new vscode.Range(toPosition(result.range.start), toPosition(result.range.end))
    : undefined;
  return new vscode.Hover(markdown, range);
}

/**
 * 跳转到定义：服务器给出本文档里同名定义所在的行列。
 *
 * @param {vscode.TextDocument} document 文档。
 * @param {vscode.Position} position 光标位置。
 * @returns {Promise<vscode.Location[]|null>} 定义位置列表。
 */
async function provideDefinition(document, position) {
  if (!ensureSynced(document)) return null;
  let result;
  try {
    result = await client.request('textDocument/definition', {
      textDocument: { uri: document.uri.toString() },
      position: { line: position.line, character: position.character },
    });
  } catch {
    return null;
  }
  if (!Array.isArray(result) || result.length === 0) return null;
  return result.map((item) => new vscode.Location(
    vscode.Uri.parse(item.uri),
    new vscode.Range(toPosition(item.range.start), toPosition(item.range.end)),
  ));
}

/**
 * 大纲：服务器把「线路 / 车站 / 方向 / 运营参数」的定义列成符号表。
 *
 * @param {vscode.TextDocument} document 文档。
 * @returns {Promise<vscode.SymbolInformation[]>} 符号列表。
 */
async function provideSymbols(document) {
  if (!ensureSynced(document)) return null;
  let result;
  try {
    result = await client.request('textDocument/documentSymbol', {
      textDocument: { uri: document.uri.toString() },
    });
  } catch {
    return null;
  }
  if (!Array.isArray(result) || result.length === 0) return null;
  return result.map((item) => {
    const selection = new vscode.Range(toPosition(item.selectionRange.start), toPosition(item.selectionRange.end));
    const range = item.range
      ? new vscode.Range(toPosition(item.range.start), toPosition(item.range.end))
      : selection;
    return new vscode.SymbolInformation(
      item.name,
      symbolKind(item.kind),
      item.detail || '',
      new vscode.Location(document.uri, range),
    );
  });
}

/**
 * LSP 的 SymbolKind 数值 → VS Code 的 SymbolKind。
 *
 * @param {number} kind LSP 符号种类。
 * @returns {vscode.SymbolKind} 编辑器符号种类。
 */
function symbolKind(kind) {
  const table = {
    5: vscode.SymbolKind.Class,
    12: vscode.SymbolKind.Function,
    13: vscode.SymbolKind.Variable,
    14: vscode.SymbolKind.Constant,
    23: vscode.SymbolKind.Struct,
  };
  return table[kind] || vscode.SymbolKind.Variable;
}

/**
 * 路线查询：让用户输入起终点，服务器算出行程后在输出面板里列出来。
 *
 * 与 `metro-lang route` 完全一致（同一个 `planRoute`）；用命令而不是内嵌表单，
 * 是为了不引人额外的 UI 依赖——需要图形化的人走「数据预览」。
 */
async function queryRoute() {
  const document = activeMetroDocument();
  if (!document) {
    void vscode.window.showWarningMessage('MetroLang：先把一个 .metro 文档设为活动编辑器。');
    return;
  }
  if (!client || !client.running) await startServer();
  if (!client || !client.running) return;
  syncOpen(document);

  const from = await vscode.window.showInputBox({ prompt: '起点站', placeHolder: '例如：体育西路' });
  if (!from) return;
  const to = await vscode.window.showInputBox({ prompt: '终点站', placeHolder: '例如：广州塔' });
  if (!to) return;
  const clock = await vscode.window.showInputBox({
    prompt: '出发时刻（HH:mm，留空用当前时间）',
    placeHolder: '08:00',
  });

  let result;
  try {
    result = await client.request('metro/route', {
      textDocument: { uri: document.uri.toString() },
      from,
      to,
      time: clock || '',
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`MetroLang：路线查询失败（${error.message}）`);
    return;
  }
  if (!result) return;
  if (!result.ok) {
    void vscode.window.showErrorMessage(`MetroLang：${result.error || '查询失败'}`);
    return;
  }

  outputChannel.appendLine('');
  outputChannel.appendLine(result.guidance || `${from} → ${to}`);
  for (const line of result.lines || []) outputChannel.appendLine(line);
  outputChannel.show(true);
}

/**
 * 数据预览：把当前文档的统计摘要（线路 / 车站 / 换乘 / 运营规则 / 未建模行）
 * 放进一个 Webview，方便改数据时对账。
 */
async function previewData() {
  const document = activeMetroDocument();
  if (!document) {
    void vscode.window.showWarningMessage('MetroLang：先把一个 .metro 文档设为活动编辑器。');
    return;
  }
  if (!client || !client.running) await startServer();
  if (!client || !client.running) return;
  syncOpen(document);

  let result;
  try {
    result = await client.request('metro/dataSummary', {
      textDocument: { uri: document.uri.toString() },
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`MetroLang：数据预览失败（${error.message}）`);
    return;
  }
  if (!result || !result.ok) {
    void vscode.window.showWarningMessage(
      `MetroLang：${(result && result.error) || '数据预览失败'}`);
    return;
  }

  const rows = (result.rows || [])
    .map((row) => `<tr><th>${escapeHtml(row[0])}</th><td>${escapeHtml(String(row[1]))}</td></tr>`)
    .join('');
  showPreviewHtml(`<!doctype html><meta charset="utf-8"><title>MetroLang 数据预览</title>
    <body style="font-family: system-ui, sans-serif; background:#faf7fa; color:#2b2b2b; padding:24px;">
    <h2 style="margin:0 0 4px;">数据预览</h2>
    <div style="color:#777;font-size:12px;margin-bottom:16px;">${escapeHtml(document.fileName)}</div>
    <table style="border-collapse:collapse;min-width:380px;">${rows}</table>
    <style>
      th{text-align:left;font-weight:600;padding:6px 20px 6px 0;color:#555;}
      td{padding:6px 0;font-variant-numeric:tabular-nums;}
      tr{border-bottom:1px solid #eee;}
    </style></body>`);
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
    // 记最近激活的模型文档：预览面板夺走焦点后 activeTextEditor 会变空。
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === LANGUAGE_ID) {
        lastMetroDocument = editor.document;
      }
    }),
    // 保存后自动重绘：只刷面板里正在看的那个文件，改别的文件不打扰。
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === LANGUAGE_ID
          && previewSourceUri === document.uri.toString()) {
        void previewDocument(document);
      }
    }),
  );
  void startServer();

  // 3. 语义提示：悬停看标识符的类型与定义，F12 跳定义，大纲看结构。
  //    三者都转发给语言服务器（服务器侧是 lsp_index.cpp 的语义索引）。
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SELECTOR, { provideHover: provideHover }),
    vscode.languages.registerDefinitionProvider(SELECTOR, { provideDefinition: provideDefinition }),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, { provideDocumentSymbols: provideSymbols }),
  );

  // 4. 命令。
  context.subscriptions.push(
    vscode.commands.registerCommand('metro.openDoc', () => openLanguageReference()),
    vscode.commands.registerCommand('metro.previewMap', () => previewMap()),
    vscode.commands.registerCommand('metro.previewMapFile', () => previewMapFromFile()),
    vscode.commands.registerCommand('metro.previewData', () => previewData()),
    vscode.commands.registerCommand('metro.queryRoute', () => queryRoute()),
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
