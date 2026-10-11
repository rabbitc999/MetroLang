'use strict';

/**
 * `.metro` / `.m` 折叠块的配对（纯计算，不依赖 VS Code，便于直接测）。
 *
 * 与 `metro-lang` 编译器的块栈同口径（`epilogue/metro_parse.cpp`）：
 *   - 块由块头命令（`PROGRAM_DEFINE` / `LINE_DEFINE` / …）开头，`END_DEFINE` 收尾；
 *     策略块与属性块分别用 `END_POLICY` / `END_ATTRIBUTES` 收尾；
 *   - 嵌套照常（`LINE_DEFINE` 里套 `DIRECTION_DEFINE`）；
 *   - 关键字不区分大小写，指令名按**整词**判断；
 *   - 一行式方向快捷方式 `DIRECTION_DEFINE <新ID> REV <原ID>` 不带 `END_DEFINE`，
 *     不参与配对（编译器会先把它展开成块形式再解析）；
 *   - 收尾没写完（编辑到一半）时按文件末尾收，块不会突然消失。
 *
 * 行号是 0 基、闭区间，和 VS Code 的 `FoldingRange` 一致。
 */

/** 块头关键词（大写）→ 折叠后显示的提示文字。 */
const OPENERS = new Map([
  ['PROGRAM_DEFINE', '程序定义'],
  ['STATION_DEFINE', '站点定义'],
  ['STATION_MODIFY', '站点修改'],
  ['OPERATION_DEFINE', '运营参数'],
  ['PRICE_DEFINE', '票价定义'],
  ['TRANSFER_TYPE', '换乘类型'],
  ['TRANSFER_DEFINE', '换乘定义'],
  ['VIRTUAL_TRANSFER_DEFINE', '虚拟换乘'],
  ['LINE_TEMPLATE', '线路模板'],
  ['LINE_DEFINE', '线路定义'],
  ['LINE_MODIFY', '线路修改'],
  ['DIRECTION_TEMPLATE', '方向模板'],
  ['DIRECTION_DEFINE', '方向定义'],
  ['DIRECTION_MODIFY', '方向修改'],
  ['HEADWAY_PROFILE', '行车间隔'],
  ['CROWD_PROFILE', '客流画像'],
  ['DWELL_TIME_DEFINE', '停站时间'],
  ['SPEED_LIMIT_DEFINE', '限速定义'],
  ['LABEL_DEFINE', '标签定义'],
  ['FACILITY_DEFINE', '无障碍设施'],
  ['PROMOTION_DEFINE', '优惠活动'],
  ['ZONE_DEFINE', '分区定义'],
  ['OPERATOR_DEFINE', '运营单位'],
  ['BACKGROUND_DEFINE', '底图定义'],
  ['SPECIAL_DEFINE', '特殊定义'],
  ['POLICY', '策略'],
  ['ATTRIBUTES', '属性'],
]);

/** 收尾关键词（大写）。 */
const CLOSERS = new Set(['END_DEFINE', 'END_POLICY', 'END_ATTRIBUTES']);

/**
 * 取行首的关键词（大小写不敏感）。
 *
 * 行首不是标识符（空行、`#` 注释、`%` 预处理指令）时返回空串，调用方直接跳过。
 *
 * @param {string} text 去掉首尾空白后的整行。
 * @returns {string} 大写化的行首词；没有则返回空串。
 */
function headWord(text) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  return match ? match[1].toUpperCase() : '';
}

/**
 * 这一行是不是一行式方向快捷方式 `DIRECTION_DEFINE <新ID> REV <原ID>`。
 *
 * 判定与编译器的预折叠完全一致：恰好 4 个词、第三个是 `REV`。这种写法不带
 * `END_DEFINE`，不能被当成块头压栈，否则会把外层的折叠层次带偏。
 *
 * @param {string} text 去掉首尾空白后的整行。
 * @param {string} head 行首关键词（大写）。
 * @returns {boolean} 是快捷方式返回 true。
 */
function isDirectionShortcut(text, head) {
  if (head !== 'DIRECTION_DEFINE') return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length === 4 && words[2].toUpperCase() === 'REV';
}

/**
 * 算出所有可折叠块。
 *
 * @param {string[]} lines 按行拆好的源码（不含换行符）。
 * @returns {{start: number, end: number, name: string}[]} 按起始行递增、只含跨行的块。
 */
function planFoldingRanges(lines) {
  const blocks = [];
  const open = [];
  for (let index = 0; index < lines.length; index++) {
    const text = String(lines[index]).trim();
    const head = headWord(text);
    if (!head) continue;
    if (OPENERS.has(head)) {
      if (!isDirectionShortcut(text, head)) open.push({ line: index, name: OPENERS.get(head) });
      continue;
    }
    if (!CLOSERS.has(head)) continue;
    const start = open.pop();
    if (start === undefined) continue; // 多余的收尾：交给编译器诊断，这里不报
    if (index > start.line) blocks.push({ start: start.line, end: index, name: start.name });
  }

  // 收尾没写完：按到文件末尾收，编辑中的代码也能折。
  const last = lines.length - 1;
  while (open.length > 0) {
    const start = open.pop();
    if (last > start.line) blocks.push({ start: start.line, end: last, name: start.name });
  }

  blocks.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  return blocks;
}

module.exports = { planFoldingRanges };
