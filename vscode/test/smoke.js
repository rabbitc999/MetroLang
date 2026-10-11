'use strict';

/**
 * 插件冒烟测试：纯 Node 直跑（不需要 VS Code 宿主）。
 *
 * 验证三件事：
 *   1. package.json 清单字段齐全（main 指到的文件存在、语言/语法声明自洽）；
 *   2. 折叠配对的核心行为（块头 → 收尾、嵌套、一行式方向快捷方式跳过）；
 *   3. extension.js 能被 require（不触发 activate，只验证模块自洽）。
 *
 * 用法：node vscode/test/smoke.js（在仓库根跑）
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const pluginDir = path.join(root, 'vscode');

let failed = 0;

/**
 * 断言：条件不成立就记一次失败。
 *
 * @param {boolean} ok 断言条件。
 * @param {string} message 失败说明。
 */
function check(ok, message) {
  if (ok) {
    console.log(`[ok]   ${message}`);
  } else {
    console.error(`[FAIL] ${message}`);
    failed++;
  }
}

// ---- 1. 清单 ----
const manifestPath = path.join(pluginDir, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
check(manifest.main === './extension.js' && fs.existsSync(path.join(pluginDir, 'extension.js')), 'main 指向的 extension.js 存在');
check(Array.isArray(manifest.contributes.languages) && manifest.contributes.languages[0].id === 'metro-lang', 'languages 声明了 metro-lang');
check(fs.existsSync(path.join(pluginDir, manifest.contributes.languages[0].configuration.replace('./', ''))), '语言配置文件存在');
const grammar = manifest.contributes.grammars[0];
check(grammar.language === 'metro-lang' && fs.existsSync(path.join(pluginDir, grammar.path.replace('./', ''))), 'TextMate 语法文件存在');
check(fs.existsSync(path.join(pluginDir, manifest.icon.replace('./', ''))), 'icon.png 存在');

// ---- 2. 折叠配对 ----
const metroFolding = require(path.join(pluginDir, 'src', 'metroFolding'));
const sample = [
  'LINE_DEFINE L1',
  "    NAME '1号线'",
  '    DIRECTION_DEFINE L1_0',
  "        STATIONS ['甲站']",
  '    END_DEFINE',
  '    DIRECTION_DEFINE L1_1 REV L1_0',
  'END_DEFINE',
].join('\n').split('\n');

const blocks = metroFolding.planFoldingRanges(sample);
check(
  blocks.length === 2 &&
    blocks.some((b) => b.start === 0 && b.end === 6) &&
    blocks.some((b) => b.start === 2 && b.end === 4),
  'LINE_DEFINE 折到 END_DEFINE（0..6），嵌套的 DIRECTION_DEFINE 折到 2..4',
);

const withShortcut = ['DIRECTION_DEFINE N REV O', 'END_DEFINE'];
const blocks2 = metroFolding.planFoldingRanges(withShortcut);
check(blocks2.length === 0, '一行式 DIRECTION_DEFINE … REV … 不参与配对');

const unclosed = ['LINE_DEFINE L1', '    NAME \'x\''];
const blocks3 = metroFolding.planFoldingRanges(unclosed);
check(blocks3.length === 1 && blocks3[0].end === 1, '没收尾的块按文件末尾收');

// ---- 3. extension.js 语法自洽 ----
// extension.js require('vscode')（宿主提供，纯 Node 下拿不到），所以这里只做
// 语法检查：`node --check` 能过就说明没有低级语法错误。
const { execFileSync } = require('node:child_process');
execFileSync(process.execPath, ['--check', path.join(pluginDir, 'extension.js')], { stdio: 'pipe' });
check(true, 'extension.js 通过 node --check 语法检查');

console.log();
if (failed === 0) {
  console.log('插件冒烟测试全部通过');
  process.exit(0);
}
console.error(`有 ${failed} 项失败`);
process.exit(1);
