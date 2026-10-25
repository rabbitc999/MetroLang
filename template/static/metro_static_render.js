/*!
 * metro_static_render.js —— `metro-lang html` 页面的静态渲染层
 *
 * 只做三件事：读模型 JSON → 调 `MetroMapCore` 拿绘图数据 → 拼内联 SVG。
 * 几何、平滑、配色、图例排序全部在 `metro_mapcore.js` 里，
 * 这里**不允许**再算一遍（否则又会出现两份实现打架的老问题）。
 *
 * 与交互页（`map_view/`）的关系：
 *   - 同一份内核、同一个 JSON 口径；
 *   - 交互页用 D3 做拖拽/缩放/tooltip，这里只要"看得清"，
 *     所以直接拼 DOM 字符串，不引入任何第三方库。
 */
(function () {
    'use strict';

    /** @brief 画布尺寸：按窗口大小取，但给个下限，避免极窄屏把站名挤没。 */
    function canvasSize() {
        return {
            width: Math.max(640, window.innerWidth || 1280),
            height: Math.max(480, window.innerHeight || 800)
        };
    }

    /**
     * @brief SVG 元素拼装小工具（集中做转义）。
     * @param {string} text 文本。
     * @return {string} 转义后的文本。
     */
    function esc(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * @brief 渲染整张图。
     */
    function render() {
        var core = window.MetroMapCore;
        var modelNode = document.getElementById('metro-model');
        var accNode = document.getElementById('metro-accessibility');
        if (!core || !modelNode) return;

        var data = JSON.parse(modelNode.textContent || '{}');
        var accessible = accNode ? JSON.parse(accNode.textContent || '[]') : [];
        var accessibleSet = {};
        accessible.forEach(function (name) { accessibleSet[name] = true; });

        var model = core.buildModel(data);
        var canvas = canvasSize();
        var layout = core.computeLayout(model, canvas);
        var routes = core.planRoute(model, layout);
        var legend = core.buildLegend(model);

        // 站名密度：只影响字号与"是否画圆点序号"，标签最终给谁由下面的避让决定。
        var stationCount = Object.keys(model.stations).length;
        var dense = stationCount > 150;

        var svg = [];
        svg.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + canvas.width + ' ' + canvas.height +
            '" width="100%" height="100%" shape-rendering="geometricPrecision">');

        // ---- 线路 ----
        routes.forEach(function (route) {
            svg.push('<path d="' + route.d + '" fill="none" stroke="' + esc(route.color) +
                '" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"' +
                (route.isFuture ? ' stroke-dasharray="10 8" opacity="0.55"' : '') + '/>');
        });

        // ---- 车站 ----
        // 标签统一右对齐排布（与 metro_editor 的图一致：圆点在左、站名向右）。
        // 所有站都是候选，按"无障碍站 > 换乘站 > 普通站"的优先级贪心占位：
        // 大线网市中心几十站叠在一起，不避让文字会糊成一片，全标出来反而更看不清。
        var labels = [];
        var names = Object.keys(model.stations);
        names.forEach(function (name) {
            var station = model.stations[name];
            if (isNaN(station.lon) || isNaN(station.lat)) return;
            var p = layout.project(station.lon, station.lat);
            var dirKeys = model.stationToDirKeys[name] || [];
            // 换乘站按线路组去重：同一线路的两个方向只算一次。
            var groups = {};
            dirKeys.forEach(function (key) {
                model.rawDirections.forEach(function (dir) {
                    if (dir.key === key) groups[dir.groupKey] = true;
                });
            });
            var interchange = Object.keys(groups).length >= 2;
            var acc = !!accessibleSet[name];

            svg.push('<circle cx="' + p[0].toFixed(2) + '" cy="' + p[1].toFixed(2) + '" r="' +
                (dense ? (interchange ? 9 : 7) : 9) + '" fill="#fff" stroke="' + (acc ? '#2e7d32' : '#111') + '"' +
                (acc ? ' stroke-width="4"' : '') + '/>');

            // 字号是画布单位：1600 宽映射到阅读宽度时，30 号字约 16px。
            // 密集线网稍微收小一档，给避让多留点空隙。
            var fontSize = interchange ? (dense ? 26 : 30) : (dense ? 22 : 26);
            labels.push({
                name: name, x: p[0], y: p[1], acc: acc, fontSize: fontSize,
                // 经验宽度：中文按 1em，ASCII 按 0.55em，再加圆点偏移 14。
                w: textWidth(name, fontSize) + 14,
                // 无障碍站会额外标 ♿，多留一个字的宽度；它优先级也最高。
                rank: acc ? 3 : (interchange ? 2 : 1)
            });
        });

        // 优先级高的先占位：无障碍站要带 ♿，排在最前。
        labels.sort(function (a, b) { return b.rank - a.rank; });
        var placed = [];
        labels.forEach(function (lb) {
            var h = lb.fontSize * 1.05;
            var box = { x0: lb.x + 14, x1: lb.x + 14 + lb.w, y0: lb.y - h / 2, y1: lb.y + h / 2 };
            for (var i = 0; i < placed.length; i++) {
                var o = placed[i];
                if (box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0) return;
            }
            placed.push(box);
            svg.push('<text x="' + (lb.x + 14).toFixed(2) + '" y="' + (lb.y + lb.fontSize * 0.34).toFixed(2) +
                '" font-size="' + lb.fontSize + '" fill="#f2f4f8" stroke="#000" ' +
                'stroke-width="5" paint-order="stroke">' + esc(lb.name) + (lb.acc ? ' \u267f' : '') + '</text>');
        });

        svg.push('</svg>');
        document.getElementById('map').innerHTML = svg.join('');

        // ---- 图例（排序由内核给定，这里不再排） ----
        var legendHtml = ['<h2>' + esc(model.keyCity || '') + '</h2>'];
        if (accessible.length > 0) {
            legendHtml.push('<div class="row acc"><i style="background:#2e7d32"></i>\u267f 无障碍设施</div>');
        }
        legend.forEach(function (item) {
            legendHtml.push('<div class="row"><i style="background:' + esc(item.color) + '"></i>' +
                esc(item.name) + '</div>');
        });
        document.getElementById('legend').innerHTML = legendHtml.join('');
    }

    /**
     * @brief 估算文本在给定字号下的像素宽度（不依赖 canvas measureText，离线也能算）。
     * @param {string} text 文本。
     * @param {number} fontSize 字号（画布单位）。
     * @return {number} 宽度。
     */
    function textWidth(text, fontSize) {
        var em = 0;
        for (var i = 0; i < text.length; i++) {
            em += text.charCodeAt(i) > 0x2e7f ? 1 : 0.55;
        }
        return em * fontSize;
    }

    /** @brief 首次渲染 + 窗口变化时重排（无状态，直接重画）。 */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(render, 200);
    });
    render();
})();
