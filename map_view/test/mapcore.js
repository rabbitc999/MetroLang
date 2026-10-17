'use strict';

/**
 * metro_mapcore.js 的单元测试：纯 Node 直跑（内核不依赖 DOM / D3）。
 *
 * 用法：node map_view/test/mapcore.js
 */

const path = require('node:path');
const core = require(path.join(__dirname, '..', 'js', 'metro_mapcore.js'));

let failed = 0;

/** @param {boolean} ok 断言条件。 @param {string} message 失败说明。 */
function check(ok, message) {
  if (ok) console.log(`[ok]   ${message}`);
  else { console.error(`[FAIL] ${message}`); failed++; }
}

// ---- 排序与配色 ----
check(core.compareLineName('1号线', '2号线') < 0, '1号线排在 2号线 前');
check(core.compareLineName('2号线', '10号线') < 0, '数字序：2 < 10（不是字典序）');
check(core.compareLineName('地铁A线', '1号线') > 0, '带前缀的排在无前缀后面');
check(core.getContrastTextColor('#00B052') === '#fff', '深色底配白字');
check(core.getContrastTextColor('#FFFF00') === '#000', '亮色底配黑字');

// ---- 平滑曲线 ----
const straight = core.generateSmoothPoints([[0, 0], [10, 0], [20, 0], [30, 0]], false, 4);
// 4 点折线展开成 6 个 Catmull-Rom 控制点 → 3 段 × 4 = 12 采样；
// 3 点及以下按原实现直接返回（不够平滑的最少点数）。
check(straight.length === 12, '4 点折线采样：3 段 × 4 = 12 点');
check(straight.every((p) => p[1] === 0), '直线平滑后仍在原直线上');

// ---- 模型构建（metro-lang JSON v2：stations 是数组） ----
const metroLang = {
  key_city: '测试市',
  stations: [
    { name: '甲', lon: 114.0, lat: 22.5, lines: [] },
    { name: '乙', lon: 114.01, lat: 22.51, lines: [{ id: 'L1', status: 'operating' }] },
    { name: '丙', lon: 114.02, lat: 22.52, lines: [] },
    { name: '丁', lon: 114.03, lat: 22.53, lines: [] },
  ],
  lines: {
    L1: {
      name: '1号线', color: '#ff0000',
      direction: [
        { station: [{ name: '甲' }, { name: '乙' }, { name: '丙' }, { name: '丁' }] },
        { REV: 'L1_0' },
      ],
    },
    L2: {
      name: '2号线', color: '#00ff00',
      direction: [{ station: [{ name: '乙' }, { name: '丙' }], express_stops: ['丙'] }],
    },
  },
};
const model = core.buildModel(metroLang);
check(Object.keys(model.stations).length === 4, 'stations 数组被索引成字典');
check(model.rawDirections.length === 3, '三条方向：L1 主方向 + L1 的 REV 占位 + L2');
check(model.rawDirections[0].groupKey === '1号线', '主城市的线路组名就是线路名');
check(model.mergedLines.length === 2, '两条线路合并成两个图例条目');
check(model.mergedLines[0].displayName === '1号线', '图例按线路名排序，1号线在前');
check(model.dirKeyToGroupKey[model.rawDirections[0].key] === '1号线', '方向 → 组映射就位');
check(model.expressColorByStation['丙'] && model.expressColorByStation['丙'][0] === '#00ff00', '快车停靠索引就位');
check(model.stationToDirKeys['乙'].length === 2, '换乘站的方向索引有两条');
check(model.stations['乙'].lines[0].status === 'operating', '站点对象上的附加字段保留');

// ---- 编辑器旧格式（stations 是字典） ----
const editor = {
  key_city: '测试市',
  stations: { 甲: { lon: 114.0, lat: 22.5 }, 乙: { lon: 114.01, lat: 22.51 } },
  lines: { L1: { name: '1号线', color: '#ff0000', direction: [{ station: [{ name: '甲' }, { name: '乙' }] }] } },
};
const model2 = core.buildModel(editor);
check(Object.keys(model2.stations).length === 2, '字典格式的 stations 也能索引');

// ---- 投影与线路几何 ----
const layout = core.computeLayout(model, { width: 1000, height: 800 });
const p1 = layout.project(114.0, 22.5);
const p2 = layout.project(114.02, 22.52);
check(p1[0] >= 0 && p1[0] <= 1000 && p2[1] >= 0 && p2[1] <= 800, '投影落在画布内');
check(p2[0] > p1[0] && p2[1] < p1[1], '经度增 → x 增；纬度增 → y 减（北在上下）');
const routes = core.planRoute(model, layout);
check(routes.length === 2, '每条方向一条几何路径');
check(routes[0].d.startsWith('M'), 'path d 以 M 开头');
check(routes[0].smoothPoints.length > routes[0].points.length, '平滑点比原始折线密');
check(core.toPathData([[1, 2], [3, 4]], true).endsWith('Z'), '环线 path 闭合');

console.log();
if (failed === 0) {
  console.log('mapcore 单元测试全部通过');
  process.exit(0);
}
console.error(`有 ${failed} 项失败`);
process.exit(1);
