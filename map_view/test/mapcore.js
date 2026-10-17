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

// ---- 寻路：两条线路在「换乘站」交汇 ----
const net = {
  key_city: '测试市',
  stations: {
    起点: { lon: 114.00, lat: 22.50 },
    中一: { lon: 114.01, lat: 22.50 },
    换乘站: { lon: 114.02, lat: 22.50 },
    中二: { lon: 114.02, lat: 22.51 },
    终点: { lon: 114.02, lat: 22.52 },
    旁支: { lon: 114.05, lat: 22.50 },
  },
  lines: {
    A: {
      name: '1号线', color: '#ff0000',
      direction: [
        { station: [{ name: '起点' }, { name: '中一' }, { name: '换乘站' }, { name: '旁支' }] },
        { station: [{ name: '旁支' }, { name: '换乘站' }, { name: '中一' }, { name: '起点' }] },
      ],
    },
    B: {
      name: '2号线', color: '#0000ff',
      direction: [
        { station: [{ name: '换乘站' }, { name: '中二' }, { name: '终点' }] },
        { station: [{ name: '终点' }, { name: '中二' }, { name: '换乘站' }] },
      ],
    },
  },
};
const netModel = core.buildModel(net);

const r1 = core.findRoute(netModel, '起点', '换乘站');
check(r1.found === true, '寻路：直达能找到');
check(r1.transfers === 0, '寻路：直达换乘 0 次');
check(r1.segments.length === 1, '寻路：直达只有 1 段');
check(r1.segments[0].color === '#ff0000', '寻路：段带线路颜色');
check(r1.stops === 2, '寻路：直达 2 站');

const r2 = core.findRoute(netModel, '起点', '终点');
check(r2.found === true, '寻路：跨线能找到');
check(r2.transfers === 1, '寻路：跨线换乘 1 次');
check(r2.segments.length === 2, '寻路：跨线分 2 段');
check(r2.segments[0].line === 'A' && r2.segments[1].line === 'B', '寻路：分段线路顺序正确');
check(r2.segments[0].to === '换乘站' && r2.segments[1].from === '换乘站', '寻路：换乘发生在交汇站');
check(r2.segments[1].color === '#0000ff', '寻路：第二段用 2 号线颜色');
check(r2.stations[r2.stations.length - 1] === '终点', '寻路：站序以终点收尾');
check(r2.guidance.indexOf('换乘') >= 0, '寻路：引导文本提到换乘');

const r3 = core.findRoute(netModel, '起点', '不存在');
check(r3.found === false && /找不到终点站/.test(r3.error), '寻路：未知终点给出原因');

const r4 = core.findRoute(netModel, '起点', '起点');
check(r4.found === false, '寻路：起终点相同返回失败');

const r5 = core.findRoute(netModel, '起点', '终点', { avoidLines: ['B'] });
check(r5.found === false, '寻路：避开必经线路后不连通');

// ---- 与 C++ 口径对照：同一份广州数据，前端的线路选择要和 CLI 一致 ----
// 期望值直接从 CLI 现算，避免 C++ 侧口径修正后前端测试跟着过期。
const gzJson = require('path').resolve(__dirname, '../../build/check/full.json');
const gzSrc = require('path').resolve(__dirname, '../../samples/guangzhou.m');
if (require('fs').existsSync(gzJson) && require('fs').existsSync(gzSrc)) {
  const gzData = JSON.parse(require('fs').readFileSync(gzJson, 'utf8'));
  const gz = core.buildModel(gzData);
  const binCandidates = [
    require('path').resolve(__dirname, '../../build/metro-lang/metro-lang.exe'),
    require('path').resolve(__dirname, '../../build/metro-lang/metro-lang'),
  ];
  const bin = binCandidates.find(p => require('fs').existsSync(p));

  /** 跑一次 CLI，取 `合计：xx km，换乘 n 次` 与分段线路名。 */
  function cliPlan(a, b) {
    const out = require('child_process').execFileSync(
      bin, ['route', gzSrc, '--from', a, '--to', b], { encoding: 'utf8' });
    const km = /合计：([\d.]+) km/.exec(out);
    const lines = [];
    out.split(/\r?\n/).forEach(line => {
      const m = /^\s+\d+\.\s+(\S+?)（开往/.exec(line);
      if (m) lines.push(m[1]);
    });
    return { km: km ? parseFloat(km[1]) : NaN, lines };
  }

  const CASES = [
    ['广州南站', '机场南(T1)'],
    ['体育西路', '广州南站'],
    ['广州塔', '白云公园'],
    ['公园前', '广州东站'],
  ];
  for (const [a, b] of CASES) {
    const got = core.findRoute(gz, a, b);
    const gotLines = got.found ? got.segments.map(s => s.line_name) : [];
    const want = bin ? cliPlan(a, b) : { km: NaN, lines: null };
    if (want.lines) {
      check(JSON.stringify(gotLines) === JSON.stringify(want.lines),
            `广州 ${a} → ${b}：线路选择与 CLI 一致（得到 ${JSON.stringify(gotLines)}，CLI ${JSON.stringify(want.lines)}）`);
      const dev = got.found && isFinite(want.km) ? Math.abs(got.distanceKm - want.km) / want.km : 1;
      check(dev < 0.05,
            `广州 ${a} → ${b}：里程误差 < 5%（得到 ${got.distanceKm} km，CLI ${want.km} km，偏差 ${(dev * 100).toFixed(1)}%）`);
    }
  }
  if (!bin) console.log('[skip] 广州数据对照（找不到 metro-lang，先 make）');
} else {
  console.log('[skip] 广州数据对照（先跑 sh check.sh 生成 build/check/full.json）');
}

console.log();
if (failed === 0) {
  console.log('mapcore 单元测试全部通过');
  process.exit(0);
}
console.error(`有 ${failed} 项失败`);
process.exit(1);
