/**
 * @file test_route_ui.js
 * @brief 查看器「动态路线查询」的端到端测试（jsdom 跑真实页面）。
 *
 * 它把 `index.html` + d3 + `app.js` + `loader.js` 原样跑一遍，然后像用户那样
 * 调用面板：填起终点 → 点查询 → 检查 SVG 里出现按线路着色的路线、右侧面板
 * 出了摘要。这样能覆盖「内核算得对」之外的那一半：DOM 接得通、颜色用对了。
 *
 * 用法（在 map_view/ 下，先 `npm i jsdom`）：
 *   node test/route_ui.js [数据.json]
 *
 * 不给数据时用 `metro-lang compile` 现场生成一份小网络。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');

let checks = 0;
let failed = 0;

function check(name, ok, detail) {
    checks += 1;
    if (ok) {
        console.log('[ok]   ' + name);
    } else {
        console.log('[FAIL] ' + name + (detail ? '\n       ' + detail : ''));
        failed += 1;
    }
}

function findBinary() {
    const candidates = [
        path.join(REPO, 'build', 'metro-lang', 'metro-lang.exe'),
        path.join(REPO, 'build', 'metro-lang', 'metro-lang'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('找不到 metro-lang，先 make');
    return found;
}

/** 一份三线小网络：A 线 / B 线在「中站」交汇，C 线是干扰支线。 */
function makeData() {
    const sample = path.join(os.tmpdir(), 'route_ui_sample.metro');
    fs.writeFileSync(sample, `PROGRAM_DEFINE
    KEY_CITY '测试市'
END_DEFINE

STATION_DEFINE
    NODE '起点' 114.00 22.50
    NODE '甲站' 114.01 22.50
    NODE '中站' 114.02 22.50
    NODE '乙站' 114.02 22.51
    NODE '终点' 114.02 22.52
    NODE '旁站' 114.05 22.50
END_DEFINE

LINE_DEFINE A
    NAME '1号线'
    COLOR '#E4002B'
    MAXSPEED 80
    DIRECTION_DEFINE A_0
        STATIONS '起点' '甲站' '中站' '旁站'
    END_DEFINE
END_DEFINE

LINE_DEFINE B
    NAME '2号线'
    COLOR '#0072CE'
    MAXSPEED 80
    DIRECTION_DEFINE B_0
        STATIONS '中站' '乙站' '终点'
    END_DEFINE
END_DEFINE
`, 'utf8');
    const out = path.join(os.tmpdir(), 'route_ui_sample.json');
    execFileSync(findBinary(), ['compile', sample, '-o', out], { stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
}

async function main() {
    const dataPath = process.argv[2];
    const data = dataPath
        ? JSON.parse(fs.readFileSync(path.resolve(dataPath), 'utf8'))
        : makeData();

    // jsdom 不跑 d3 的布局引擎也没关系：d3 画图是纯 DOM 操作。
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const dom = new JSDOM(html, {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        url: 'file://' + path.join(ROOT, 'index.html').replace(/\\/g, '/'),
    });
    const { window } = dom;

    // 布局尺寸：jsdom 里 innerWidth/Height 恒为 1024/768，够用。
    for (const script of ['js/d3.min.js', 'js/metro_mapcore.js', 'js/app.js', 'js/loader.js']) {
        const code = fs.readFileSync(path.join(ROOT, script), 'utf8');
        window.eval(code);
    }

    // 直接把数据喂给页面（加载器平时走文件选择器，这里绕开）。
    window.eval('loadMetroData(' + JSON.stringify(JSON.stringify(data)) + ')');

    check('页面完成绘制', typeof window.__stationData === 'object' && window.__stationData.length > 0);
    check('路线面板已打开', window.document.querySelector('#route-panel').classList.contains('open'));

    const stationCount = window.__stationData.length;
    check('站点数据齐备', stationCount >= 6, '得到 ' + stationCount);

    // ---- 走一遍 UI：填起点、填终点、点查询 ----
    window.document.querySelector('#route-from').value = '起点';
    window.document.querySelector('#route-to').value = '终点';
    window.document.querySelector('#route-go').dispatchEvent(
        new window.Event('click', { bubbles: true }));

    check('查询后面板仍在', window.document.querySelector('#route-panel').classList.contains('open'));

    const summary = window.document.querySelector('#route-result');
    check('面板有结果', summary.textContent.length > 0, summary.textContent.slice(0, 200));
    check('面板显示换乘 1 次', /换乘 1 次/.test(summary.textContent), summary.textContent.slice(0, 200));
    check('面板显示 2 段', /2 段/.test(summary.textContent), summary.textContent.slice(0, 200));
    check('面板列出 1号线', /1号线/.test(summary.textContent), summary.textContent.slice(0, 200));
    check('面板列出 2号线', /2号线/.test(summary.textContent), summary.textContent.slice(0, 200));

    const segs = summary.querySelectorAll('.route-seg');
    check('面板有 2 条分段行', segs.length === 2, '得到 ' + segs.length);
    if (segs.length === 2) {
        const swatches = Array.from(segs).map(s => s.querySelector('.swatch').style.background);
        check('第一段用 1 号线颜色', /228, 0, 43|#e4002b/i.test(swatches[0]), swatches[0]);
        check('第二段用 2 号线颜色', /0, 114, 206|#0072ce/i.test(swatches[1]), swatches[1]);
    }

    // ---- 地图上应该有按线路着色的两段路线 ----
    const routePaths = Array.from(window.document.querySelectorAll('.temp-layer path.temp-line'));
    check('地图上有路线图层', routePaths.length >= 4, '得到 ' + routePaths.length);
    const strokes = routePaths.map(p => p.getAttribute('stroke') || p.style.stroke);
    // 浏览器会把 #E4002B 归一成 rgb(228, 0, 43)，两种写法都认。
    check('路线用了 1 号线颜色', strokes.some(s => /e4002b|228,\s*0,\s*43/i.test(String(s))),
          strokes.join(' | '));
    check('路线用了 2 号线颜色', strokes.some(s => /0072ce|0,\s*114,\s*206/i.test(String(s))),
          strokes.join(' | '));

    const markers = Array.from(window.document.querySelectorAll('.temp-layer circle.temp-marker'));
    check('画了起终点/换乘标记', markers.length >= 3, '得到 ' + markers.length);

    // ---- 点地图选站：第一次点起点，第二次点终点 ----
    window.eval('window.__clearRoute()');
    const before = window.document.querySelectorAll('.temp-layer path.temp-line').length;
    check('清除后路线图层空', before === 0, '得到 ' + before);

    // ---- 未知站给出提示而不是崩掉 ----
    window.document.querySelector('#route-from').value = '起点';
    window.document.querySelector('#route-to').value = '不存在的站';
    window.document.querySelector('#route-go').dispatchEvent(
        new window.Event('click', { bubbles: true }));
    check('未知终点给出提示',
          /找不到/.test(window.document.querySelector('#route-result').textContent),
          window.document.querySelector('#route-result').textContent.slice(0, 160));

    console.log();
    if (failed === 0) {
        console.log('查看器路线查询 UI 测试全部通过（' + checks + ' 项）');
        process.exit(0);
    }
    console.error('有 ' + failed + ' 项失败');
    process.exit(1);
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
});
