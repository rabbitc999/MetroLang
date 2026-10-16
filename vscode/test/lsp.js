'use strict';

/**
 * LSP 端到端测试：用插件的 LspClient 驱动真编译器 `metro-lang lsp`。
 *
 * 验证四件事：
 *   1. 握手（initialize / initialized）；
 *   2. didOpen 坏文本 → publishDiagnostics 有 metro-syntax 错误；
 *   3. didOpen 真样例（带 %INCLUDE / %IMPORT CSV）→ 诊断清零；
 *   4. 自定义请求 metro/previewMap → 自包含 HTML。
 *
 * 用法：node vscode/test/lsp.js（在仓库根跑；需要先 make 出 build/metro-lang/metro-lang）
 */

const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..', '..');
const exe = process.platform === 'win32' ? 'metro-lang.exe' : 'metro-lang';
const bin = path.join(root, 'build', 'metro-lang', exe);

let failed = 0;

/** @param {boolean} ok 断言条件。 @param {string} message 失败说明。 */
function check(ok, message) {
  if (ok) console.log(`[ok]   ${message}`);
  else { console.error(`[FAIL] ${message}`); failed++; }
}

async function main() {
  if (!fs.existsSync(bin)) {
    console.error(`找不到 ${bin}，先在仓库根 make`);
    process.exit(1);
  }

  const { LspClient } = require(path.join(root, 'vscode', 'src', 'lspClient'));
  const client = new LspClient(bin, ['lsp'], { timeoutMs: 60000 });

  // 诊断推送：按 URI 记最后一版，测试里轮询等它到位。
  const lastDiags = new Map();
  client.on('diagnostics', ({ uri, diagnostics: items }) => lastDiags.set(uri, items));

  await client.start();
  const capabilities = await client.initialize();
  check(!!capabilities && !!capabilities.capabilities.textDocumentSync, 'initialize 返回 textDocumentSync 能力');

  const badUri = 'file:///bad.m';
  client.notify('textDocument/didOpen', {
    textDocument: { uri: badUri, languageId: 'metro-lang', version: 1, text: 'LINE_DEFINE BAD\n  NODE X\n' },
  });
  await waitFor(() => lastDiags.has(badUri), '坏文档的诊断推送');
  const badDiags = lastDiags.get(badUri) || [];
  check(badDiags.length === 1 && badDiags[0].code === 'metro-syntax', '坏文本报一条 metro-syntax 诊断');
  check(badDiags[0].range.start.line === 1, '诊断定位到第 2 行（0 起算 1）');

  const goodPath = path.join(root, 'samples', 'guangzhou.m');
  const goodUri = 'file:///' + goodPath.replace(/\\/g, '/');
  client.notify('textDocument/didOpen', {
    textDocument: { uri: goodUri, languageId: 'metro-lang', version: 1, text: fs.readFileSync(goodPath, 'utf8') },
  });
  await waitFor(() => lastDiags.has(goodUri), '真样例的诊断推送');
  const goodDiags = lastDiags.get(goodUri) || [];
  check(goodDiags.length === 0, `广州样例（%INCLUDE + %IMPORT CSV）诊断清零（实际 ${goodDiags.length} 条）`);

  const preview = await client.request('metro/previewMap', { textDocument: { uri: goodUri } });
  check(!!preview && preview.ok === true, 'metro/previewMap 编译通过');
  check(typeof preview.html === 'string' && preview.html.length > 10000, `预览 HTML 足够大（${preview ? preview.html.length : 0} 字节）`);
  check(/<svg|<html/i.test(preview.html || ''), '预览 HTML 里含地图标记');

  await client.stop();
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * 轮询等待条件成立。
 *
 * @param {Function} predicate 条件。
 * @param {string} what 等待说明（超时报错用）。
 * @returns {Promise<void>}
 */
async function waitFor(predicate, what) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${what}`);
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
});
