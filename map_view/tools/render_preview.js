/**
 * @file render_preview.js
 * @brief 无头渲染查看器，生成 `map_view/preview.png` 用的独立 SVG。
 *
 * 查看器本体是普通网页（`index.html` + d3），要出图就得有个浏览器。这里不装
 * 无头 Chromium（下载太重），改成用 **jsdom** 把同一份 `index.html` / `app.js` /
 * `loader.js` 跑一遍——d3 画图是纯 DOM 操作，不需要排版引擎——再把
 * `#container` 里生成的那段 `<svg>` 抠出来存盘。剩下的栅格化交给 cairosvg
 * （或任何 SVG 渲染器）。
 *
 * 依赖：`npm i jsdom`（纯 JS，几秒装完）。
 *
 * 用法：
 *   node tools/render_preview.js index.html 数据.json 输出.svg [宽] [高]
 *
 * 例（本目录是 map_view/）：
 *   ../build/metro-lang/metro-lang compile ../samples/shenzhen.m -o /tmp/sz.json
 *   node tools/render_preview.js index.html /tmp/sz.json /tmp/sz.svg 1600 1000
 *   python3 -c "import cairosvg;cairosvg.svg2png(url='/tmp/sz.svg',\
 *       write_to='/tmp/sz.png',output_width=3200,output_height=2000)"
 *
 * 注意两点：
 *  - 独立 SVG 没有外链样式，脚本把 `css/style.css` 里跟 SVG 有关的规则内联进去
 *    （`.line-path{fill:none}` 之类少了它线路会被默认填成黑色）；`@media`、
 *    `-webkit-*`、伪类这些 cairosvg 解析不了的规则先滤掉。
 *  - jsdom 不做字体替换，所以强制给 `.station-label` 指定一个本机装了的
 *    中文字体（默认写 Noto Sans CJK SC），缺字时换成 fc-list 里有的即可。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const htmlPath = path.resolve(process.argv[2] || 'index.html');
const dataPath = path.resolve(process.argv[3] || '');
const outPath = path.resolve(process.argv[4] || 'preview.svg');
const W = parseInt(process.argv[5] || '1600', 10);
const H = parseInt(process.argv[6] || '1000', 10);

/** @brief 从 css/style.css 里挑出能内联进 SVG、且 cairosvg 解析得了的规则。 */
function svgCss(rawCss) {
    return rawCss
        .replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\}/g, '')
        .replace(/[^{}]*\{[^{}]*\}/g, (block) => {
            const sel = block.slice(0, block.indexOf('{'));
            return /-webkit|:hover|:focus|::|#legend|\.tooltip|body|html|\*/.test(sel) ? '' : block;
        });
}

const html = fs.readFileSync(htmlPath, 'utf8');
const dom = new JSDOM(html, {
    url: 'file://' + path.dirname(htmlPath) + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
        // 画布尺寸取自 window.innerWidth / innerHeight，jsdom 默认 1024×768
        Object.defineProperty(window, 'innerWidth', { value: W, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: H, configurable: true });
    }
});

dom.window.addEventListener('load', () => {
    try {
        dom.window.metroViewer.loadText(fs.readFileSync(dataPath, 'utf8'), path.basename(dataPath));
        const svgEl = dom.window.document.querySelector('#container svg');
        if (!svgEl) throw new Error('没画出 svg：先确认数据能被 loader.js 识别');
        svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

        const css = svgCss(fs.readFileSync(path.join(path.dirname(htmlPath), 'css', 'style.css'), 'utf8'));
        const fontFix = '.station-label{font-family:"Noto Sans CJK SC","Source Han Sans SC",sans-serif}';
        let svg = svgEl.outerHTML.replace(/<svg([^>]*)>/, '<svg$1><style>' + css + fontFix + '</style>');
        // 原页面的底色是 CSS background，序列化后要补成矩形
        svg = svg.replace(/(<svg[^>]*>)/,
            '$1<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#f5f5f5"/>');
        fs.writeFileSync(outPath, svg);
        console.log('已写出 %s（%d 字节）；状态：%s', outPath, svg.length,
            dom.window.document.getElementById('status').textContent);
    } catch (e) {
        console.error('渲染失败:', (e && e.stack) || e);
        process.exit(1);
    }
});
