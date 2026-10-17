'use strict';

/**
 * 把 `metro-lang` 编译器内嵌进插件包（复制到本扩展的 bin/ 下）。
 *
 * `vsce package` 会通过 `vscode:prepublish` 自动跑它，所以打出来的 .vsix 自带编译器：
 * 装完就能用诊断与地图预览，不需要用户先构建工具链。
 *
 * 用法（在 vscode/ 里或任意目录都行）：
 *   node tools/embed-compiler.js                 # 自动找：--from → METRO_LANG_BIN → ../build/metro-lang/ → PATH
 *   node tools/embed-compiler.js --from ../build/metro-lang/metro-lang.exe
 *
 * 找不到就退出 2，并说明怎么构建（在项目根目录跑 make）。
 */

const fs = require('node:fs');
const path = require('node:path');

const locator = require('../src/locator');

const EXT_ROOT = path.join(__dirname, '..');
const TARGET_DIR = path.join(EXT_ROOT, 'bin');
const TARGET = path.join(TARGET_DIR, locator.NAME);

/**
 * 取 `--from <路径>`。
 *
 * @returns {string} 参数值；没给返回空串。
 */
function fromArgument() {
  const index = process.argv.indexOf('--from');
  if (index < 0) return '';
  const value = process.argv[index + 1];
  if (!value) {
    console.error('--from 后面要跟编译器路径');
    process.exit(2);
  }
  return value;
}

/**
 * 按顺序找源编译器。
 *
 * @returns {{file: string|null, from: string}} 源文件与来源说明。
 */
function findSource() {
  const explicit = fromArgument() || (process.env.METRO_LANG_BIN || '').trim();
  if (explicit) {
    if (!locator.isFile(explicit)) {
      console.error(`找不到指定的编译器：${explicit}`);
      process.exit(2);
    }
    return { file: explicit, from: '参数 / METRO_LANG_BIN' };
  }
  const projectRoot = path.join(EXT_ROOT, '..');
  const candidates = [
    path.join(projectRoot, 'build', 'metro-lang', locator.NAME),
    path.join(projectRoot, locator.NAME),
  ];
  for (const candidate of candidates) {
    if (locator.isFile(candidate)) return { file: candidate, from: '项目构建产物' };
  }
  const onPath = locator.findOnPath('metro-lang');
  if (onPath) return { file: onPath, from: 'PATH' };
  return { file: null, from: '' };
}

/** 复制（内容一致就跳过），并打印来源与大小。 */
function main() {
  const source = findSource();
  if (!source.file) {
    console.error('找不到 metro-lang 编译器：先在项目根目录跑 make（产出 build/metro-lang/metro-lang），');
    console.error('或用 `--from <路径>` / 环境变量 METRO_LANG_BIN 指定。');
    process.exit(2);
  }
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const content = fs.readFileSync(source.file);
  const before = fs.existsSync(TARGET) ? fs.readFileSync(TARGET) : null;
  if (before && before.equals(content)) {
    console.log(`内嵌编译器已是最新：${path.relative(EXT_ROOT, TARGET)}`
      + `（${content.length} 字节，来自${source.from}）`);
    return;
  }
  fs.writeFileSync(TARGET, content);
  if (process.platform !== 'win32') fs.chmodSync(TARGET, 0o755);
  console.log(`已内嵌编译器：${path.relative(EXT_ROOT, TARGET)}`
    + `（${content.length} 字节，来自${source.from}：${source.file}）`);
}

main();
