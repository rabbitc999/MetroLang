'use strict';

/**
 * @file game/test/sim.js
 * @brief `game/js/sim.js` 的内核测试：纯 Node 直跑，不需要浏览器。
 *
 * 用法：
 *   node game/test/sim.js [数据.json]
 *
 * 不给数据时用 `game/data/guangzhou.json`；它不存在就先跑
 * `python game/tools/prepare_data.py build/check/full.json -o game/data/guangzhou.json`。
 */

const fs = require('node:fs');
const path = require('node:path');
const sim = require(path.join(__dirname, '..', 'js', 'sim.js'));

let checks = 0;
let failed = 0;

/**
 * @brief 断言并打印。
 * @param {string} name 用例名。
 * @param {boolean} ok 是否通过。
 * @param {string} [detail] 失败时的补充。
 */
function check(name, ok, detail) {
  checks++;
  if (ok) console.log('[ok]   ' + name);
  else {
    console.error('[FAIL] ' + name + (detail ? '  —— ' + detail : ''));
    failed++;
  }
}

const dataPath = process.argv[2] || path.join(__dirname, '..', 'data', 'guangzhou.json');
if (!fs.existsSync(dataPath)) {
  console.error('缺少数据：' + dataPath);
  console.error('先跑 python game/tools/prepare_data.py build/check/full.json -o game/data/guangzhou.json');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// ---------------------------------------------------------------- 数据基本形状
//
// 数据集有**两种形状**：`metro-lang game --json` 给字典、`prepare_data.py` 给
// 数组。测试要两种都吃得下，否则「换个生成器就挂」这种问题会留到浏览器里才炸。
const lines = Array.isArray(data.lines)
  ? data.lines
  : Object.keys(data.lines).map((k) => { const l = data.lines[k]; if (!l.id) l.id = k; return l; });
check('数据集格式标记正确', data.format === 'metro-game-1');
check('线路数量 > 15', lines.length > 15, '实际 ' + lines.length);
check('车站数量 > 300', Object.keys(data.stations).length > 300);
check('每条线路都有主链', lines.every((l) => l.main.stations.length >= 2));
check('区间里程与站数对得上', lines.every((l) =>
  l.main.km.length === l.main.stations.length - 1 &&
  l.branches.every((b) => b.km.length === b.stations.length - 1)));
check('区间里程全为正数', lines.every((l) =>
  l.main.km.every((k) => k > 0) && l.branches.every((b) => b.km.every((k) => k > 0))));

// ---------------------------------------------------------------- 区间耗时口径
// doc/03 §6：t = S/v + v/2*(1/1.0 + 1/0.85)。2 km、80 km/h 手算：
//   2000/(80/3.6) = 90.0 s；22.222/2*(1+1.17647) = 24.18 s → 114.18 s
const t2km = sim.segmentRunTime(2, 80, 1.0, 0.85);
check('2 km @80 km/h 的区间耗时 ≈ 114.2 s', Math.abs(t2km - 114.18) < 0.05, t2km.toFixed(3));
const t5km = sim.segmentRunTime(5, 120, 1.0, 0.85);
// 5000/(120/3.6)=150.0；60/3.6/2*(1+1/0.85)=16.667*2.17647=36.27 → 186.27
check('5 km @120 km/h 的区间耗时 ≈ 186.3 s', Math.abs(t5km - 186.27) < 0.05, t5km.toFixed(3));

// ---------------------------------------------------------------- 单线一天
const state = sim.createGame(data, { seed: 42 });
const g1 = state.lineById.G1;
const activeLines = state.lines.filter((l) => l.segments.length > 0);
// 纯规划线（`planned_only`，如 24 号线）没有运营段，本来就不该有车。
check('建局后每条**运营**线都有列车', activeLines.every((l) => l.trains.length >= 2));
check('纯规划线不排车', state.lines
  .filter((l) => !l.segments.length)
  .every((l) => l.trains.length === 0));

// 手动跑完一个早高峰（6:00 → 9:30），共 12600 s / 5 s = 2520 帧
const until = 9.5 * 3600;
let frames = 0;
while (state.now < until && !state.finished) {
  sim.step(state);
  frames++;
}
check('6:00→9:30 共推进 2520 帧', frames === 2520, '实际 ' + frames);
check('时刻停在 09:30', sim.formatClock(state.now) === '09:30', sim.formatClock(state.now));

const s = sim.summary(state);
check('产生了乘客到达', s.arrivals > 0, 'arrivals=' + s.arrivals);
check('有人上了车', s.boarded > 0, 'boarded=' + s.boarded);
check('有人到达目的地', s.arrived > 0, 'arrived=' + s.arrived);
check('平均等车时长在 1–15 分钟内', s.avgWait > 60 && s.avgWait < 900, 'avgWait=' + s.avgWait + ' s');
check('发车次数 > 运营线路数', s.departures > activeLines.length, 'departures=' + s.departures);
// 车不够时允许补车（记 shortage），所以只断言「列车数 >= 首班车数」，
// 且补出来的车规规矩矩停在合法位置（下一条断言已经在查）。
check('每列车都还在（补车只增不减）', activeLines.every((l) =>
  l.trains.length >= l.segments.length * 2));

// ---------------------------------------------------------------- 发车间隔口径
// 早高峰 G1 时刻表 120 s，玩家倍率默认 1
const g1Headway = sim.headwayOf(state, g1);
// 9:30 已经进平峰（09:00–17:00 → 240 s）
check('G1 平峰发车间隔 = 240 s', Math.abs(g1Headway - 240) < 1e-6, String(g1Headway));
g1.headwayScale = 0.5;
check('倍率 0.5 → 120 s', Math.abs(sim.headwayOf(state, g1) - 120) < 1e-6);
g1.headwayScale = 0.1;
check('倍率 0.1 被 45 s 下限截住', Math.abs(sim.headwayOf(state, g1) - 45) < 1e-6);
g1.headwayScale = 1;
const peak = sim.createGame(data, { seed: 1, dayStart: 7 * 3600 });
check('7:00 早高峰 G1 = 120 s', Math.abs(sim.headwayOf(peak, peak.lineById.G1) - 120) < 1e-6,
  String(sim.headwayOf(peak, peak.lineById.G1)));

// ---------------------------------------------------------------- 平峰时段
const flatNow = 14 * 3600;
check('平峰取 240 s', Math.abs(sim.atTime(g1.headwayPeriods, flatNow, 300) - 240) < 1e-6);
check('时段之外取兜底值', sim.atTime(g1.headwayPeriods, 5 * 3600, 777) === 777);

// ---------------------------------------------------------------- 可复现
const a = sim.createGame(data, { seed: 7 });
const b = sim.createGame(data, { seed: 7 });
for (let i = 0; i < 1200; i++) { sim.step(a); sim.step(b); }
check('同一 seed 两次跑出一样的结果',
  JSON.stringify(sim.summary(a)) === JSON.stringify(sim.summary(b)));
const c = sim.createGame(data, { seed: 8 });
for (let i = 0; i < 1200; i++) sim.step(c);
check('换 seed 结果不同', sim.summary(a).arrivals !== sim.summary(c).arrivals,
  sim.summary(a).arrivals + ' vs ' + sim.summary(c).arrivals);

// ---------------------------------------------------------------- 规划段隔离
//
// `FUTURE` 方向进的是 `line.future`，不是 `segments`。这条断言是防止回归的
// 核心：调度、客流、指标全遍历 `segments`，规划段一旦混进去，就等于把没开通
// 的轨道当成运营线在跑车，而页面上完全看不出异常。
const futureLines = state.lines.filter((l) => (l.futureSegments || []).length);
check('存在带规划段的线路（样例应含 FUTURE 方向）', futureLines.length > 0,
  futureLines.map((l) => l.id).join(','));
{
  let leaked = 0;
  futureLines.forEach((l) => {
    // 规划段里非端点的站，绝不能出现在运营段里。
    const opStops = new Set();
    l.segments.forEach((s) => s.stops.forEach((x) => opStops.add(x.name)));
    l.futureSegments.forEach((s) => {
      const mids = s.stops.slice(1, -1).map((x) => x.name);
      mids.forEach((n) => { if (opStops.has(n)) leaked++; });
    });
  });
  check('规划段的车站没有混进运营段', leaked === 0, '泄漏 ' + leaked + ' 站');
}

// ---------------------------------------------------------------- 列车位置合理
let bad = 0;
state.lines.forEach((l) => l.trains.forEach((tr) => {
  const seg = l.segments[tr.seg];
  if (tr.at < 0 || tr.at >= seg.stops.length) bad++;
  if (tr.leg >= seg.legs.length) bad++;
  if (tr.onboard.length > state.capacity) bad++;
}));
check('所有列车的位置与载客都在合法范围内', bad === 0, '越界 ' + bad + ' 处');

// ---------------------------------------------------------------- 跑完整一天
const full = sim.createGame(data, { seed: 1 });
let guard = 0;
while (!full.finished && guard++ < 20000) sim.step(full);
const fs2 = sim.summary(full);
check('一天能跑完（不卡死）', full.finished, sim.formatClock(full.now));
check('收车时刻 23:30', sim.formatClock(full.now) === '23:30', sim.formatClock(full.now));
check('全天载客量 > 1 万人次', fs2.boarded > 10000, 'boarded=' + fs2.boarded);
check('等车时长有限（没被拥挤公式拖成无穷）', fs2.avgWait < 1800, 'avgWait=' + fs2.avgWait);
console.log('\n一天的结果：' + JSON.stringify(fs2));

console.log('\n' + (failed === 0 ? `全部通过（${checks} 项）` : `${failed}/${checks} 项失败`));
process.exit(failed === 0 ? 0 : 1);
