/*!
 * metro_mapcore.js —— MetroLang 地图绘图内核（可单文件内嵌）
 *
 * 设计目标：**这份文件既是浏览器脚本，也是 `metro-lang html` 的内嵌源**。
 *
 *   - 不依赖 DOM、不依赖 D3：所有函数是纯计算（模型 → 绘图数据），
 *     既能被 `map_view` 的交互页调用，也能被 C++ 端拼进静态 HTML；
 *   - 只在**宿主显式调用**时才导出到全局（`mount()`），文件本身不带副作用，
 *     所以 `require()` 进来做单元测试也干净；
 *   - 唯一的外部依赖是宿主的 `d3`（只在 `mount()` 里用），测试时可注入桩。
 *
 * 对外 API（`createCore()` 的返回值）：
 *
 *   buildModel(data)          → 归一化模型：方向表、合并线路、显隐开关
 *   computeLayout(model, cx)  → 投影与缩放（Web 墨卡托比例 + 等比居中）
 *   planRoute(model, layout)  → 每条线路的折线点、平滑点、路段类型分段
 *   collectStationInfo(...)   → 站点配色、快车/交路/暂缓标签
 *   buildLegend(model)        → 图例条目（按线路名排序）
 *
 * 坐标：`stations[].lon/lat` 是 WGS-84 经纬度；布局用**等比**缩放
 * （1 度经度与 1 度纬度等长），与 `src/html.cpp` 的投影口径一致。
 */
(function (global, factory) {
    'use strict';
    var core = factory();
    if (typeof module === 'object' && module.exports) module.exports = core;
    // 浏览器里挂到全局，等宿主调用 mount()。
    if (global) global.MetroMapCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this,
function () {
    'use strict';

    /** @brief 版本号：内嵌到生成物里，方便对照。 */
    var VERSION = '1.0.0';

    // ============================================================
    //  1. 工具函数（排序 & 亮度）
    // ============================================================

    /**
     * @brief 取线路名的非数字前缀（"地铁1号线" → "地铁"，"1号线" → ""）。
     * @param {string} name 线路名。
     * @return {string} 前缀。
     */
    function extractPrefix(name) {
        var match = String(name).match(/^\D*/);
        return match ? match[0] : '';
    }

    /**
     * @brief 取名字里的第一个数字（"8号线" → 8）。
     * @param {string} name 线路名。
     * @return {number} 数字；没有返回 -1。
     */
    function extractLineNumber(name) {
        var match = String(name).match(/\d+/);
        return match ? parseInt(match[0], 10) : -1;
    }

    /**
     * @brief 线路名排序：无前缀优先，然后按前缀、按数字、按字典序。
     * @param {string} nameA 名字 A。
     * @param {string} nameB 名字 B。
     * @return {number} 比较结果。
     */
    function compareLineName(nameA, nameB) {
        var prefixA = extractPrefix(nameA);
        var prefixB = extractPrefix(nameB);
        if ((prefixA === '') !== (prefixB === '')) return prefixA === '' ? -1 : 1;
        if (prefixA !== prefixB) return prefixA.localeCompare(prefixB);
        var numA = extractLineNumber(nameA);
        var numB = extractLineNumber(nameB);
        if (numA !== numB) return numA - numB;
        return String(nameA).localeCompare(String(nameB));
    }

    /**
     * @brief 按背景色亮度挑前景色（深色底用白字）。
     * @param {string} hexColor `#rgb` / `#rrggbb`。
     * @return {string} `#fff` 或 `#000`。
     */
    function getContrastTextColor(hexColor) {
        var value = String(hexColor || '#888');
        var hex = value.charAt(0) === '#' ? value.substring(1) : value;
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        var num = parseInt(hex, 16);
        if (isNaN(num)) return '#000';
        var r = (num >> 16) & 255;
        var g = (num >> 8) & 255;
        var b = num & 255;
        // 相对亮度（sRGB 近似，够用）。
        var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.6 ? '#000' : '#fff';
    }

    // ============================================================
    //  2. 平滑曲线（Catmull-Rom → 采样点）
    // ============================================================

    /**
     * @brief 把折线点插值成平滑曲线（Catmull-Rom，首尾各补一个镜像点）。
     *
     * @param {Array<Array<number>|{x:number,y:number}>} points 折线点。
     * @param {boolean} closed 是否闭合（环线）。
     * @param {number} [segmentsPerSegment] 每段采样数，默认 10。
     * @return {Array<Array<number>>} `[[x, y], ...]`。
     */
    function generateSmoothPoints(points, closed, segmentsPerSegment) {
        if (!points || points.length < 2) return (points || []).slice();
        var pts = points.map(function (p) {
            return Array.isArray(p) ? { x: p[0], y: p[1] } : p;
        });
        if (pts.length === 2) return pts.map(function (p) { return [p.x, p.y]; });

        var workPts = pts.slice();
        if (closed) {
            var first = workPts[0];
            var last = workPts[workPts.length - 1];
            if (first.x !== last.x || first.y !== last.y) workPts.push(first);
        }
        if (workPts.length < 4) return workPts.map(function (p) { return [p.x, p.y]; });

        var expanded = [];
        if (closed) {
            var n = workPts.length;
            expanded.push(workPts[n - 1]);
            expanded.push.apply(expanded, workPts);
            expanded.push(workPts[0]);
        } else {
            var head = workPts[0];
            var second = workPts[1];
            var tail = workPts[workPts.length - 1];
            var prevTail = workPts[workPts.length - 2];
            expanded.push({ x: head.x - (second.x - head.x), y: head.y - (second.y - head.y) });
            expanded.push.apply(expanded, workPts);
            expanded.push({ x: tail.x + (tail.x - prevTail.x), y: tail.y + (tail.y - prevTail.y) });
        }

        var result = [];
        var seg = segmentsPerSegment || 10;
        for (var i = 0; i < expanded.length - 3; i++) {
            var p0 = expanded[i];
            var p1 = expanded[i + 1];
            var p2 = expanded[i + 2];
            var p3 = expanded[i + 3];
            for (var j = 0; j < seg; j++) {
                var t = j / seg;
                var t2 = t * t;
                var t3 = t2 * t;
                var x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
                    (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                    (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
                var y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
                    (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                    (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
                result.push([x, y]);
            }
        }
        return result;
    }

    // ============================================================
    //  3. 模型归一化
    // ============================================================

    /**
     * @brief 车站 → 坐标与所属线路的查找表。
     *
     * 两种输入都吃：
     *   - metro-lang JSON v2：`stations` 是**数组**（每项带 `name`）；
     *   - 地铁编辑器 JSON：`stations` 是**字典**（键就是站名）。
     *
     * @param {Array|object} stations 车站集合。
     * @return {object} `{站名: {lon, lat, lines}}`。
     */
    function indexStations(stations) {
        var out = {};
        if (!stations) return out;
        var list = Array.isArray(stations)
            ? stations
            : Object.keys(stations).map(function (name) {
                return Object.assign({ name: name }, stations[name] || {});
            });
        list.forEach(function (s) {
            if (!s || !s.name) return;
            // 保留站点对象上的其它字段（other_names、lines[].status 等），
            // 交互页的 tooltip 与暂缓标记还要用。
            out[s.name] = Object.assign({}, s, {
                lon: Number(s.lon),
                lat: Number(s.lat),
                lines: s.lines || []
            });
        });
        return out;
    }

    /**
     * @brief 构建绘图模型：把线路字典摊平成"方向表 + 合并线路 + 站名索引"。
     *
     * @param {object} data 归一化后的数据 `{key_city, stations, lines, zones}`。
     * @return {object} 绘图模型（见文件头 `buildModel`）。
     */
    function buildModel(data) {
        var stations = indexStations(data.stations);
        var lines = data.lines || {};
        var keyCity = data.key_city || '';

        var rawDirections = [];
        var stationToDirKeys = {};

        // ---- 构建平台坐标查找表 ----
        var platformCoordLookup = {};
        Object.keys(stations).forEach(function (stationName) {
            var stationInfo = stations[stationName];
            if (!stationInfo.lines) return;
            stationInfo.lines.forEach(function (lineInfo) {
                if (!lineInfo || !lineInfo.platform_coord) return;
                if (!platformCoordLookup[stationName]) platformCoordLookup[stationName] = {};
                platformCoordLookup[stationName][lineInfo.id] = {
                    lon: lineInfo.platform_coord.lon,
                    lat: lineInfo.platform_coord.lat
                };
            });
        });

        Object.keys(lines).forEach(function (lineId) {
            var lineInfo = lines[lineId] || {};
            (lineInfo.direction || []).forEach(function (dir, idx) {
                var city = dir.city || lineInfo.city || keyCity;
                var baseName = lineInfo.name || lineId;
                var groupKey = (city && city !== keyCity) ? city + baseName : baseName;
                var stationNames = (dir.station || []).map(function (s) {
                    return s && s.name !== undefined ? s.name : s;
                });
                rawDirections.push({
                    key: lineId + '|' + idx,
                    groupKey: groupKey,
                    displayName: groupKey,
                    color: lineInfo.color || '#888',
                    stationNames: stationNames,
                    isLoop: !!dir.is_loop,
                    lineId: lineId,
                    isFuture: dir.is_future === true,
                    dirIndex: idx,
                    dirObj: dir,
                    segmentTypes: dir.segment_types || [],
                    expressStops: dir.express_stops || [],
                    routings: dir.routings || []
                });
                stationNames.forEach(function (name) {
                    if (!stationToDirKeys[name]) stationToDirKeys[name] = [];
                    if (stationToDirKeys[name].indexOf(rawDirections[rawDirections.length - 1].key) < 0) {
                        stationToDirKeys[name].push(rawDirections[rawDirections.length - 1].key);
                    }
                });
            });
        });

        // ---- 合并同一线路的两个方向（图例只出现一次） ----
        var groupMap = {};
        var groupOrder = [];
        rawDirections.forEach(function (dir) {
            if (!groupMap[dir.groupKey]) {
                groupMap[dir.groupKey] = {
                    keys: [],
                    color: dir.color,
                    stationNames: [],
                    isLoop: false
                };
                groupOrder.push(dir.groupKey);
            }
            var group = groupMap[dir.groupKey];
            group.keys.push(dir.key);
            dir.stationNames.forEach(function (name) {
                if (group.stationNames.indexOf(name) < 0) group.stationNames.push(name);
            });
            group.isLoop = group.isLoop || dir.isLoop;
        });

        var mergedLines = groupOrder.map(function (groupKey) {
            var group = groupMap[groupKey];
            return {
                displayName: groupKey,
                keys: group.keys,
                color: group.color,
                stationNames: group.stationNames,
                isLoop: group.isLoop
            };
        }).sort(function (a, b) { return compareLineName(a.displayName, b.displayName); });

        // ---- 快车 / 交路 / 方向→组 的索引（交互页的 tooltip 要用） ----
        var expressColorByStation = {};
        var expressLinesByStation = {};
        var routingByStation = {};
        rawDirections.forEach(function (dir) {
            (dir.expressStops || []).forEach(function (name) {
                if (!expressColorByStation[name]) expressColorByStation[name] = [];
                if (expressColorByStation[name].indexOf(dir.color) < 0) {
                    expressColorByStation[name].push(dir.color);
                }
                if (!expressLinesByStation[name]) expressLinesByStation[name] = [];
                if (!expressLinesByStation[name].some(function (e) { return e.color === dir.color; })) {
                    expressLinesByStation[name].push({ name: dir.displayName, color: dir.color });
                }
            });
            (dir.routings || []).forEach(function (routing) {
                if (!routing || !routing.name || !Array.isArray(routing.stations)) return;
                routing.stations.forEach(function (name) {
                    if (!routingByStation[name]) routingByStation[name] = [];
                    var label = dir.displayName + '·' + routing.name;
                    if (!routingByStation[name].some(function (r) { return r.text === label; })) {
                        routingByStation[name].push({ text: label, color: dir.color });
                    }
                });
            });
        });

        var dirKeyToGroupKey = {};
        rawDirections.forEach(function (dir) {
            dirKeyToGroupKey[dir.key] = dir.groupKey;
        });

        return {
            keyCity: keyCity,
            stations: stations,
            lines: lines,
            zones: data.zones || [],
            platformCoordLookup: platformCoordLookup,
            rawDirections: rawDirections,
            stationToDirKeys: stationToDirKeys,
            mergedLines: mergedLines,
            expressColorByStation: expressColorByStation,
            expressLinesByStation: expressLinesByStation,
            routingByStation: routingByStation,
            dirKeyToGroupKey: dirKeyToGroupKey,
            // 显隐开关：地图与图例共用同一份状态。
            hidden: {},
            visible: function (key) { return !this.hidden[key]; }
        };
    }

    // ============================================================
    //  4. 投影与布局
    // ============================================================

    /**
     * @brief 计算视图：经纬度 → 画布像素（等比、居中、留白 40px）。
     *
     * @param {object} model `buildModel()` 的结果。
     * @param {{width:number, height:number}} canvas 画布尺寸。
     * @param {number} [margin] 留白，默认 40。
     * @return {object} `{width, height, margin, scale, minLon, minLat, minLatY, maxLatY, project(lon, lat)}`。
     */
    function computeLayout(model, canvas, margin) {
        var width = canvas.width;
        var height = canvas.height;
        var pad = margin === undefined ? 40 : margin;

        var names = Object.keys(model.stations);
        var minLon = Infinity, maxLon = -Infinity, minLatY = Infinity, maxLatY = -Infinity;
        names.forEach(function (name) {
            var s = model.stations[name];
            if (isNaN(s.lon) || isNaN(s.lat)) return;
            // 墨卡托的 y 与纬度同向，等比缩放不必真做投影（只差一个常数底数），
            // 这里直接用纬度当 y，保证与 src/html.cpp 的"等比"口径一致。
            var y = s.lat;
            minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon);
            minLatY = Math.min(minLatY, y); maxLatY = Math.max(maxLatY, y);
        });
        if (!isFinite(minLon)) { minLon = 0; maxLon = 1; minLatY = 0; maxLatY = 1; }

        var lonRange = (maxLon - minLon) || 0.01;
        var latRange = (maxLatY - minLatY) || 0.01;
        var scale = Math.min((width - 2 * pad) / lonRange, (height - 2 * pad) / latRange);
        var usedW = lonRange * scale;
        var usedH = latRange * scale;
        var offX = (width - usedW) / 2;
        var offY = (height - usedH) / 2;

        return {
            width: width,
            height: height,
            margin: pad,
            scale: scale,
            minLon: minLon,
            minLat: minLatY,
            maxLat: maxLatY,
            center: [
                offX + lonRange * scale / 2,
                offY + latRange * scale / 2
            ],
            /**
             * @brief 经纬度 → 画布坐标。
             * @param {number} lon 经度。
             * @param {number} lat 纬度。
             * @return {Array<number>} `[x, y]`。
             */
            project: function (lon, lat) {
                return [
                    offX + (lon - minLon) * scale,
                    offY + (maxLatY - lat) * scale
                ];
            }
        };
    }

    // ============================================================
    //  5. 线路几何
    // ============================================================

    /**
     * @brief 每条方向的折线点 + 平滑点 + 路段类型分段。
     *
     * @param {object} model `buildModel()` 的结果。
     * @param {object} layout `computeLayout()` 的结果。
     * @param {{segmentsPerSegment?:number}} [options] 平滑采样密度。
     * @return {Array<object>} 每条方向一项。
     */
    function planRoute(model, layout, options) {
        var seg = (options && options.segmentsPerSegment) || 10;
        var paths = [];
        model.rawDirections.forEach(function (dir) {
            var pts = [];
            var names = [];
            dir.stationNames.forEach(function (name) {
                var station = model.stations[name];
                if (!station || isNaN(station.lon) || isNaN(station.lat)) return;
                var p = layout.project(station.lon, station.lat);
                pts.push(p);
                names.push(name);
            });
            if (pts.length < 2) return;
            var smooth = generateSmoothPoints(pts, dir.isLoop, seg);
            paths.push({
                key: dir.key,
                groupKey: dir.groupKey,
                lineId: dir.lineId,
                color: dir.color,
                isLoop: dir.isLoop,
                isFuture: dir.isFuture,
                stationNames: names,
                points: pts,
                smoothPoints: smooth,
                // SVG path：平滑点够多时用它，否则退回折线。
                d: toPathData(smooth.length > 2 ? smooth : pts, dir.isLoop),
                segmentTypes: dir.segmentTypes
            });
        });
        return paths;
    }

    /**
     * @brief 点列 → SVG path 的 `d` 属性（`M...L...`，环线闭合）。
     *
     * @param {Array<Array<number>>} points 点列。
     * @param {boolean} closed 是否闭合。
     * @return {string} path 数据。
     */
    function toPathData(points, closed) {
        if (!points || points.length === 0) return '';
        var d = 'M' + points.map(function (p) { return p[0] + ',' + p[1]; }).join('L');
        return closed ? d + 'Z' : d;
    }

    /**
     * @brief 站点信息：配色、快车停靠、交路、暂缓开通。
     *
     * @param {object} model `buildModel()` 的结果。
     * @return {object} `{byName: {站名: {colors:[], express:[], routings:[], pending:bool}}}`。
     */
    function collectStationInfo(model) {
        var byName = {};
        function slot(name) {
            if (!byName[name]) byName[name] = { colors: [], express: [], routings: [], pending: false };
            return byName[name];
        }

        model.rawDirections.forEach(function (dir) {
            dir.stationNames.forEach(function (name) {
                var info = slot(name);
                if (info.colors.indexOf(dir.color) < 0) info.colors.push(dir.color);
            });
            dir.expressStops.forEach(function (name) {
                var info = slot(name);
                if (info.express.indexOf(dir.color) < 0) info.express.push(dir.color);
            });
            dir.routings.forEach(function (routing) {
                if (!routing || !routing.name || !Array.isArray(routing.stations)) return;
                routing.stations.forEach(function (name) {
                    var info = slot(name);
                    var label = dir.displayName + '·' + routing.name;
                    info.routings.push({ text: label, color: dir.color });
                });
            });
        });

        // 暂缓开通：线路的 `pending` 列表（模型里没有就跳过）。
        Object.keys(model.lines).forEach(function (lineId) {
            var pending = model.lines[lineId].pending || [];
            pending.forEach(function (name) { slot(name).pending = true; });
        });

        return { byName: byName };
    }

    // ============================================================
    //  6. 图例
    // ============================================================

    /**
     * @brief 图例条目（来自合并后的线路，按线路名排序）。
     *
     * @param {object} model `buildModel()` 的结果。
     * @return {Array<{name:string, color:string, textColor:string, keys:Array<string>, isLoop:boolean}>}
     */
    function buildLegend(model) {
        return model.mergedLines.map(function (line) {
            return {
                name: line.displayName,
                color: line.color,
                textColor: getContrastTextColor(line.color),
                keys: line.keys,
                isLoop: line.isLoop
            };
        });
    }

    var API = {
        VERSION: VERSION,
        extractPrefix: extractPrefix,
        extractLineNumber: extractLineNumber,
        compareLineName: compareLineName,
        getContrastTextColor: getContrastTextColor,
        generateSmoothPoints: generateSmoothPoints,
        indexStations: indexStations,
        buildModel: buildModel,
        computeLayout: computeLayout,
        planRoute: planRoute,
        toPathData: toPathData,
        collectStationInfo: collectStationInfo,
        buildLegend: buildLegend
    };

    return API;
});
