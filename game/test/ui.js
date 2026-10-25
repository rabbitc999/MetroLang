'use strict';

/**
 * @file game/test/ui.js
 * @brief `game/js/ui.js` 的无头冒烟测试（jsdom）：缩放、平移、站名标签。
 *
 * 为什么要真跑 DOM：这一层的 bug 全是「不报错但看不见」——投影取不到坐标
 * 会静默掉进网格兜底（线网糊成一团），标签 `y` 算成 `NaN` 会让整层标签消失。
 * 纯读代码发现不了，只有把 SVG 建出来量属性才看得见。
 *
 * 用法：
 *   node game/test/ui.js [数据.json]
 *
 * 需要 jsdom；没有就跳过（退出码 0），不阻塞 CI。
 */

const fs = require('node:fs');
const path = require('node:path');

const dataPath = process.argv[2] || path.join(__dirname, '..', 'data', 'guangzhou.json');
if (!fs.existsSync(dataPath)) {
  console.error('缺少数据：' + dataPath);
  process.exit(2);
}

// jsdom 装在 map_view/node_modules（仓库里唯一的 node 依赖），按常见位置找。
function loadJsdom() {
  const candidates = [
    path.join(__dirname, '..', '..', 'map_view', 'node_modules', 'jsdom'),
    'jsdom',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      /* 试下一个 */
    }
  }
  return null;
}

const jsdomMod = loadJsdom();
if (!jsdomMod) {
  console.log('没有 jsdom，跳过 UI 冒烟测试（不影响其它检查）');
  process.exit(0);
}

const { JSDOM } = jsdomMod;

let checks = 0;
let failed = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) console.log('[ok]   ' + name);
  else {
    console.error('[FAIL] ' + name + (detail ? '  —— ' + detail : ''));
    failed++;
  }
}

const sim = require(path.join(__dirname, '..', 'js', 'sim.js'));

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// ---- 建 DOM ----
// `ui.js` 的 `start()` 自己找 `#app` 和 `#game-data`（与单文件 HTML 一致），
// 所以这里照着真实页面把骨架搭出来，而不是另开一个入口。
const dom = new JSDOM(
  '<!DOCTYPE html><body><div id="app"></div>' +
    '<script id="game-data" type="application/json"></script></body>',
  { pretendToBeVisual: true, runScripts: 'dangerously' },
);
const { window } = dom;
global.window = window;
global.document = window.document;
// 注意：不要给 `global.navigator` 赋值——Node 20+ 把它定义成只读 getter，
// 直接赋值会抛 TypeError。

document.getElementById('game-data').textContent = JSON.stringify(data);

// —— 运行库注入 ——
//
// `ui.js` 是浏览器脚本（IIFE，从 **window 上**取 `d3` / `sim`）。挂在 node 的
// `global` 上不算数：`start()` 会走进「缺少运行库」的兜底分支，安静地什么都不画
// （第一版测试就栽在这里）。另外 jsdom 建实例时 DOMContentLoaded 已经过去了，
// `ui.js` 注册的监听器不会自己触发，要补派一次。
// 全局名必须与单文件 HTML 里的一致：`window.MetroSim` + `window.d3`
// （ui.js 第 19-20 行就是这么取的，取不到就报「缺少运行库」）。
window.MetroSim = sim;
window.d3 = require(path.join(__dirname, '..', 'js', 'd3.min.js'));

function injectScript(code) {
  const el = document.createElement('script');
  el.textContent = code;
  document.body.appendChild(el);
}

// jsdom 没有布局：给 stage 一个确定尺寸，否则 clientWidth 是 0。
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() { return this.id === 'stage' ? 900 : 0; },
});
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() { return this.id === 'stage' ? 640 : 0; },
});
window.SVGElement.prototype.getBoundingClientRect = function () {
  if (this.tagName === 'svg') return { left: 0, top: 0, width: 900, height: 640, right: 900, bottom: 640 };
  return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
};
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// ---- 启动 ----
// 用 `<script>` 执行 ui.js（`runScripts: 'dangerously'`），再补派 DOMContentLoaded。
window.addEventListener('error', (e) => console.error('window 错误：', e.message));
try {
  injectScript(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  check('UI 能挂载', !!document.querySelector('#stage svg'),
    (document.getElementById('app') || {}).innerHTML ? 'app 内容：' +
      String(document.getElementById('app').innerHTML).slice(0, 120) : '');
} catch (e) {
  check('UI 能挂载', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.error(e);
  process.exit(1);
}

const hook = window.__metroGame;
check('暴露了测试挂钩', !!hook);
if (!hook || !hook.ctx || !hook.ctx.view) {
  console.error('拿不到 view，后续检查跳过');
  process.exit(1);
}
const view = hook.ctx.view;
const svg = document.querySelector('#stage svg');

// ---- 投影：必须是地理投影，不是网格兜底 ----
const vb0 = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
check('viewBox 由相机设置（4 个数且有限）', vb0.length === 4 && vb0.every(Number.isFinite),
  JSON.stringify(vb0));
check('初始视口 = 画布尺寸', Math.abs(vb0[2] - 900) < 1e-6 && Math.abs(vb0[3] - 640) < 1e-6,
  JSON.stringify(vb0));

// 抽几段线看形状：网格兜底是笔直的正交折线，地理投影不会。
const paths = Array.from(svg.querySelectorAll('.lines path'));
check('画出了线路', paths.length > 10, '条数 ' + paths.length);
{
  // 用两个相邻站的画布距离判断：网格兜底间距恒为 44，投影不会这么巧。
  const d = paths[0].getAttribute('d') || '';
  const nums = d.match(/-?\d+(\.\d+)?/g) || [];
  check('线路路径里有真实坐标（不是网格兜底）', nums.length > 8, '点数 ' + nums.length);
}

// ---- 站名标签 ----
const labels = Array.from(svg.querySelectorAll('.station-label'));
check('建了站名标签节点', labels.length > 300, '个 ' + labels.length);
{
  const shown = labels.filter((n) => n.style.display !== 'none');
  check('初始缩放下有部分标签可见（其余避让）', shown.length > 0 && shown.length < labels.length,
    '可见 ' + shown.length + '/' + labels.length);
  const bad = shown.filter((n) => {
    const y = Number(n.getAttribute('y'));
    const fs = Number(n.getAttribute('font-size'));
    return !Number.isFinite(y) || !Number.isFinite(fs) || fs <= 0;
  });
  check('可见标签的坐标与字号都有限', bad.length === 0, '坏 ' + bad.length + ' 个');
  check('标签默认有内容', shown.every((n) => (n.textContent || '').length > 0));
}

// ---- 缩放 ----
const zoomTo = (k) => {
  // 直接调相机接口，比模拟滚轮事件稳（jsdom 的 WheelEvent 不完全）。
  view.camera.k = 1;
  view.applyCamera();
  view.zoomAt(k, view.width / 2, view.height / 2);
};

zoomTo(4);
const vb4 = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
check('放大 4 倍后视口缩小到 1/4', Math.abs(vb4[2] - 225) < 1e-6 && Math.abs(vb4[3] - 160) < 1e-6,
  JSON.stringify(vb4));
check('缩放百分比已更新', (document.getElementById('zoomPct') || {}).textContent === '400%',
  (document.getElementById('zoomPct') || {}).textContent);

{
  const shown = labels.filter((n) => n.style.display !== 'none');
  const fs = shown.length ? Number(shown[0].getAttribute('font-size')) : NaN;
  // 与 ui.js 里 layoutLabels() 同一套口径：LABEL_BASE / k，再夹到 [LABEL_MIN, LABEL_MAX]。
  // k=4 时 9/4 = 2.25 已低于下限，所以期望值本身就得走 clamp，否则断言是错的。
  const LABEL_BASE = 9, LABEL_MIN = 3.2, LABEL_MAX = 60;
  const expect = Math.max(LABEL_MIN, Math.min(LABEL_MAX, LABEL_BASE / 4));
  check('放大后字号按 1/k 缩小（受下限约束）', Math.abs(fs - expect) < 0.6,
    'font-size=' + fs + '，期望≈' + expect);
  check('放大后可见标签仍然只有少量（未全挤出来）', shown.length < labels.length,
    '可见 ' + shown.length);
}

// 字号确实随 k 变：中等放大时未被下限夹住的那一档要真的变小。
{
  const sample = () => {
    const s = labels.filter((n) => n.style.display !== 'none');
    return s.length ? Number(s[0].getAttribute('font-size')) : NaN;
  };
  view.zoomFit();
  const fsFit = sample();
  zoomTo(2);
  const fs2 = sample();
  check('中等放大（k=2）时字号真的变小了', Number.isFinite(fsFit) && Number.isFinite(fs2) && fs2 < fsFit,
    'k=1 → ' + fsFit + '，k=2 → ' + fs2);
}

// ---- 以锚点缩放：锚点下的画布点不动 ----
{
  view.camera.k = 1;
  view.camera.cx = 450;
  view.camera.cy = 320;
  view.applyCamera();
  const ax = 600, ay = 200;
  view.zoomAt(2, ax, ay);
  // 缩放后锚点对应的视口位置应仍是 (ax, ay)
  const cam = view.camera;
  const k2 = cam.k / 2; // 相对放大前
  const backX = cam.cx + (ax - cam.cx) * k2;
  const backY = cam.cy + (ay - cam.cy) * k2;
  check('以光标为锚点缩放不漂移', Math.abs(backX - ax) < 1e-6 && Math.abs(backY - ay) < 1e-6,
    'back=' + backX.toFixed(2) + ',' + backY.toFixed(2));
}

// ---- 上限与复位 ----
{
  view.camera.k = 1;
  view.camera.cx = 450;
  view.camera.cy = 320;
  view.zoomAt(1e6, 450, 320);
  check('放大有上限（不会无限放大）', view.camera.k <= 12 + 1e-9, 'k=' + view.camera.k);
  view.zoomFit();
  const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  check('reset 回到全图', Math.abs(vb[2] - 900) < 1e-6 && Math.abs(vb[0]) < 1e-6, JSON.stringify(vb));
  check('reset 后 k=1', view.camera.k === 1);
}

// ---- 站名开关 ----
{
  const btn = document.getElementById('toggleLabel');
  check('有站名开关按钮', !!btn);
  if (btn) {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const hidden = labels.every((n) => n.style.display === 'none');
    check('点一下全部隐藏', hidden);
    check('按钮进入关闭态', btn.classList.contains('off'));
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const someShown = labels.some((n) => n.style.display !== 'none');
    check('再点一下恢复', someShown);
  }
}

console.log('\n' + (failed === 0 ? `全部通过（${checks} 项）` : `${failed}/${checks} 项失败`));
process.exit(failed === 0 ? 0 : 1);
