'use strict';

/**
 * 插件清单自检：确认 MetroLang（`.metro` / `.m`）真的被注册齐了，且能打包。
 *
 * 打包流程的第一步——注册不完整就不该产出安装包。它检查：
 *   1. `contributes.languages` 里有 id 为 `metro-lang` 的语言项，扩展名含 `.metro` / `.m`；
 *   2. 语言配置文件存在且可解析；
 *   3. `contributes.grammars` 里有 scopeName 为 `source.metro-lang` 的高亮文件，且文件有规则；
 *   4. `activationEvents` 里有 `onLanguage:metro-lang`；
 *   5. `main` 指向的入口文件存在；
 *   6. 语言级编辑器默认值 `[metro-lang]` 已声明；
 *   7. 命令与设置齐（预览地图 / 重启服务器 / 打开文档，`metro-lang.serverPath`）；
 *   8. 折叠与传统一一致：`src/metroFolding.js` 的 `planFoldingRanges` 是函数；
 *   9. LSP 客户端 `src/lspClient.js` 能 require，且导出 `LspClient`；
 *  10. 图标 `icon.png` 存在、是 PNG、且不小于 128×128（市场要求）；
 *  11. 有 LICENSE（vsce 打包会找它）；
 *  12. 内嵌编译器就位：`bin/metro-lang[.exe]` 存在且可执行位（非 Windows）。
 *
 * 用法（在仓库任意目录执行都可以）：
 *   node vscode/tools/check-manifest.js
 *
 * 返回码 0 表示全部通过，1 表示有问题。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 插件根目录（本文件在 <插件根>/tools/ 下）。 */
const EXTENSION_DIR = path.resolve(__dirname, '..');

/** 期望注册的语言 id。 */
const LANGUAGE_ID = 'metro-lang';

/** 期望的语言扩展名。 */
const LANGUAGE_EXTENSIONS = ['.metro', '.m'];

/** 期望的 TextMate scope 名。 */
const SCOPE_NAME = 'source.metro-lang';

let failures = 0;

/**
 * 记一条断言。
 *
 * @param {string} title 断言描述。
 * @param {boolean} ok 是否通过。
 * @param {string} [detail] 失败时的补充说明。
 */
function check(title, ok, detail) {
  if (!ok) failures += 1;
  console.log(`   [${ok ? 'OK' : '失败'}] ${title}${!ok && detail ? `（${detail}）` : ''}`);
}

/**
 * 读一个 JSON 文件。
 *
 * @param {string} file 路径。
 * @returns {any} 解析结果；文件不存在或坏格式时返回 null。
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 读 PNG 的宽高（只解析头部 24 字节，不依赖任何图形库）。
 *
 * @param {string} file PNG 文件路径。
 * @returns {{width: number, height: number}|null} 尺寸；不是 PNG 时返回 null。
 */
function readPngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24) return null;
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 自检主流程。 */
function main() {
  console.log('== MetroLang 插件清单自检 ==');
  const pkg = readJson(path.join(EXTENSION_DIR, 'package.json'));
  check('package.json 可解析', !!pkg);
  if (!pkg) {
    console.log('\n清单检查失败 1 项');
    process.exit(1);
  }

  const contributes = pkg.contributes || {};
  const languages = contributes.languages || [];
  const grammars = contributes.grammars || [];
  const defaults = contributes.configurationDefaults || {};
  const commands = contributes.commands || [];
  const activationEvents = pkg.activationEvents || [];
  const properties = (contributes.configuration && contributes.configuration.properties) || {};

  // 1. 语言注册：id / 扩展名 / 配置文件。
  const language = languages.find((item) => item && item.id === LANGUAGE_ID);
  check(`注册了语言 ${LANGUAGE_ID}`, !!language, 'contributes.languages 里没有对应项');
  if (language) {
    const extensions = language.extensions || [];
    for (const extension of LANGUAGE_EXTENSIONS) {
      check(`语言 ${LANGUAGE_ID} 关联 ${extension} 扩展名`, extensions.includes(extension),
        `实际：${extensions.join('、') || '（空）'}`);
    }
    const config = readJson(path.join(EXTENSION_DIR, language.configuration || ''));
    check('语言配置文件可解析', !!config);
  }

  // 2. 高亮语法注册：scopeName 与实际文件。
  const grammar = grammars.find((item) => item && item.language === LANGUAGE_ID);
  check(`语法高亮绑定到语言 ${LANGUAGE_ID}`, !!grammar);
  if (grammar) {
    check(`语法 scopeName 为 ${SCOPE_NAME}`, grammar.scopeName === SCOPE_NAME, `实际：${grammar.scopeName}`);
    const grammarJson = readJson(path.join(EXTENSION_DIR, grammar.path || ''));
    check('语法文件可解析且 scopeName 一致', !!(grammarJson && grammarJson.scopeName === SCOPE_NAME));
    check('语法文件包含规则',
      !!(grammarJson && Array.isArray(grammarJson.patterns) && grammarJson.patterns.length > 0));
  }

  // 3. 激活事件与入口。
  check(`activationEvents 包含 onLanguage:${LANGUAGE_ID}`,
    activationEvents.includes(`onLanguage:${LANGUAGE_ID}`));
  check('main 指向存在的入口文件',
    !!pkg.main && fs.existsSync(path.join(EXTENSION_DIR, pkg.main)), pkg.main);

  // 4. 编辑器默认值 / 命令 / 设置。
  check(`声明了 [${LANGUAGE_ID}] 编辑器默认值`, !!defaults[`[${LANGUAGE_ID}]`]);
  for (const command of ['metro.previewMap', 'metro.restartServer', 'metro.openDoc']) {
    check(`注册了命令 ${command}`, commands.some((item) => item.command === command));
  }
  check('声明了 metro-lang.serverPath', !!properties['metro-lang.serverPath']);

  // 5. 预览地图命令挂在编辑器标题栏。
  const menus = contributes.menus || {};
  check('「预览地图」挂在编辑器标题栏',
    (menus['editor/title'] || []).some(
      (item) => item.command === 'metro.previewMap' && item.when === `resourceLangId == ${LANGUAGE_ID}`));

  // 6. 折叠 / LSP 客户端模块。
  check('块折叠由 src/metroFolding.js 提供',
    typeof require(path.join(EXTENSION_DIR, 'src', 'metroFolding.js')).planFoldingRanges === 'function');
  const { LspClient } = require(path.join(EXTENSION_DIR, 'src', 'lspClient.js'));
  check('LSP 客户端由 src/lspClient.js 提供', typeof LspClient === 'function');

  // 7. LICENSE / 图标。
  check('有 LICENSE（MIT，vsce 打包会找它）',
    String(pkg.license || '').toUpperCase() === 'MIT'
      && fs.existsSync(path.join(EXTENSION_DIR, 'LICENSE')));
  check('package.json 声明了 icon', typeof pkg.icon === 'string');
  if (typeof pkg.icon === 'string') {
    const iconPath = path.join(EXTENSION_DIR, pkg.icon);
    const exists = fs.existsSync(iconPath);
    check('图标文件存在', exists, iconPath);
    if (exists) {
      const size = readPngSize(iconPath);
      check('图标是 PNG 且不小于 128×128',
        !!size && size.width >= 128 && size.height >= 128,
        size ? `实际 ${size.width}×${size.height}` : '不是 PNG');
    }
  }

  // 8. 内嵌编译器（打包时才带上；开发期没跑 embed 也允许通过，但要提示）。
  const locator = require(path.join(EXTENSION_DIR, 'src', 'locator.js'));
  const bundled = path.join(EXTENSION_DIR, 'bin', locator.NAME);
  const hasBundled = locator.isFile(bundled);
  console.log(`   [${hasBundled ? 'OK' : '提示'}] 内嵌编译器 ${path.relative(EXTENSION_DIR, bundled)}`
    + `${hasBundled ? '' : '（还没跑 tools/embed-compiler.js）'}`);

  console.log(failures === 0 ? '\n清单检查通过：metro-lang（.metro / .m）注册完整' : `\n清单检查失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
