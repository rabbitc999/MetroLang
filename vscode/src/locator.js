'use strict';

/**
 * 找 `metro-lang` 可执行文件（MetroLang 的语言服务器内嵌在编译器里：`metro-lang lsp`）。
 *
 * 只依赖 Node 标准库，不引用 `vscode`，所以能在纯 Node 下单独测试。
 *
 * 顺序（先看设置，再看**扩展自带的那份**，然后才是工作区与 PATH）：
 *   1. 设置里的 `metro-lang.serverPath`；
 *   2. 扩展包里内嵌的那份：`bin/metro-lang[.exe]`（打 VSIX 时由
 *      `tools/embed-compiler.js` 放进去，装完即用）；
 *   3. 工作区里几处常见位置：`build/metro-lang/metro-lang`、`metro-lang`；
 *   4. PATH 里的 `metro-lang`。
 */

const fs = require('node:fs');
const path = require('node:path');

/** Windows 上加后缀。 */
const EXE = process.platform === 'win32' ? '.exe' : '';

/** 可执行文件名（不含目录）。 */
const NAME = `metro-lang${EXE}`;

/** 扩展包里内嵌的编译器（相对扩展根目录）。 */
const BUNDLED_CANDIDATE = path.join('bin', NAME);

/** 工作区里按这个顺序找。 */
const WORKSPACE_CANDIDATES = [
  path.join('build', 'metro-lang', NAME),
  NAME,
];

/**
 * 文件存在且是普通文件。
 *
 * @param {string} file 路径。
 * @returns {boolean} 存在返回 true。
 */
function isFile(file) {
  try {
    return !!file && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 在 PATH 里找可执行文件。
 *
 * @param {string} name 名字（不含后缀也可）。
 * @returns {string|null} 找到返回绝对路径。
 */
function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
    if (!name.endsWith(EXE) && isFile(candidate + EXE)) return candidate + EXE;
  }
  return null;
}

/**
 * 定位编译器。
 *
 * @param {string} workspaceDir 工作区目录（可为空）。
 * @param {string} [configured] 设置里的路径。
 * @param {string} [extensionDir] 扩展根目录（内嵌编译器 `bin/metro-lang` 在它下面）。
 * @returns {{server: string|null, source: string}} 结果与来源说明（写日志用）。
 */
function resolveServer(workspaceDir, configured, extensionDir) {
  const fromSettings = typeof configured === 'string' ? configured.trim() : '';
  if (fromSettings) {
    return isFile(fromSettings)
      ? { server: fromSettings, source: '设置 metro-lang.serverPath' }
      : { server: null, source: `设置里的 metro-lang.serverPath 不存在：${fromSettings}` };
  }
  if (extensionDir) {
    const bundled = path.join(extensionDir, BUNDLED_CANDIDATE);
    if (isFile(bundled)) return { server: bundled, source: '扩展内嵌 bin/' };
  }
  if (workspaceDir) {
    for (const relative of WORKSPACE_CANDIDATES) {
      const candidate = path.join(workspaceDir, relative);
      if (isFile(candidate)) return { server: candidate, source: '工作区构建产物' };
    }
  }
  const onPath = findOnPath(NAME);
  if (onPath) return { server: onPath, source: 'PATH' };
  return { server: null, source: '没有找到：先在仓库根 make，或设置 metro-lang.serverPath' };
}

module.exports = {
  EXE,
  NAME,
  BUNDLED_CANDIDATE,
  isFile,
  findOnPath,
  resolveServer,
};
