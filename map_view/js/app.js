        const activeStationSet = new Set();

        // ============================================================
        //  1. 工具函数（排序 & 亮度）
        // ============================================================
        function extractPrefix(name) {
            const match = name.match(/^\D*/);
            return match ? match[0] : '';
        }

        function extractLineNumber(name) {
            const match = name.match(/\d+/);
            return match ? parseInt(match[0], 10) : -1;
        }

        function compareLineName(nameA, nameB) {
            const prefixA = extractPrefix(nameA);
            const prefixB = extractPrefix(nameB);
            const emptyA = prefixA === '';
            const emptyB = prefixB === '';
            if (emptyA !== emptyB) {
                return emptyA ? -1 : 1;
            }
            if (prefixA !== prefixB) {
                return prefixA.localeCompare(prefixB);
            }
            const numA = extractLineNumber(nameA);
            const numB = extractLineNumber(nameB);
            if (numA !== numB) {
                return numA - numB;
            }
            return nameA.localeCompare(nameB);
        }

        function getContrastTextColor(hexColor) {
            let r, g, b;
            if (hexColor.startsWith('#')) {
                let c = hexColor.substring(1);
                if (c.length === 3) {
                    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
                }
                r = parseInt(c.substring(0, 2), 16);
                g = parseInt(c.substring(2, 4), 16);
                b = parseInt(c.substring(4, 6), 16);
            } else {
                return '#000';
            }
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
            return luminance > 160 ? '#000' : '#fff';
        }

        // ============================================================
        //  区域类型中文标签 + 区域 tooltip（独立，避免站点 tooltip 拥挤）
        // ============================================================
        function zoneTypeLabel(type) {
            const map = {
                COMMERCIAL: '商业区', RESIDENTIAL: '住宅区', CBD: '中央商务区', GOVERNMENT: '政务区',
                TOURIST: '旅游区', TRANSPORT_HUB: '交通枢纽', EDUCATIONAL: '教育区', MEDICAL: '医疗区',
                MIXED: '综合区', OTHER: '其他'
            };
            return map[type] || type || '';
        }

        function zoneAttrHtml(attrs) {
            if (!attrs) return '';
            const rows = [];
            if (attrs.PeakHours && Array.isArray(attrs.PeakHours) && attrs.PeakHours.length) {
                rows.push('高峰时段：' + attrs.PeakHours.join('、'));
            }
            if (attrs.PopulationDensity != null) rows.push('人口密度：' + attrs.PopulationDensity);
            if (attrs.AvgRent != null) rows.push('平均租金：' + attrs.AvgRent);
            if (rows.length === 0) return '';
            return '<div class="zone-attributes">' + rows.map(r => '<div>' + r + '</div>').join('') + '</div>';
        }

        function showZoneTooltip(zone, event) {
            const zt = d3.select("#zone-tooltip");
            const title = zone.Name || zone.Id || '区域';
            const meta = [];
            if (zone.Type) meta.push('类型：' + zoneTypeLabel(zone.Type));
            if (zone.City) meta.push('城市：' + zone.City);
            let html = '<div class="zone-title">' + title + '</div>';
            if (meta.length) html += '<div class="zone-meta">' + meta.join('　') + '</div>';
            html += zoneAttrHtml(zone.Attributes);
            if (zone.Stations && Array.isArray(zone.Stations) && zone.Stations.length) {
                html += '<div class="zone-stations">含 ' + zone.Stations.length + ' 站</div>';
            }
            zt.html(html).style("opacity", 1);
            positionZoneTooltip(event);
        }

        function positionZoneTooltip(event) {
            d3.select("#zone-tooltip")
                .style("left", (event.pageX + 14) + "px")
                .style("top", (event.pageY - 10) + "px");
        }

        function hideZoneTooltip() {
            d3.select("#zone-tooltip").style("opacity", 0);
        }

        // ============================================================
        //  2. 平滑曲线
        // ============================================================
        function generateSmoothPoints(points, closed, segmentsPerSegment) {
            if (!points || points.length < 2) return points.slice();
            const pts = points.map(p => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
            if (pts.length === 2) {
                return pts.map(p => [p.x, p.y]);
            }
            let workPts = pts.slice();
            if (closed) {
                const first = workPts[0];
                const last = workPts[workPts.length - 1];
                if (first.x !== last.x || first.y !== last.y) {
                    workPts.push(first);
                }
            }
            if (workPts.length < 4) {
                return workPts.map(p => [p.x, p.y]);
            }
            let expanded = [];
            if (closed) {
                const n = workPts.length;
                expanded.push(workPts[n - 1]);
                expanded.push(...workPts);
                expanded.push(workPts[0]);
            } else {
                const first = workPts[0];
                const second = workPts[1];
                const last = workPts[workPts.length - 1];
                const prevLast = workPts[workPts.length - 2];
                expanded.push({
                    x: first.x - (second.x - first.x),
                    y: first.y - (second.y - first.y)
                });
                expanded.push(...workPts);
                expanded.push({
                    x: last.x + (last.x - prevLast.x),
                    y: last.y + (last.y - prevLast.y)
                });
            }
            const result = [];
            const seg = segmentsPerSegment || 10;
            for (let i = 0; i < expanded.length - 3; i++) {
                const p0 = expanded[i];
                const p1 = expanded[i + 1];
                const p2 = expanded[i + 2];
                const p3 = expanded[i + 3];
                for (let j = 0; j < seg; j++) {
                    const t = j / seg;
                    const t2 = t * t;
                    const t3 = t2 * t;
                    const x = 0.5 * ((2 * p1.x) +
                        (-p0.x + p2.x) * t +
                        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
                    const y = 0.5 * ((2 * p1.y) +
                        (-p0.y + p2.y) * t +
                        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
                    result.push([x, y]);
                }
            }
            return result;
        }

        // ============================================================
        //  3. 主绘图（含优先级交互）
        // ============================================================
        let metroData = null;
        const LABEL_BASE_SIZE = 5;
        let globalBounds = null;

        function drawMap(data) {
            d3.select("#container").selectAll("*").remove();
            d3.select("#loading").style("display", "none");

            const stations = data.stations;
            const lines = data.lines;
            const keyCity = data.key_city;

            const rawDirections = [];
            const stationToDirKeys = {};

            // ---- 构建平台坐标查找表 ----
            const platformCoordLookup = {};
            for (const [stationName, stationInfo] of Object.entries(stations)) {
                if (stationInfo.lines) {
                    for (const lineInfo of stationInfo.lines) {
                        if (lineInfo.platform_coord) {
                            if (!platformCoordLookup[stationName]) platformCoordLookup[stationName] = {};
                            platformCoordLookup[stationName][lineInfo.id] = {
                                lon: lineInfo.platform_coord.lon,
                                lat: lineInfo.platform_coord.lat
                            };
                        }
                    }
                }
            }

            for (const [lineId, lineInfo] of Object.entries(lines)) {
                lineInfo.direction.forEach((dir, idx) => {
                    const dirKey = lineId + '|' + idx;
                    const city = dir.city || lineInfo.city || keyCity;
                    const baseName = lineInfo.name || lineId;
                    const groupKey = (city !== keyCity) ? city + baseName : baseName;
                    const displayName = groupKey;
                    const color = lineInfo.color || '#888';
                    const isLoop = dir.is_loop || false;
                    const stationNames = dir.station.map(s => s.name);
                    const isFuture = dir.is_future === true;

                    rawDirections.push({
                        key: dirKey,
                        groupKey: groupKey,
                        displayName: displayName,
                        color: color,
                        stationNames: stationNames,
                        isLoop: isLoop,
                        lineId: lineId,
                        isFuture: isFuture,
                        dirIndex: idx,
                        dirObj: dir,
                        segmentTypes: dir.segment_types || [],
                        expressStops: dir.express_stops || [],
                        routings: dir.routings || []
                    });

                    stationNames.forEach(name => {
                        if (!stationToDirKeys[name]) stationToDirKeys[name] = new Set();
                        stationToDirKeys[name].add(dirKey);
                    });
                });
            }

            const dirKeyToGroupKey = new Map();
            for (const dir of rawDirections) {
                dirKeyToGroupKey.set(dir.key, dir.groupKey);
            }

            // ---- 收集快车停靠站及其线路颜色 ----
            const expressColorByStation = {};
            const expressLinesByStation = {};
            rawDirections.forEach(dir => {
                if (!dir.expressStops || dir.expressStops.length === 0) return;
                dir.expressStops.forEach(name => {
                    if (!expressColorByStation[name]) expressColorByStation[name] = [];
                    if (!expressColorByStation[name].includes(dir.color)) expressColorByStation[name].push(dir.color);
                    if (!expressLinesByStation[name]) expressLinesByStation[name] = [];
                    if (!expressLinesByStation[name].some(e => e.color === dir.color)) {
                        expressLinesByStation[name].push({ name: dir.displayName, color: dir.color });
                    }
                });
            });

            // ---- 收集交路信息：站点 → 交路名称列表（含线路显示名） ----
            const routingByStation = {};
            rawDirections.forEach(dir => {
                if (!dir.routings || dir.routings.length === 0) return;
                dir.routings.forEach(routing => {
                    if (!routing || !routing.name || !Array.isArray(routing.stations)) return;
                    routing.stations.forEach(name => {
                        if (!routingByStation[name]) routingByStation[name] = [];
                        const label = dir.displayName + '·' + routing.name;
                        if (!routingByStation[name].includes(label)) {
                            routingByStation[name].push({ text: label, color: dir.color });
                        }
                    });
                });
            });

            const groupMap = new Map();
            for (const dir of rawDirections) {
                const key = dir.groupKey;
                if (!groupMap.has(key)) {
                    groupMap.set(key, {
                        keys: [],
                        color: dir.color,
                        stationNamesSet: new Set(),
                        isLoop: dir.isLoop
                    });
                }
                const group = groupMap.get(key);
                group.keys.push(dir.key);
                dir.stationNames.forEach(s => group.stationNamesSet.add(s));
                if (dir.isLoop) group.isLoop = true;
            }

            const mergedLines = [];
            for (const [groupKey, group] of groupMap) {
                const sampleDir = rawDirections.find(d => d.groupKey === groupKey);
                const lineId = sampleDir ? sampleDir.lineId : null;
                const baseColor = (lineId && lines[lineId] && lines[lineId].color) ? lines[lineId].color : group.color;

                mergedLines.push({
                    displayName: groupKey,
                    keys: group.keys,
                    color: baseColor,
                    stationNames: Array.from(group.stationNamesSet),
                    isLoop: group.isLoop,
                    hasFuture: group.hasFuture
                });
            }
            mergedLines.sort((a, b) => compareLineName(a.displayName, b.displayName));

            const coords = Object.values(stations).map(s => [s.lon, s.lat]);
            const allLons = coords.map(c => c[0]);
            const allLats = coords.map(c => c[1]);
            const minLon = Math.min(...allLons);
            const maxLon = Math.max(...allLons);
            const minLat = Math.min(...allLats);
            const maxLat = Math.max(...allLats);

            const width = window.innerWidth;
            const height = window.innerHeight;
            const size = Math.min(width, height);

            const lonRange = maxLon - minLon || 0.01;
            const latRange = maxLat - minLat || 0.01;

            const margin = 40;
            const scale = Math.min(
                (width - 2 * margin) / lonRange,
                (height - 2 * margin) / latRange
            ) * 0.9;

            const xRange = [margin, margin + lonRange * scale];
            const yRange = [margin + latRange * scale, margin];

            const xScale = d3.scaleLinear()
                .domain([minLon, maxLon])
                .range(xRange);

            const yScale = d3.scaleLinear()
                .domain([minLat, maxLat])
                .range(yRange);

            const svg = d3.select("#container")
                .append("svg")
                .attr("width", width)
                .attr("height", height)
                .style("background", "#f5f5f5");

            let currentZoomK = 1;
            let currentMode = 'all';
            let currentHighlightGroupKey = 'all';
            let routeStationNames = [];

            const zoom = d3.zoom()
                .scaleExtent([0.15, 10])
                .on("zoom", (event) => {
                    const transform = event.transform;
                    g.attr("transform", transform);
                    currentZoomK = transform.k;

                    g.selectAll(".station-label")
                        .attr("y", d => d.y - LABEL_BASE_SIZE / currentZoomK)
                        .attr("font-size", function(d) {
                            let size = LABEL_BASE_SIZE / currentZoomK;
                            size = Math.min(8, Math.max(2, size));
                            return size + "px";
                        });

                    updateStyles(currentZoomK);
                });

            svg.call(zoom);
            const g = svg.append("g");

            // ---- 定义坐标获取函数（优先平台坐标） ----
            function getCoord(stationName, lineId) {
                if (platformCoordLookup[stationName] && platformCoordLookup[stationName][lineId]) {
                    const pc = platformCoordLookup[stationName][lineId];
                    return { x: xScale(pc.lon), y: yScale(pc.lat) };
                } else {
                    const st = stationData.find(d => d.name === stationName);
                    return st ? { x: st.x, y: st.y } : null;
                }
            }

            stationData = Object.entries(stations).map(([name, info]) => {
                const dirKeys = Array.from(stationToDirKeys[name] || []);
                const isActive = activeStationSet.has(name);
                const isFutureOnly = !isActive && dirKeys.length > 0 &&
                    dirKeys.every(k => {
                        const dir = rawDirections.find(d => d.key === k);
                        return dir && dir.isFuture === true;
                    });

                const uniqueGroupKeys = new Set();
                dirKeys.forEach(k => {
                    const gk = dirKeyToGroupKey.get(k);
                    if (gk) uniqueGroupKeys.add(gk);
                });
                const isTransfer = uniqueGroupKeys.size > 1;

                return {
                    name,
                    lon: info.lon,
                    lat: info.lat,
                    x: xScale(info.lon),
                    y: yScale(info.lat),
                    dirKeys: dirKeys,
                    isActive: isActive,
                    isFutureOnly: isFutureOnly,
                    isTransfer: isTransfer,
                    expressColors: expressColorByStation[name] || [],
                    expressLines: expressLinesByStation[name] || [],
                    routingInfos: routingByStation[name] || [],
                    otherNames: info.other_names || [],
                    pendingLines: (() => {
                        const seen = new Set();
                        const result = [];
                        for (const l of (info.lines || [])) {
                            if (l.status !== 'pending') continue;
                            const dir = rawDirections.find(d => d.lineId === l.id);
                            const name = dir ? dir.displayName : l.id;
                            if (seen.has(name)) continue;
                            seen.add(name);
                            result.push({ name, color: dir ? dir.color : '#888' });
                        }
                        return result;
                    })()
                };
            });

            // ---- 生成路径（使用平台坐标） ----
            const pathData = [];
            for (const dir of rawDirections) {
                const stationNames = dir.stationNames;
                if (stationNames.length < 2) continue;

                let effectiveStationNames = stationNames;
                if (dir.isFuture) {
                    effectiveStationNames = stationNames.filter(name => !activeStationSet.has(name));
                    if (effectiveStationNames.length < 2) {
                        console.log(`未来方向 "${dir.displayName}" 无连续纯未来段，跳过绘制`);
                        continue;
                    }
                }

                const pts = effectiveStationNames
                    .map(name => {
                        const coord = getCoord(name, dir.lineId);
                        return coord ? { x: coord.x, y: coord.y } : null;
                    })
                    .filter(p => p !== null);

                if (pts.length < 2) continue;

                const isLoop = dir.isLoop;
                const smoothPoints = generateSmoothPoints(pts, isLoop, 10);
                let d = "";
                if (smoothPoints.length > 0) {
                    d = "M" + smoothPoints.map(p => p.join(",")).join("L");
                    if (isLoop) d += "Z";
                } else {
                    d = "M" + pts.map(p => p.x + "," + p.y).join("L");
                    if (isLoop) d += "Z";
                }

                const isFuture = dir.isFuture || false;
                pathData.push({
                    key: dir.key,
                    groupKey: dir.groupKey,
                    displayName: dir.displayName,
                    color: isFuture ? '#B0B0B0' : dir.color,
                    d: d,
                    isFuture: isFuture,
                    strokeDasharray: 'none',
                    strokeWidth: 1.2,
                    opacity: 1.0,
                    segmentTypes: dir.segmentTypes || [],
                    effectiveStationNames: effectiveStationNames,
                    smoothPoints: smoothPoints,
                    pts: pts
                });
            }

            // ---- 区域图层（Zones，置于最底层） ----
            const zones = data.zones || [];
            const zoneGroup = g.insert("g", ":first-child").attr("class", "zones");
            if (zones.length > 0) {
                const metersPerDegLat = 111320;
                const zoneLabelBase = 11;

                zones.forEach(zone => {
                    const fillColor = zone.Color || '#3388ff';
                    const label = zone.Name || zone.Id || '';

                    // 圆形区域（CENTER + RADIUS，半径单位为米）
                    if (zone.Center && Array.isArray(zone.Center) && zone.Center.length >= 2 && zone.Radius) {
                        const cx = xScale(zone.Center[0]);
                        const cy = yScale(zone.Center[1]);
                        const metersPerDegLon = metersPerDegLat * Math.cos(zone.Center[1] * Math.PI / 180);
                        const rPx = Math.max(zone.Radius / metersPerDegLon * scale, 4);
                        zoneGroup.append("circle")
                            .attr("class", "zone-circle")
                            .attr("cx", cx)
                            .attr("cy", cy)
                            .attr("r", rPx)
                            .attr("fill", fillColor)
                            .attr("fill-opacity", 0.18)
                            .attr("stroke", fillColor)
                            .attr("stroke-width", 1.2)
                            .attr("stroke-dasharray", "4,3")
                            .attr("stroke-opacity", 0.75)
                            .attr("pointer-events", "all")
                            .datum(zone)
                            .on("mouseover", (event, d) => { showZoneTooltip(d, event); })
                            .on("mousemove", (event) => { positionZoneTooltip(event); })
                            .on("mouseout", () => { hideZoneTooltip(); });
                    }

                    // 多边形区域（POLYGON）
                    if (zone.Polygon && Array.isArray(zone.Polygon) && zone.Polygon.length >= 3) {
                        const pts = zone.Polygon.map(p => [xScale(p[0]), yScale(p[1])]);
                        const d = "M" + pts.map(p => p[0] + "," + p[1]).join("L") + "Z";
                        zoneGroup.append("path")
                            .attr("class", "zone-polygon")
                            .attr("d", d)
                            .attr("fill", fillColor)
                            .attr("fill-opacity", 0.18)
                            .attr("stroke", fillColor)
                            .attr("stroke-width", 1.2)
                            .attr("stroke-dasharray", "4,3")
                            .attr("stroke-opacity", 0.75)
                            .attr("pointer-events", "all")
                            .datum(zone)
                            .on("mouseover", (event, d) => { showZoneTooltip(d, event); })
                            .on("mousemove", (event) => { positionZoneTooltip(event); })
                            .on("mouseout", () => { hideZoneTooltip(); });
                    }
                });
            }

            // ---- 背景图片图层（置于最底层，在区域图层之下） ----
            const backgrounds = data.backgrounds || [];
            if (backgrounds.length > 0) {
                const bgGroup = g.insert("g", ":first-child").attr("class", "backgrounds");
                backgrounds.forEach(bg => {
                    if (!bg.Src || !bg.Bounds || bg.Bounds.length !== 4) return;
                    const x = xScale(bg.Bounds[0]);
                    const y = yScale(bg.Bounds[3]);
                    const w = xScale(bg.Bounds[2]) - xScale(bg.Bounds[0]);
                    const h = yScale(bg.Bounds[1]) - yScale(bg.Bounds[3]);
                    const mimeType = bg.Type === 'svg' ? 'image/svg+xml' : 'image/png';
                    const href = `data:${mimeType};base64,${bg.Src}`;
                    bgGroup.append("image")
                        .attr("x", x)
                        .attr("y", y)
                        .attr("width", Math.max(w, 1))
                        .attr("height", Math.max(h, 1))
                        .attr("href", href)
                        .attr("preserveAspectRatio", "none")
                        .attr("opacity", bg.Opacity != null ? bg.Opacity : 1)
                        .attr("pointer-events", "none");
                });
            }

            const pathGroup = g.append("g").attr("class", "paths");
            const pathElements = pathGroup.selectAll(".line-path")
                .data(pathData)
                .enter()
                .append("path")
                .attr("class", "line-path")
                .attr("d", d => d.d)
                .attr("stroke", d => d.color)
                .attr("stroke-width", 2.8)
                .attr("opacity", 1)
                .attr("data-group", d => d.groupKey)
                .attr("data-key", d => d.key);

            // ---- 路段类型叠加层（高架/地下/地面） ----
            const segmentOverlayGroup = pathGroup.append("g").attr("class", "segment-overlay");
            const segPerSegment = 10;
            pathData.forEach(pd => {
                if (!pd.segmentTypes || pd.segmentTypes.length === 0) return;
                const names = pd.effectiveStationNames;
                const sp = pd.smoothPoints;
                const rawPts = pd.pts;
                if (!names || names.length < 2) return;

                pd.segmentTypes.forEach(seg => {
                    const fromIdx = names.indexOf(seg.from);
                    const toIdx = names.indexOf(seg.to);
                    if (fromIdx < 0 || toIdx < 0) return;

                    // 确保顺序正确（from 在 to 之前）
                    let idxA = Math.min(fromIdx, toIdx);
                    let idxB = Math.max(fromIdx, toIdx);
                    if (idxB - idxA !== 1) return; // 只处理相邻站

                    // 从平滑点中提取该段的子路径
                    let segD = "";
                    if (sp && sp.length > 0) {
                        const startIdx = idxA * segPerSegment;
                        const endIdx = Math.min((idxA + 1) * segPerSegment, sp.length);
                        const subPts = sp.slice(startIdx, endIdx + 1);
                        if (subPts.length > 0) {
                            segD = "M" + subPts.map(p => p.join(",")).join("L");
                        }
                    }
                    if (!segD && rawPts && rawPts.length > idxA) {
                        const p1 = rawPts[idxA];
                        const p2 = rawPts[idxB] || rawPts[idxA];
                        segD = `M${p1.x},${p1.y}L${p2.x},${p2.y}`;
                    }
                    if (!segD) return;

                    const segType = (seg.type || '').toLowerCase();
                    let dashArray = 'none';
                    let strokeWidth = 2.8;
                    if (segType === 'underground') {
                        dashArray = '8,4';
                    } else if (segType === 'ground') {
                        dashArray = '2,3';
                        strokeWidth = 2.2;
                    } else if (segType === 'elevated') {
                        dashArray = '12,2,2,2';
                    }

                    segmentOverlayGroup.append("path")
                        .attr("class", "segment-overlay-path")
                        .attr("d", segD)
                        .attr("stroke", pd.color)
                        .attr("stroke-width", strokeWidth)
                        .attr("stroke-dasharray", dashArray)
                        .attr("fill", "none")
                        .attr("opacity", pd.isFuture ? 0.5 : 0.85)
                        .attr("stroke-linecap", "round")
                        .attr("stroke-linejoin", "round")
                        .attr("pointer-events", "none");
                });
            });

            // ---- 交互过滤 ----
            function shouldRespondToEvent(station) {
                if (currentMode === 'all') return true;
                if (currentMode === 'highlight') {
                    return station.dirKeys.some(k => {
                        const gk = dirKeyToGroupKey.get(k);
                        return gk === currentHighlightGroupKey;
                    });
                }
                if (currentMode === 'route') {
                    return routeStationNames.includes(station.name);
                }
                return true;
            }

            const stationGroup = g.append("g").attr("class", "stations");

            // ---- 站点圆圈（全局坐标，不可拖拽） ----
            const stationCircles = stationGroup.selectAll(".station")
                .data(stationData)
                .enter()
                .append("circle")
                .attr("class", "station")
                .attr("cx", d => d.x)
                .attr("cy", d => d.y)
                .attr("r", 4.5)
                .attr("fill", d => {
                    if (d.isTransfer) return "#FF45BB";
                    if (d.dirKeys.length > 1) return "#FF4500";
                    else if (d.dirKeys.length === 1) {
                        const key = d.dirKeys[0];
                        const dir = rawDirections.find(di => di.key === key);
                        return dir ? dir.color : '#888';
                    } else return '#888';
                })
                .attr("data-station", d => d.name)
                .on("mouseover", (event, d) => {
                    if (!shouldRespondToEvent(d)) return;
                    const nameSet = new Map();
                    d.dirKeys.forEach(k => {
                        const dir = rawDirections.find(di => di.key === k);
                        if (dir) {
                            if (!nameSet.has(dir.displayName)) {
                                nameSet.set(dir.displayName, dir.color);
                            }
                        }
                    });
                    const sortedEntries = Array.from(nameSet.entries()).sort((a, b) => compareLineName(a[0], b[0]));

                    let cardsHtml = '';
                    sortedEntries.forEach(([displayName, color]) => {
                        const textColor = getContrastTextColor(color);
                        cardsHtml += `<span class="line-tag" style="background-color:${color}; color:${textColor};">${displayName}</span>`;
                    });

                    // 交路信息：显示该站属于哪些交路
                    let routingHtml = '';
                    if (d.routingInfos && d.routingInfos.length > 0) {
                        d.routingInfos.forEach(ri => {
                            routingHtml += `<span class="routing-tag" style="color:${ri.color}; border-color:${ri.color};">⟳ ${ri.text}</span>`;
                        });
                    }

                    const tooltip = d3.select("#tooltip");
                    tooltip.select(".station-name").text(d.name);
                    tooltip.select(".line-tag-container").html(cardsHtml);

                    // 快车停靠：显示该站作为快车停靠站的线路（带线路色）
                    let expressHtml = '';
                    if (d.expressLines && d.expressLines.length > 0) {
                        expressHtml = d.expressLines.map(e => {
                            const tc = getContrastTextColor(e.color);
                            return `<span class="express-tag" style="background-color:${e.color}; color:${tc};">快车 ${e.name}</span>`;
                        }).join('');
                    }
                    tooltip.select(".express-container").html(expressHtml);

                    // 暂缓开通：显示该站在某些线路上的暂缓状态
                    let pendingHtml = '';
                    if (d.pendingLines && d.pendingLines.length > 0) {
                        pendingHtml = d.pendingLines.map(p => {
                            return `<span class="pending-tag">暂缓 ${p.name}</span>`;
                        }).join('');
                    }
                    tooltip.select(".pending-container").html(pendingHtml);

                    tooltip.select(".routing-container").html(routingHtml);

                    // 其他语言名称（翻译名）：显示为灰色标签
                    let otherNamesHtml = '';
                    if (d.otherNames && d.otherNames.length > 0) {
                        otherNamesHtml = d.otherNames
                            .map(n => `<span class="other-name-tag">${n}</span>`)
                            .join('');
                    }
                    tooltip.select(".other-names-container").html(otherNamesHtml);

                    tooltip
                        .style("opacity", 1)
                        .style("left", (event.pageX + 14) + "px")
                        .style("top", (event.pageY - 10) + "px");
                })
                .on("mouseout", () => {
                    d3.select("#tooltip").style("opacity", 0);
                })
                .on("click", (event, d) => {
                    if (d.isFutureOnly) return;
                    if (!shouldRespondToEvent(d)) return;
                    showStationInfo(d.name, d.dirKeys);
                });

            // ---- 触摸长按（仅显示信息，无拖拽） ----
            let longPressTimer = null;
            stationCircles.on("touchstart", function(event) {
                const d = d3.select(this).datum();
                if (!shouldRespondToEvent(d)) {
                    clearTimeout(longPressTimer);
                    return;
                }
                longPressTimer = setTimeout(() => {
                    showStationInfo(d.name, d.dirKeys);
                    event.preventDefault();
                }, 500);
            }).on("touchend", function() {
                clearTimeout(longPressTimer);
            }).on("touchmove", function() {
                clearTimeout(longPressTimer);
            });

            // ---- 站点标签 ----
            const stationLabels = stationGroup.selectAll(".station-label")
                .data(stationData)
                .enter()
                .append("text")
                .attr("class", "station-label")
                .attr("x", d => d.x)
                .attr("y", d => d.y - LABEL_BASE_SIZE)
                .attr("text-anchor", "middle")
                .attr("font-size", LABEL_BASE_SIZE + "px")
                .attr("fill", "#222")
                .attr("pointer-events", "none")
                .text(d => d.name)
                .style("font-family", "Microsoft YaHei, PingFang SC, sans-serif")
                .style("text-shadow", "0 0 4px #fff, 0 0 4px #fff, 0 0 8px #fff")
                .style("user-select", "none")
                .style("font-weight", "500");

            // ---- 绘制平台坐标（虚线空心圆） ----
            const platformCoords = [];
            for (const [stationName, lineMap] of Object.entries(platformCoordLookup)) {
                for (const [lineId, coord] of Object.entries(lineMap)) {
                    const x = xScale(coord.lon);
                    const y = yScale(coord.lat);
                    platformCoords.push({ x, y, stationName, lineId });
                }
            }
            const platformCircles = stationGroup.selectAll(".platform-coord")
                .data(platformCoords)
                .enter()
                .append("circle")
                .attr("class", "platform-coord")
                .attr("cx", d => d.x)
                .attr("cy", d => d.y)
                .attr("r", 3)
                .attr("fill", "none")
                .attr("stroke", "#999")
                .attr("stroke-width", 1.5)
                .style("pointer-events", "none");

            // ---- 快车停靠站标记（空心环，置于站点圆之上） ----
            const expressStopCircles = stationGroup.selectAll(".express-stop")
                .data(stationData.filter(d => d.expressColors.length > 0))
                .enter()
                .append("circle")
                .attr("class", "express-stop")
                .attr("cx", d => d.x)
                .attr("cy", d => d.y)
                .attr("r", 4)
                .attr("fill", "#fff")
                .attr("fill-opacity", 0.9)
                .attr("stroke", d => d.expressColors[0])
                .attr("stroke-width", 2)
                .attr("data-station", d => d.name)
                .style("pointer-events", "none");

            // ---- 交路站点标记（虚线圆环，表示该站属于某交路） ----
            const routingCircles = stationGroup.selectAll(".routing-stop")
                .data(stationData.filter(d => d.routingInfos.length > 0))
                .enter()
                .append("circle")
                .attr("class", "routing-stop")
                .attr("cx", d => d.x)
                .attr("cy", d => d.y)
                .attr("r", 4)
                .attr("fill", "none")
                .attr("stroke", d => d.routingInfos[0].color)
                .attr("stroke-width", 1.5)
                .attr("stroke-dasharray", "3,2")
                .attr("data-station", d => d.name)
                .style("pointer-events", "none");

            // ---- 临时图层（寻路） ----
            const tempLineGroup = g.insert('g', '.stations').attr("class", "temp-layer");

            // ---- 统一样式更新 ----
            function updateStyles(k) {
                const baseWidth = 2.8;
                const baseRadius = 4.5;
                const highlightFactor = 1.6;
                const dimFactor = 0.4;

                const scaledWidth = Math.min(Math.max(baseWidth / k, 0.8), 4);
                const scaledRadius = Math.min(Math.max(baseRadius / k, 0.8), 4);

                const isHighlight = (currentMode === 'highlight');
                const isRoute = (currentMode === 'route');

                pathElements
                    .attr("stroke-width", d => {
                        if (isHighlight && d.groupKey === currentHighlightGroupKey) {
                            return scaledWidth * highlightFactor;
                        } else if (isHighlight) {
                            return scaledWidth * dimFactor;
                        } else {
                            return scaledWidth;
                        }
                    })
                    .attr("opacity", d => {
                        if (isHighlight && d.groupKey === currentHighlightGroupKey) {
                            return 1;
                        } else if (isHighlight) {
                            return 0.15;
                        } else {
                            return 1;
                        }
                    });

                stationCircles
                    .attr("r", scaledRadius)
                    .attr("opacity", d => {
                        if (currentMode === 'all') {
                            return d.isTransfer ? 1 : 0.8;
                        }
                        if (isHighlight) {
                            const belongs = d.dirKeys.some(k => {
                                const gk = dirKeyToGroupKey.get(k);
                                return gk === currentHighlightGroupKey;
                            });
                            return belongs ? 1 : 0.1;
                        }
                        if (isRoute) {
                            return routeStationNames.includes(d.name) ? 1 : 0.1;
                        }
                        return 1;
                    })
                    .style("cursor", d => {
                        if (shouldRespondToEvent(d)) return "pointer";
                        else return "default";
                    });

                stationLabels.attr("opacity", d => {
                    if (currentMode === 'all') {
                        return d.isTransfer ? 1 : 0.8;
                    }
                    if (isRoute) {
                        return routeStationNames.includes(d.name) ? 1 : 0;
                    }
                    if (isHighlight) {
                        const belongs = d.dirKeys.some(k => {
                            const gk = dirKeyToGroupKey.get(k);
                            return gk === currentHighlightGroupKey;
                        });
                        return belongs ? 1 : 0;
                    }
                    return 1;
                });

                // 平台坐标圆圈随缩放调整大小
                platformCircles
                    .attr("r", Math.min(Math.max(3 / k, 0.8), 4))
                    .attr("stroke-width", Math.min(Math.max(1.5 / k, 0.5), 2));

                // 快车停靠站标记（空心环）随缩放调整，保持屏幕尺寸稳定
                expressStopCircles
                    .attr("r", Math.min(Math.max(4 / k, 1.0), 4))
                    .attr("stroke-width", Math.min(Math.max(2 / k, 0.6), 2))
                    .attr("opacity", d => {
                        if (currentMode === 'all') return 1;
                        if (isHighlight) {
                            const belongs = d.dirKeys.some(k => {
                                const gk = dirKeyToGroupKey.get(k);
                                return gk === currentHighlightGroupKey;
                            });
                            return belongs ? 1 : 0;
                        }
                        if (isRoute) {
                            return routeStationNames.includes(d.name) ? 1 : 0;
                        }
                        return 1;
                    });

                // 交路站点标记（虚线圆环）随缩放调整，保持屏幕尺寸稳定
                routingCircles
                    .attr("r", Math.min(Math.max(4 / k, 1.0), 4))
                    .attr("stroke-width", Math.min(Math.max(2 / k, 0.6), 2))
                    .attr("opacity", d => {
                        if (currentMode === 'all') return 1;
                        if (isHighlight) {
                            const belongs = d.dirKeys.some(k => {
                                const gk = dirKeyToGroupKey.get(k);
                                return gk === currentHighlightGroupKey;
                            });
                            return belongs ? 1 : 0;
                        }
                        if (isRoute) {
                            return routeStationNames.includes(d.name) ? 1 : 0;
                        }
                        return 1;
                    });

                // 区域描边与标签随缩放保持屏幕尺寸稳定
                zoneGroup.selectAll(".zone-circle, .zone-polygon")
                    .attr("stroke-width", Math.min(Math.max(1.2 / k, 0.6), 2.5));
                zoneGroup.selectAll(".zone-label")
                    .attr("font-size", Math.min(Math.max(11 / k, 6), 14) + "px");

                tempLineGroup.selectAll(".temp-line")
                    .attr("stroke-width", Math.min(Math.max(3 / k, 0.8), 5));
                tempLineGroup.selectAll(".temp-marker")
                    .attr("r", Math.min(Math.max(5 / k, 0.8), 6));
            }

            // ---- 高亮、寻路等控制函数（与 edit.html 相同） ----
            function highlightLine(groupKey) {
                if (currentMode === 'highlight' && currentHighlightGroupKey === groupKey) {
                    if (routeStationNames.length > 0) {
                        setRouteMode();
                    } else {
                        setAllMode();
                    }
                    return;
                }

                currentMode = 'highlight';
                currentHighlightGroupKey = groupKey;
                tempLineGroup.selectAll("*").remove();
                updateLegendAndSelect(groupKey);
                updateStyles(currentZoomK);

                const merged = mergedLines.find(m => m.displayName === groupKey);
                if (merged) {
                    const points = merged.stationNames
                        .map(name => {
                            const found = stationData.find(d => d.name === name);
                            return found ? { x: found.x, y: found.y } : null;
                        })
                        .filter(p => p !== null);
                    if (points.length > 0) zoomToPoints(points);
                }
            }

            function setAllMode() {
                currentMode = 'all';
                currentHighlightGroupKey = 'all';
                tempLineGroup.selectAll("*").remove();
                updateLegendAndSelect('all');
                updateStyles(currentZoomK);
                zoomToPoints(null);
            }

            function setRouteMode() {
                if (routeStationNames.length > 0) {
                    currentMode = 'route';
                    currentHighlightGroupKey = 'all';
                    drawTempLine(routeStationNames, true);
                    updateLegendAndSelect('all');
                    updateStyles(currentZoomK);
                } else {
                    setAllMode();
                }
            }

            function updateLegendAndSelect(groupKey) {
                legendDiv.selectAll(".legend-item").each(function() {
                    const itemKey = d3.select(this).attr("data-group");
                    if (groupKey === 'all') {
                        d3.select(this).style("background", "transparent");
                    } else {
                        d3.select(this).style("background", (itemKey === groupKey) ? "#e8e8e8" : "transparent");
                    }
                });
            }

            function zoomToPoints(points) {
                let targetBounds;
                if (!points || points.length === 0) {
                    targetBounds = globalBounds;
                } else {
                    const xs = points.map(p => p.x);
                    const ys = points.map(p => p.y);
                    targetBounds = {
                        minX: Math.min(...xs),
                        maxX: Math.max(...xs),
                        minY: Math.min(...ys),
                        maxY: Math.max(...ys)
                    };
                }
                if (!targetBounds) return;

                const { minX, maxX, minY, maxY } = targetBounds;
                const rangeX = maxX - minX || 1;
                const rangeY = maxY - minY || 1;
                const centerX = (minX + maxX) / 2;
                const centerY = (minY + maxY) / 2;

                const margin = 40;
                const w = window.innerWidth;
                const h = window.innerHeight;
                const scaleX = (w - 2 * margin) / rangeX;
                const scaleY = (h - 2 * margin) / rangeY;
                const fitScale = Math.min(scaleX, scaleY, 2.5);

                const transform = d3.zoomIdentity
                    .translate(w / 2 - centerX * fitScale, h / 2 - centerY * fitScale)
                    .scale(fitScale);

                svg.transition().duration(500).call(zoom.transform, transform);
            }

            function drawTempLine(stationNames, isRestore = false) {
                if (!isRestore) {
                    routeStationNames = stationNames.slice();
                    currentMode = 'route';
                    currentHighlightGroupKey = 'all';
                    tempLineGroup.selectAll("*").remove();
                    updateLegendAndSelect('all');
                }

                const points = stationNames
                    .map(name => {
                        const found = stationData.find(d => d.name === name);
                        if (!found) {
                            console.warn(`站点 "${name}" 未找到`);
                            return null;
                        }
                        return { x: found.x, y: found.y, name: found.name, dirKeys: found.dirKeys };
                    })
                    .filter(p => p !== null);

                if (points.length < 2) {
                    alert('至少需要两个有效站点才能连线');
                    if (!isRestore) {
                        if (routeStationNames.length > 0) {
                            routeStationNames = [];
                            setAllMode();
                        }
                    }
                    return;
                }

                if (!isRestore) {
                    zoomToPoints(points.map(p => ({ x: p.x, y: p.y })));
                }

                const lineD = "M" + points.map(p => p.x + "," + p.y).join("L");
                tempLineGroup.append("path")
                    .attr("d", lineD)
                    .attr("class", "temp-line")
                    .style("stroke", "#FF0000")
                    .style("stroke-width", 3)
                    .style("stroke-dasharray", "6,4")
                    .style("fill", "none")
                    .style("opacity", 0.9)
                    .style("pointer-events", "none");

                points.forEach(p => {
                    const isTransfer = p.dirKeys.length > 1;
                    if (isTransfer) {
                        tempLineGroup.append("circle")
                            .attr("cx", p.x)
                            .attr("cy", p.y)
                            .attr("r", 5)
                            .attr("class", "temp-marker")
                            .style("fill", "#FF0000")
                            .style("stroke", "#fff")
                            .style("stroke-width", 1.5)
                            .style("pointer-events", "none");
                    }
                });

                updateStyles(currentZoomK);
            }

            function clearTempMode() {
                routeStationNames = [];
                tempLineGroup.selectAll("*").remove();
                setAllMode();
            }

            // ---- 图例 ----
            const legendDiv = d3.select("#legend");
            legendDiv.html("");

            for (const merged of mergedLines) {
                const groupKey = merged.displayName;
                const color = merged.color;

                const item = legendDiv.append("div")
                    .attr("class", "legend-item")
                    .attr("data-group", groupKey)
                    .style("display", "flex")
                    .style("align-items", "center")
                    .style("background", "transparent");

                item.append("div")
                    .style("width", "22px")
                    .style("height", "4px")
                    .style("background", color)
                    .style("margin-right", "10px")
                    .style("border-radius", "3px")
                    .style("flex-shrink", "0");

                item.append("span")
                    .attr("class", "line-name")
                    .text(groupKey);

                item.on("click", () => {
                    highlightLine(groupKey);
                });
            }

            // ---- 全局边界 ----
            if (stationData.length > 0) {
                const xs = stationData.map(d => d.x);
                const ys = stationData.map(d => d.y);
                globalBounds = {
                    minX: Math.min(...xs),
                    maxX: Math.max(...xs),
                    minY: Math.min(...ys),
                    maxY: Math.max(...ys)
                };
            } else {
                globalBounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
            }

            // ---- 暴露全局控制（与 edit.html 一致） ----
            window.__stationData = stationData;
            window.__mergedLines = mergedLines;
            window.__rawDirections = rawDirections;
            window.__highlightLine = highlightLine;
            window.__zoomToPoints = zoomToPoints;
            window.__drawTempLine = drawTempLine;
            window.__clearTempMode = clearTempMode;
            window.__setAllMode = setAllMode;
            window.__setRouteMode = setRouteMode;
            window.__tempLineGroup = tempLineGroup;
            window.__svg = svg;
            window.__zoom = zoom;
            window.__globalBounds = globalBounds;

            // ---- 初始化 ----
            setAllMode();
            legendDiv.style("display", "block");
        }
        // ============================================================
        //  4. 信息面板
        // ============================================================
        function showStationInfo(name, dirKeys) {
            const raw = window.__rawDirections || [];

            const lineMap = new Map();
            dirKeys.forEach(k => {
                const dir = raw.find(d => d.key === k);
                if (dir) {
                    if (!lineMap.has(dir.displayName)) {
                        lineMap.set(dir.displayName, dir.color);
                    }
                }
            });

            const sortedEntries = Array.from(lineMap.entries()).sort((a, b) => compareLineName(a[0], b[0]));

            let cardsHtml = '';
            sortedEntries.forEach(([displayName, color]) => {
                const textColor = getContrastTextColor(color);
                cardsHtml += `<span class="line-tag" style="background-color:${color}; color:${textColor};">${displayName}</span>`;
            });

            const count = sortedEntries.length;
            panel.style("display", "block");
        }

        function loadMetroData(jsonString) {
            try {
                const data = JSON.parse(jsonString);
                drawMap(data);
            } catch(e) {
                alert('数据解析失败: ' + e.message);
            }
        }

        // ============================================================
        //  5. 事件绑定
        // ============================================================

        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (metroData) drawMap(metroData);
            }, 250);
        });

        console.log('📂 请选择 JSON 数据文件。');
        console.log('💡 交互优先级：路线显示 > 寻路演示 > 全部线路。');
        console.log('🔍 高亮/寻路模式下，只有相关站点可悬停和点击。');

        // 禁用整个页面的右键菜单（也可仅针对 #container）
        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
