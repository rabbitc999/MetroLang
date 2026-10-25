/**
 * @file ui.js
 * @brief 线网调度游戏的渲染层：读数据集、画线网、跑模拟、刷面板。
 *
 * 与 `sim.js` 的分工：
 *   - `sim.js` 只管算（列车、客流、评分），不碰 DOM；
 *   - 本文件只管画与交互，**不改模拟状态**，唯一的写操作是通过 `sim` 的公开
 *     接口（`step`）与线路上的玩家可调项（`headwayScale` / `skip`）。
 *
 * 页面骨架由 `metro-lang game` 生成（见 `src/game_html.cpp`），数据集放在
 * `<script id="game-data" type="application/json">` 里，所以这个文件既可以
 * 被内嵌进单文件页面，也能在开发时直接以 `file://` 打开 `game/index.html`。
 *
 * 依赖：d3（内嵌在页面里，不走 CDN）。
 */
(function () {
    'use strict';

    var sim = (typeof window !== 'undefined' ? window : globalThis).MetroSim;
    var d3 = (typeof window !== 'undefined' ? window : globalThis).d3;

    // ==================================================================
    //  一、启动
    // ==================================================================

    /** @brief 把 `<script id="game-data">` 里的 JSON 读出来。 */
    function readData() {
        var node = document.getElementById('game-data');
        if (!node) return null;
        try {
            return JSON.parse(node.textContent || '{}');
        } catch (err) {
            console.error('数据集解析失败', err);
            return null;
        }
    }

    // ==================================================================
    //  一·五、渲染常量
    // ==================================================================
    //
    // 放在这里而不是 `View` 旁边：`View` 构造函数（建标签节点）就要用到
    // `LABEL_BASE`，`var` 只提升声明、不提升赋值，写在使用点之后就拿到
    // `undefined`——标签的 `y` 会变成 `NaN`，整层标签静默消失。

    /** @brief 最大放大倍数。再大就只剩几个站，没有信息增量。 */
    var ZOOM_MAX = 12;

    /**
     * @brief 标签基准字号（画布单位）。
     *
     * 实际渲染用 `LABEL_BASE / k`：放大 k 倍后字号按比例缩小，屏幕上的像素高度
     * 保持不变。这与缩放线条/站点的效果正相反——那些保持屏幕像素恒定，所以
     * 放大后看到的是更多细节，而不是更粗的线。
     */
    var LABEL_BASE = 9;

    /** @brief 标签屏幕尺度的下限 / 上限（画布单位），避免极端缩放时糊成一片或戳满屏。 */
    var LABEL_MIN = 3.2;
    var LABEL_MAX = 60;

    /** @brief 标签开关：默认开。关掉后只留线网，跑模拟时更干净。 */
    var labelsOn = true;

    // ==================================================================
    //  二、数据集归一化
    // ==================================================================

    /**
     * @brief 把数据集整理成 `sim.createGame` 认的形状。
     *
     * `metro-lang game --json` 给的 `lines` 是**字典**（键为线路 id），而
     * `prepare_data.py` 给的是数组；两者内容一致，这里统一成数组，顺带把
     * `headway` / `crowd` 的键换成字符串，省得内核里再判类型。
     *
     * @param {object} raw 原始数据集。
     * @return {object} 归一化后的数据集。
     */
    function normalize(raw) {
        var lines = raw.lines;
        if (!Array.isArray(lines)) {
            lines = Object.keys(lines).map(function (k) {
                var l = lines[k];
                l.id = l.id || k;
                return l;
            });
        }
        var stations = raw.stations || {};
        if (Array.isArray(stations)) {
            // 防御：万一上游给了数组，转回字典。查坐标、查线路都按站名做键，
            // 数组形式在这里没法用（`stations['广州南站']` 会是 undefined，
            // 投影全面失效，线网掉进网格兜底画成一团乱麻）。
            var smap = {};
            stations.forEach(function (s) { if (s && s.name) smap[s.name] = s; });
            stations = smap;
        }
        var headway = {};
        Object.keys(raw.headway || {}).forEach(function (k) { headway[k] = raw.headway[k]; });
        return {
            format: raw.format,
            city: raw.city,
            version: raw.version,
            params: raw.params || {},
            price: raw.price || {},
            transfer_types: raw.transfer_types || {},
            stations: stations,
            lines: lines,
            headway: headway,
            crowd: raw.crowd || {},
            stats: raw.stats || {},
        };
    }

    // ==================================================================
    //  三、骨架
    // ==================================================================

    /**
     * @brief 搭出三栏布局。
     * @param {Element} app 挂载点。
     * @param {object} data 数据集。
     */
    function buildSkeleton(app, data) {
        var city = data.city || '地铁';
        app.innerHTML =
            '<aside class="panel left" id="left">' +
              '<h1>' + esc(city) + ' 线网调度</h1>' +
              '<div class="sub" id="subline"></div>' +
              '<h2>运营指标</h2>' +
              '<div id="kpis"></div>' +
              '<h2>调度策略</h2>' +
              '<div class="control"><label>全网发车间隔</label>' +
                '<span class="readout" id="headwayReadout">×1.0</span></div>' +
              '<input type="range" id="headwayAll" min="0.5" max="2" step="0.05" value="1">' +
              '<div class="control"><label>全网运行速度</label>' +
                '<span class="readout" id="speedReadout">×1.0</span></div>' +
              '<input type="range" id="speedAll" min="0.6" max="1.2" step="0.05" value="1">' +
              '<label class="switch" id="skipWrap"><input type="checkbox" id="chkSkip">' +
                '<span>跳停策略（甩小站提周转）</span></label>' +
              '<div class="row" style="margin-top:14px">' +
                '<button id="btnFinish">直接收车</button>' +
              '</div>' +
            '</aside>' +
            '<main id="stage">' +
              '<div class="hint" id="stageHint">点「开始」发车</div>' +
              '<div class="zoomCtl" id="zoomCtl">' +
                '<button id="zoomIn" title="放大（滚轮上滚）">+</button>' +
                '<button id="zoomOut" title="缩小（滚轮下滚）">−</button>' +
                '<button id="zoomFit" title="回到全图（双击地图）">⤢</button>' +
                '<button id="toggleLabel" title="显示/隐藏站名（L）">Aa</button>' +
                '<span id="zoomPct">100%</span>' +
              '</div>' +
            '</main>' +
            '<aside class="panel right" id="right">' +
              '<h2>线路压力</h2>' +
              '<div id="lineList"></div>' +
            '</aside>' +
            '<div class="timeline">' +
              '<span class="clock" id="clock">06:00</span>' +
              '<button class="primary" id="btnPlay">开始</button>' +
              '<button id="btnFast">60×</button>' +
              '<button id="btnReset">重来</button>' +
              '<div class="track"><i id="progress"></i></div>' +
              '<span class="sub" id="dayRange" style="margin:0;white-space:nowrap"></span>' +
            '</div>' +
            '<div class="modal" id="modal" hidden></div>' +
            '<div id="toast"></div>';

        document.getElementById('subline').textContent =
            data.stats && data.stats.lines
                ? (data.stats.lines + ' 条线路 · ' +
                   // 用运营站数：站点表里还含只在规划段出现的站，玩家到不了。
                   (data.stats.stations_operating || data.stats.stations) + ' 座车站' +
                   // 规划段单独说明：玩家看到虚线要知道那是不运营的。
                   (data.stats.future ? ' · ' + (data.stats.future / 2 | 0) + ' 段在建' : ''))
                : '';
        document.getElementById('dayRange').textContent =
            sim.formatClock(sim.DAY_START) + ' – ' + sim.formatClock(sim.DAY_END);
    }

    // ==================================================================
    //  四、视图
    // ==================================================================

    /**
     * @brief 画布视图：一次性建好线网与列车槽位，之后每帧只改属性。
     *
     * 为什么不用 d3 的 enter/exit 每帧重建：367 站、6000 多个区间点、700 多列车，
     * 每帧重建 DOM 会直接卡死。这里只在开新局时建一次，之后按 id 更新 `cx/cy`。
     *
     * @param {object} state 全局状态。
     * @constructor
     */
    function View(state) {
        var stage = document.getElementById('stage');
        stage.querySelectorAll('svg').forEach(function (n) { n.remove(); });
        var hint = document.getElementById('stageHint');
        if (hint) hint.remove();

        var width = stage.clientWidth || 800;
        var height = stage.clientHeight || 600;

        // ---- 坐标：把经纬度等比投到画布上，留边 ----
        //
        // 投影用的站表比 `state.allStations` 多一类：**规划段独有的站**
        // （广州 12 号线的 `东湖` / `烈士陵园` 等）。它们不在运营线网里，
        // 不参与调度，但要画在图上，否则规划段会断成几截、看不出走向。
        var stations = state.data.stations;
        var geoStations = state.allStations.slice();
        state.lines.forEach(function (line) {
            (line.futureSegments || []).forEach(function (seg) {
                seg.stops.forEach(function (stop) {
                    if (geoStations.indexOf(stop.name) < 0) geoStations.push(stop.name);
                });
            });
        });

        var coords = {};
        var lon = [], lat = [];
        geoStations.forEach(function (name) {
            var s = stations[name];
            if (!s || !isFinite(s.lon) || !isFinite(s.lat)) return;
            coords[name] = [s.lon, s.lat];
            lon.push(s.lon);
            lat.push(s.lat);
        });
        var hasGeo = lon.length > 4;
        var project;
        if (hasGeo) {
            var lonMin = Math.min.apply(null, lon), lonMax = Math.max.apply(null, lon);
            var latMin = Math.min.apply(null, lat), latMax = Math.max.apply(null, lat);
            var pad = 56;
            var midLat = (latMin + latMax) / 2;
            // 墨卡托的横纵比：纬度方向的度数更「长」，按 cos(lat) 校正才不变形。
            var kx = Math.cos(midLat * Math.PI / 180);
            var spanX = Math.max(1e-6, (lonMax - lonMin) * kx);
            var spanY = Math.max(1e-6, latMax - latMin);
            var scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
            var ox = (width - spanX * scale) / 2;
            var oy = (height - spanY * scale) / 2;
            project = function (name) {
                var c = coords[name];
                if (!c) return null;
                return [ox + (c[0] - lonMin) * kx * scale, oy + (latMax - c[1]) * scale];
            };
        } else {
            // 没坐标就按站号排成网格，保证还能玩（样例里通常都有坐标）。
            var cols = Math.ceil(Math.sqrt(geoStations.length));
            var idx = {};
            geoStations.forEach(function (n, i) { idx[n] = i; });
            project = function (name) {
                var i = idx[name];
                if (i === undefined) return null;
                return [80 + (i % cols) * 44, 80 + Math.floor(i / cols) * 44];
            };
        }

        // viewBox 之后由相机（`applyCamera`）接管：缩放靠改它，不改图层 transform。
        var svg = d3.select(stage).append('svg')
            .attr('preserveAspectRatio', 'xMidYMid meet');

        // 城市格子图层（游戏 2 的地价热度 / 楼盘）。空着不占事：游戏 1 里
        // 这一组永远没有子节点，也不响应指针。
        var gCity = svg.append('g').attr('class', 'city');
        var gLine = svg.append('g').attr('class', 'lines');
        var gTrain = svg.append('g').attr('class', 'trains');
        var gStation = svg.append('g').attr('class', 'stations');

        // ---- 线路：每条线按站点折线画，支线单独一条 ----
        state.lines.forEach(function (line) {
            line.segments.forEach(function (seg, si) {
                var pts = [];
                seg.stops.forEach(function (stop) {
                    var p = project(stop.name);
                    if (p) pts.push(p);
                });
                if (pts.length < 2) return;
                gLine.append('path')
                    .attr('d', d3.line().curve(d3.curveCatmullRom.alpha(0.5))(pts))
                    .attr('fill', 'none')
                    .attr('stroke', line.color)
                    .attr('stroke-width', si === 0 ? 4 : 2.5)
                    .attr('stroke-opacity', si === 0 ? 0.85 : 0.6)
                    .attr('stroke-linecap', 'round')
                    .attr('stroke-linejoin', 'round');
            });
        });

        // ---- 规划段：虚线、更淡，不参与调度 ----
        // 画出来是为了让玩家看懂「这条线本来要往哪儿修」，但它是不可用的：
        // 列车不会跑上去，乘客也不会在那儿上下车。
        var gFuture = svg.append('g').attr('class', 'future');
        state.lines.forEach(function (line) {
            (line.futureSegments || []).forEach(function (seg) {
                var pts = [];
                seg.stops.forEach(function (stop) {
                    var p = project(stop.name);
                    if (p) pts.push(p);
                });
                if (pts.length < 2) return;
                gFuture.append('path')
                    .attr('d', d3.line().curve(d3.curveCatmullRom.alpha(0.5))(pts))
                    .attr('fill', 'none')
                    .attr('stroke', line.color)
                    .attr('stroke-width', 2)
                    .attr('stroke-opacity', 0.35)
                    .attr('stroke-dasharray', '5 4')
                    .attr('stroke-linecap', 'round');
            });
        });

        // ---- 站点：只在换乘站画点，单线小站画了也是糊成一片 ----
        state.allStations.forEach(function (name) {
            var p = project(name);
            if (!p) return;
            var n = (state.stationLines[name] || []).length;
            if (n < 2) return;
            gStation.append('circle')
                .attr('cx', p[0]).attr('cy', p[1])
                .attr('r', Math.min(6, 2.5 + n * 0.8))
                .attr('fill', '#0f1115')
                .attr('stroke', '#cfd6e2')
                .attr('stroke-width', 1.6);
        });

        // ---- 站名标签 ----
        //
        // 策略照搬 `map_view/js/app.js`：
        //   1. 字号按 `1/k` 反向缩放，屏幕上大小恒定（放大后不会变成巨字）；
        //   2. 贪心避让：换乘站优先、多线站次之，矩形与已放置的重叠就隐藏。
        //
        // 全部站都建节点（800 个 `<text>` 一次性建好，之后只改 `display`），
        // 每帧重建 DOM 会卡死——和列车槽位是同一个道理。
        var labelData = [];
        geoStations.forEach(function (name) {
            var p = project(name);
            if (!p) return;
            var nLines = (state.stationLines[name] || []).length;
            labelData.push({
                name: name,
                x: p[0],
                y: p[1],
                // 优先级：换乘站 3 > 单线 1；规划站没有运营线路，给 1。
                rank: nLines >= 2 ? 3 : 1,
            });
        });
        var gLabel = svg.append('g').attr('class', 'labels');
        gLabel.selectAll('text')
            .data(labelData)
            .enter()
            .append('text')
            .attr('class', 'station-label')
            .attr('x', function (d) { return d.x; })
            .attr('y', function (d) { return d.y - LABEL_BASE; })
            .attr('text-anchor', 'middle')
            .attr('pointer-events', 'none')
            .text(function (d) { return d.name; });

        // ---- 列车：槽位先建好，之后每帧只改 cx/cy ----
        var trainNodes = {};
        state.lines.forEach(function (line) {
            trainNodes[line.id] = {};
        });

        this.state = state;
        this.stage = stage;
        this.svg = svg;
        this.gCity = gCity;
        this.gTrain = gTrain;
        this.gLabel = gLabel;
        this.project = project;
        // 反投影：画布坐标 → 经纬度。在图上叠自定义图层时要靠它换算，
        // 否则得在外面再推一遍投影参数，两边迟早对不上。
        this.unproject = function (x, y) {
            if (!hasGeo) return null;
            var lonDeg = lonMin + (x - ox) / (kx * scale);
            var latDeg = latMax - (y - oy) / scale;
            return [lonDeg, latDeg];
        };
        // 正投影：经纬度 → 画布坐标。
        //
        // `project` 只认**建视图时就在 `geoStations` 里**的站名，游戏 2 的
        // 城市格子（上千个点）不在那个表里，拿 `project` 全返回 null。
        // 这里直接给公式，不查表——格子、规划点、任何任意经纬度都能投。
        this.lonlatToXY = function (lonDeg, latDeg) {
            if (!hasGeo) return null;
            return [ox + (lonDeg - lonMin) * kx * scale, oy + (latMax - latDeg) * scale];
        };
        this.trainNodes = trainNodes;
        this.width = width;
        this.height = height;

        // 相机：`k` 是放大倍数，`cx/cy` 是视口中心（画布坐标系）。
        // 用 `viewBox` 而不是 `transform` 缩放——`transform` 会把线宽、站半径、
        // 列车半径一起放大，放大了反而更糊；改 `viewBox` 时这些都是屏幕像素，
        // 放大后看到的只是**更多细节**，不是更粗的线。
        this.camera = { k: 1, cx: width / 2, cy: height / 2 };
        this.bindZoom();
    }

    // ==================================================================
    //  四·一、缩放与平移
    // ==================================================================

    /**
     * @brief 估算标签宽度（画布单位）。
     *
     * CJK 每字约 1em，ASCII 约 0.55em。不需要精确——只用来判断重叠。
     * @param {string} text 站名。
     * @param {number} size 字号。
     * @return {number} 宽度。
     */
    function labelWidth(text, size) {
        var em = 0;
        for (var i = 0; i < text.length; i++) em += text.charCodeAt(i) > 0x2e7f ? 1 : 0.55;
        return em * size + 4;
    }

    /**
     * @brief 按当前缩放重排标签：改字号 + 贪心避让。
     *
     * 只对**当前视口内**的站做避让——视口外的站反正看不见，白算。
     *
     * @param {object} view View 实例。
     */
    View.prototype.layoutLabels = function () {
        var cam = this.camera;
        var gLabel = this.gLabel;
        if (!gLabel) return;

        // 关掉标签时直接全隐藏，不做任何计算。
        if (!labelsOn) {
            gLabel.selectAll('text').style('display', 'none');
            return;
        }

        var size = Math.max(LABEL_MIN, Math.min(LABEL_MAX, LABEL_BASE / cam.k));
        var asc = size; // 标签在站点上方约一个字高

        // 视口范围（画布坐标），留点余量。
        var halfW = this.width / cam.k / 2 + size * 4;
        var halfH = this.height / cam.k / 2 + size * 4;
        var x0 = cam.cx - halfW, x1 = cam.cx + halfW;
        var y0 = cam.cy - halfH, y1 = cam.cy + halfH;

        var nodes = gLabel.selectAll('text').nodes();
        var cand = [];
        nodes.forEach(function (node) {
            var d = node.__data__;
            if (!d) return;
            if (d.x < x0 || d.x > x1 || d.y < y0 || d.y > y1) {
                node.style.display = 'none';
                return;
            }
            cand.push(d);
        });

        // 换乘站优先，其余按纵向位置从上往下扫。
        cand.sort(function (a, b) {
            if (b.rank !== a.rank) return b.rank - a.rank;
            return a.y - b.y;
        });

        var placed = [];
        var visible = {};
        cand.forEach(function (d) {
            var w = labelWidth(d.name, size);
            var h = size + 1.5;
            var cx = d.x;
            var cy = d.y - asc - h / 2;
            for (var i = 0; i < placed.length; i++) {
                var r = placed[i];
                if (Math.abs(cx - r.cx) < (w + r.w) / 2 && Math.abs(cy - r.cy) < (h + r.h) / 2) return;
            }
            placed.push({ cx: cx, cy: cy, w: w, h: h });
            visible[d.name] = true;
        });

        nodes.forEach(function (node) {
            var d = node.__data__;
            if (!d) return;
            var on = visible[d.name] === true;
            node.style.display = on ? '' : 'none';
            if (!on) return;
            node.setAttribute('x', d.x);
            node.setAttribute('y', d.y - asc - 2);
            node.setAttribute('font-size', size);
            // 描边宽度也是画布单位：按 1/k 缩放才能在屏幕上恒为约 2.2px。
            node.setAttribute('stroke-width', Math.max(0.6, 2.2 / cam.k));
        });
    };

    /**
     * @brief 把相机状态写到 `viewBox` 上。
     *
     * `viewBox` 的宽高是画布尺寸除以放大倍数，中心跟着 `cx/cy` 走；因此
     * 屏幕坐标 `(sx, sy)` 对应的画布坐标是
     * `cx + (sx - width/2) / k`，下面 `zoomAt` 就用这个式子做「以光标为中心」。
     */
    View.prototype.applyCamera = function () {
        var cam = this.camera;
        var w = this.width / cam.k;
        var h = this.height / cam.k;
        // 别让视口跑出线网外太空：中心限制在画布范围内。
        cam.cx = Math.max(0, Math.min(this.width, cam.cx));
        cam.cy = Math.max(0, Math.min(this.height, cam.cy));
        this.svg.attr('viewBox', (cam.cx - w / 2) + ' ' + (cam.cy - h / 2) + ' ' + w + ' ' + h);
        var pct = document.getElementById('zoomPct');
        if (pct) pct.textContent = Math.round(cam.k * 100) + '%';
        this.layoutLabels();
    };

    /**
     * @brief 以某个**画布坐标**为锚点缩放。
     * @param {number} factor 倍数（>1 放大）。
     * @param {number} ax 锚点 x（画布坐标）。
     * @param {number} ay 锚点 y（画布坐标）。
     */
    View.prototype.zoomAt = function (factor, ax, ay) {
        var cam = this.camera;
        var next = Math.max(1, Math.min(ZOOM_MAX, cam.k * factor));
        if (Math.abs(next - cam.k) < 1e-9) return;
        // 让锚点下的那个画布点在缩放前后保持不动：
        //   ax = cx + (ax - cx) * (k / next)
        var ratio = cam.k / next;
        cam.cx = ax + (cam.cx - ax) * ratio;
        cam.cy = ay + (cam.cy - ay) * ratio;
        cam.k = next;
        this.applyCamera();
    };

    /** @brief 回到全图。 */
    View.prototype.zoomFit = function () {
        this.camera.k = 1;
        this.camera.cx = this.width / 2;
        this.camera.cy = this.height / 2;
        this.applyCamera();
    };

    /**
     * @brief 绑定滚轮缩放、拖拽平移、双击复位与按钮。
     *
     * 注意鼠标事件给的是**屏幕像素**，要先换算成画布坐标再交给 `zoomAt`，
     * 否则放大后每次滚轮都会跳一下（缩放中心漂移）。
     */
    View.prototype.bindZoom = function () {
        var self = this;
        var svgNode = this.svg.node();
        var cam = this.camera;

        /** @brief 屏幕坐标 → 画布坐标。 */
        function toCanvas(evt) {
            var rect = svgNode.getBoundingClientRect();
            if (!rect.width || !rect.height) return [cam.cx, cam.cy];
            // getBoundingClientRect 是**显示**尺寸，viewBox 是画布尺寸，
            // 两者的比例就是换算系数。
            var sx = (evt.clientX - rect.left) / rect.width * self.width;
            var sy = (evt.clientY - rect.top) / rect.height * self.height;
            return [sx, sy];
        }

        svgNode.addEventListener('wheel', function (evt) {
            evt.preventDefault();
            var p = toCanvas(evt);
            // 每格滚轮 1.15 倍，手感接近地图应用。
            self.zoomAt(evt.deltaY < 0 ? 1.15 : 1 / 1.15, p[0], p[1]);
        }, { passive: false });

        var dragging = false, lastX = 0, lastY = 0, moved = 0;
        svgNode.addEventListener('pointerdown', function (evt) {
            // 只接左键；触摸/笔也走这条（pointer 事件统一）。
            if (evt.button !== 0) return;
            dragging = true;
            moved = 0;
            lastX = evt.clientX;
            lastY = evt.clientY;
            svgNode.classList.add('dragging');
            svgNode.setPointerCapture(evt.pointerId);
        });

        svgNode.addEventListener('pointermove', function (evt) {
            if (!dragging) return;
            var rect = svgNode.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            // 屏幕位移换算到画布位移：画布 1 单位 = rect.width / width 屏幕像素。
            var dx = (evt.clientX - lastX) / rect.width * self.width;
            var dy = (evt.clientY - lastY) / rect.height * self.height;
            lastX = evt.clientX;
            lastY = evt.clientY;
            moved += Math.abs(dx) + Math.abs(dy);
            // 拖地图 = 相机往反方向走。
            cam.cx -= dx;
            cam.cy -= dy;
            self.applyCamera();
        });

        function endDrag(evt) {
            if (!dragging) return;
            dragging = false;
            svgNode.classList.remove('dragging');
            try { svgNode.releasePointerCapture(evt.pointerId); } catch (e) { /* 已释放 */ }
        }
        svgNode.addEventListener('pointerup', endDrag);
        svgNode.addEventListener('pointercancel', endDrag);

        svgNode.addEventListener('dblclick', function () { self.zoomFit(); });

        var bind = function (id, fn) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        };
        bind('zoomIn', function () { self.zoomAt(1.4, cam.cx, cam.cy); });
        bind('zoomOut', function () { self.zoomAt(1 / 1.4, cam.cx, cam.cy); });
        bind('zoomFit', function () { self.zoomFit(); });

        // 站名开关：按钮上的 `Aa` 变暗表示已关。
        var btnLabel = document.getElementById('toggleLabel');
        function syncLabelBtn() {
            if (!btnLabel) return;
            btnLabel.classList.toggle('off', !labelsOn);
            btnLabel.title = labelsOn ? '隐藏站名（L）' : '显示站名（L）';
        }
        function toggleLabels() {
            labelsOn = !labelsOn;
            syncLabelBtn();
            self.layoutLabels();
        }
        if (btnLabel) btnLabel.addEventListener('click', toggleLabels);
        syncLabelBtn();

        // 键盘：+/- 缩放，0 复位，L 开关站名。跑模拟时手不用离开键盘。
        window.addEventListener('keydown', function (evt) {
            var tag = (evt.target && evt.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (evt.key === '+' || evt.key === '=') { self.zoomAt(1.3, cam.cx, cam.cy); }
            else if (evt.key === '-' || evt.key === '_') { self.zoomAt(1 / 1.3, cam.cx, cam.cy); }
            else if (evt.key === '0') { self.zoomFit(); }
            else if (evt.key === 'l' || evt.key === 'L') { toggleLabels(); }
        });

        this.applyCamera();
    };

    /**
     * @brief 每帧刷新列车位置。车辆数会变（补车），按需补槽位。
     */
    View.prototype.renderTrains = function () {
        var project = this.project;
        var gTrain = this.gTrain;
        var nodes = this.trainNodes;
        var capOf = this.state.capacityOf;

        this.state.lines.forEach(function (line) {
            var bucket = nodes[line.id];
            var cap = capOf[line.id] || 1860;
            line.trains.forEach(function (tr) {
                var pos = trainPos(line, tr, project);
                if (!pos) return;
                var key = tr.id;
                var node = bucket[key];
                if (!node) {
                    node = gTrain.append('circle')
                        .attr('fill', line.color)
                        .attr('stroke', '#0f1115')
                        .attr('stroke-width', 0.8);
                    bucket[key] = node;
                }
                // 挤不挤直接看颜色：绿色空、黄色站人、红色贴门。
                var f = tr.onboard.length / cap;
                var color = f > 0.9 ? '#e05c5c' : (f > 0.6 ? '#e6b450' : line.color);
                node.attr('cx', pos[0]).attr('cy', pos[1])
                    .attr('r', 2.6 + Math.min(3.4, f * 4))
                    .attr('fill', color)
                    .attr('opacity', tr.waiting ? 0.45 : 1);
            });
        });
    };

    /**
     * @brief 一列车在画布上的位置。
     *
     * `tr.at` 是列车**当前所在站**，`tr.p` 是它离开该站后走过的比例（0→1）。
     * 所以只要知道「开往的下一站」就能线性插值出位置。`dir` 决定下一站在哪一侧：
     * `dir>0` 时下一站是 `at+1`，否则是 `at-1`。
     *
     * @param {object} line 线路。
     * @param {object} tr 列车。
     * @param {function} project 站名 → 画布坐标。
     * @return {Array<number>|null} `[x, y]`。
     */
    function trainPos(line, tr, project) {
        var seg = line.segments[tr.seg];
        if (!seg || !seg.stops[tr.at]) return null;
        var a = project(seg.stops[tr.at].name);
        if (!a) return null;
        if (tr.leg < 0 || !(tr.p > 0)) return a;
        var nextIdx = tr.dir > 0 ? tr.at + 1 : tr.at - 1;
        var nextStop = seg.stops[nextIdx];
        if (!nextStop) return a;
        var b = project(nextStop.name);
        if (!b) return a;
        return [a[0] + (b[0] - a[0]) * tr.p, a[1] + (b[1] - a[1]) * tr.p];
    }

    // ==================================================================
    //  五、刷新
    // ==================================================================

    var ctx = null;   // start() 建立的闭包引用，供各 refresh 函数取

    /** @brief 开新局后整页刷新（指标、线路榜、画布）。 */
    function refreshAll() {
        refreshFrame();
    }

    /** @brief 每帧刷新。 */
    function refreshFrame() {
        var state = ctx.state, view = ctx.view;
        if (!state) return;
        view.state = state;
        view.renderTrains();
        renderKpis(state);
        renderLineList(state);
        setClock();
    }

    /**
     * @brief 左侧运营指标。
     * @param {object} state 全局状态。
     */
    function renderKpis(state) {
        var sum = sim.summary(state);
        var rows = [
            ['已发车', sum.departures + ' 班', ''],
            ['进站客流', fmt(sum.arrivals) + ' 人', ''],
            ['平均等车', fmtWait(sum.avgWait), waitClass(sum.avgWait)],
            ['最大断面满载', (sum.loadFactor * 100).toFixed(0) + '%', loadClass(sum.loadFactor)],
            ['准点率', (sum.punctuality * 100).toFixed(0) + '%', sum.punctuality > 0.95 ? 'ok' : 'warn'],
            ['缺车次数', sum.shortage + ' 次', sum.shortage < 40 ? 'ok' : (sum.shortage < 150 ? 'warn' : 'bad')],
            ['在途列车', sum.trains + ' / ' + sum.fleet + ' 列', ''],
        ];
        var html = rows.map(function (r) {
            return '<div class="kpi"><span class="label">' + r[0] + '</span>' +
                   '<span class="value ' + r[2] + '">' + r[1] + '</span></div>';
        }).join('');
        var box = document.getElementById('kpis');
        if (box.innerHTML !== html) box.innerHTML = html;
    }

    /**
     * @brief 右侧线路压力榜。
     * @param {object} state 全局状态。
     */
    function renderLineList(state) {
        var stats = sim.lineStats(state).slice(0, 12);
        var html = stats.map(function (s) {
            var f = Math.min(1, s.loadFactor);
            var color = f > 0.9 ? '#e05c5c' : (f > 0.6 ? '#e6b450' : '#4ec9a0');
            return '<div class="lineRow">' +
                     '<i class="swatch" style="background:' + s.color + '"></i>' +
                     '<div><div class="name">' + esc(s.name) + '</div>' +
                       '<div class="meta">间隔 ' + s.headway + 's · 候车 ' + s.awaiting + ' 人</div></div>' +
                     '<div class="meta">' + (f * 100).toFixed(0) + '%</div>' +
                     '<div class="bar"><i style="width:' + (f * 100).toFixed(0) + '%;background:' + color + '"></i></div>' +
                   '</div>';
        }).join('');
        var box = document.getElementById('lineList');
        if (box.innerHTML !== html) box.innerHTML = html;
    }

    /** @brief 时间轴上的时钟与进度条。 */
    function setClock() {
        var state = ctx.state;
        if (!state) return;
        document.getElementById('clock').textContent = sim.formatClock(state.now);
        var span = Math.max(1, state.dayEnd - state.dayStart);
        var pct = Math.max(0, Math.min(100, (state.now - state.dayStart) / span * 100));
        document.getElementById('progress').style.width = pct.toFixed(1) + '%';
    }

    // ==================================================================
    //  六、玩家操作
    // ==================================================================

    /** @brief 全网发车间隔倍率。 */
    function onHeadwayAll(e) {
        var v = parseFloat(e.target.value);
        document.getElementById('headwayReadout').textContent = '×' + v.toFixed(1);
        ctx.state.global.headwayScale = v;
        refreshFrame();
    }

    /** @brief 全网运行速度倍率（模拟「提速 / 限速」）。 */
    function onSpeedAll(e) {
        var v = parseFloat(e.target.value);
        document.getElementById('speedReadout').textContent = '×' + v.toFixed(1);
        ctx.state.global.speedScale = v;
        refreshFrame();
    }

    /**
     * @brief 跳停开关：每条线各甩掉约三成的中间小站。
     *
     * 真实调度里「大站快车」就是这么干的。这里把它做成一个开关而不是逐站配置，
     * 是为了让玩家先理解「甩站能提周转，但会漏客」这个权衡。
     */
    function onSkipToggle(e) {
        var on = e.target.checked;
        document.getElementById('skipWrap').classList.toggle('on', on);
        ctx.state.lines.forEach(function (line) {
            line.skip = {};
            if (!on) return;
            var stops = line.main.stops;
            // 均匀甩掉：每隔 3 站跳 1 站，首尾与换乘站必须停。
            for (var i = 2; i < stops.length - 2; i += 3) {
                var name = stops[i].name;
                if ((ctx.state.stationLines[name] || []).length > 1) continue;
                line.skip[name] = true;
            }
        });
        toast(on ? '已开启跳停：甩小站提周转' : '已关闭跳停');
    }

    // ==================================================================
    //  七、结算
    // ==================================================================

    /** @brief 弹出结算卡。 */
    function showResult() {
        var state = ctx.state;
        var r = sim.result(state);
        var items = r.score.items.map(function (it) {
            var color = it.score >= 80 ? '#4ec9a0' : (it.score >= 50 ? '#e6b450' : '#e05c5c');
            return '<div class="item">' +
                     '<span>' + it.name + '</span>' +
                     '<span class="bar"><i style="width:' + it.score.toFixed(0) + '%;background:' + color + '"></i></span>' +
                     '<span class="score">' + it.value + '</span>' +
                   '</div>';
        }).join('');
        var modal = document.getElementById('modal');
        modal.innerHTML =
            '<div class="card">' +
              '<h2>收车结算</h2>' +
              '<div class="sub">' + sim.formatClock(state.dayStart) + ' – ' + r.clock +
                ' · 进站 ' + fmt(r.arrivals) + ' 人 · 到达 ' + fmt(r.arrived) + ' 人</div>' +
              '<div class="total"><span class="num">' + r.score.total + '</span>' +
                '<span class="sub" style="margin:0">分 / 100</span></div>' +
              items +
              '<div class="row" style="margin-top:20px">' +
                '<button class="primary" id="btnAgain">再来一局</button>' +
                '<button id="btnClose">看看线网</button>' +
              '</div>' +
            '</div>';
        modal.hidden = false;
        document.getElementById('btnAgain').addEventListener('click', function () {
            hideResult();
            ctx.reset(Math.floor(Math.random() * 1e6));
        });
        document.getElementById('btnClose').addEventListener('click', hideResult);
    }

    function hideResult() {
        var modal = document.getElementById('modal');
        modal.hidden = true;
        modal.innerHTML = '';
    }

    // ==================================================================
    //  八、小工具
    // ==================================================================

    /** @brief HTML 转义。 */
    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    /** @brief 千人分隔。 */
    function fmt(n) {
        return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** @brief 等待时长：超过 60 s 用「分秒」。 */
    function fmtWait(s) {
        if (s < 60) return Math.round(s) + ' 秒';
        return Math.floor(s / 60) + ' 分 ' + Math.round(s % 60) + ' 秒';
    }

    function waitClass(s) {
        return s < 300 ? 'ok' : (s < 480 ? 'warn' : 'bad');
    }

    function loadClass(f) {
        return (f >= 0.45 && f <= 0.9) ? 'ok' : (f < 0.45 ? '' : 'warn');
    }

    /** @brief 底部提示。 */
    var toastTimer = 0;
    function toast(text) {
        var node = document.getElementById('toast');
        if (!node) return;
        node.textContent = text;
        node.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { node.classList.remove('show'); }, 1800);
    }

    /** @brief 抖动抑制。 */
    function debounce(fn, ms) {
        var t = 0;
        return function () {
            var args = arguments;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(null, args); }, ms);
        };
    }

    /** @brief 窗口尺寸变了：重算坐标，重画线网。 */
    function layout() {
        if (!ctx || !ctx.state) return;
        ctx.view = new View(ctx.state);
        ctx.view.renderTrains();
    }

    // ==================================================================
    //  九、真正启动
    // ==================================================================

    /**
     * @brief 改造 boot 里的闭包：把 reset / state / view 暴露给渲染函数。
     *
     * 拆出 `start()` 是为了让 `boot()` 保持线性可读；这里只做装配。
     */
    function start() {
        var data = readData();
        var app = document.getElementById('app');
        if (!app) return;
        if (!data || !data.lines || !Object.keys(data.lines).length) {
            app.innerHTML = '<div class="hint">数据集是空的：需要一份含线路的 MetroLang 文件。</div>';
            return;
        }
        if (!sim || !d3) {
            app.innerHTML = '<div class="hint">缺少运行库（sim.js / d3）。</div>';
            return;
        }

        var dataset = normalize(data);
        buildSkeleton(app, dataset);

        var speed = 60;
        var playing = false;
        var acc = 0;
        var lastTs = 0;
        var raf = 0;

        ctx = {
            state: null,
            view: null,
            // 对外暴露 `View`，方便在别的入口里按新状态重建画布。
            View: View,
            reset: function (seed) {
                ctx.state = sim.createGame(dataset, { seed: seed === undefined ? 20261017 : seed });
                ctx.view = new View(ctx.state);
                ctx.view.renderTrains();
                refreshFrame();
                setPlaying(false);
            },
            dataset: dataset,
        };

        function setPlaying(on) {
            playing = on;
            var btn = document.getElementById('btnPlay');
            btn.textContent = on ? '暂停' : '开始';
            btn.classList.toggle('primary', !on);
            if (on) {
                lastTs = 0;
                if (!raf) raf = requestAnimationFrame(tick);
            }
        }

        function tick(ts) {
            if (!playing) { raf = 0; return; }
            if (!lastTs) lastTs = ts;
            var realDt = Math.min(0.25, (ts - lastTs) / 1000);
            lastTs = ts;
            acc += realDt * speed;

            var guard = 0;
            while (acc >= ctx.state.frame && !ctx.state.finished && guard++ < 400) {
                sim.step(ctx.state);
                acc -= ctx.state.frame;
            }
            if (ctx.state.finished) {
                setPlaying(false);
                refreshFrame();
                showResult();
            }
            refreshFrame();
            raf = playing ? requestAnimationFrame(tick) : 0;
        }

        document.getElementById('btnPlay').addEventListener('click', function () {
            if (ctx.state.finished) return;
            setPlaying(!playing);
        });
        document.getElementById('btnFast').addEventListener('click', function () {
            speed = speed >= 600 ? 60 : speed * 2;
            document.getElementById('btnFast').textContent = speed + '×';
        });
        document.getElementById('btnReset').addEventListener('click', function () {
            hideResult();
            ctx.reset(Math.floor(Math.random() * 1e6));
            toast('新的一局');
        });
        document.getElementById('btnFinish').addEventListener('click', function () {
            if (!ctx.state || ctx.state.finished) return;
            var guard = 0;
            while (!ctx.state.finished && guard++ < 200000) sim.step(ctx.state);
            setPlaying(false);
            refreshFrame();
            showResult();
        });
        document.getElementById('headwayAll').addEventListener('input', onHeadwayAll);
        document.getElementById('speedAll').addEventListener('input', onSpeedAll);
        document.getElementById('chkSkip').addEventListener('change', onSkipToggle);
        window.addEventListener('resize', debounce(function () {
            if (!ctx.state) return;
            ctx.view = new View(ctx.state);
            refreshFrame();
        }, 140));

        ctx.reset();
    }

    // 测试挂钩：`game/test/ui.js` 要在 jsdom 里拿到 `View` 与当前 ctx 才能
    // 量缩放/标签的实际属性。浏览器里没人读它，挂上去没有副作用。
    window.__metroGame = {
        get ctx() { return ctx; },
        View: View,
        labelsOn: function (v) {
            if (v === undefined) return labelsOn;
            labelsOn = v;
            return labelsOn;
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
