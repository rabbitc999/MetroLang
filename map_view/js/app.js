        const activeStationSet = new Set();

        /** 绘图内核（map_view/js/metro_mapcore.js）：排序、亮度、平滑曲线、模型构建都在那里。 */
        const coreApi = window.MetroMapCore || {};

        // ============================================================
        //  1. 工具函数（委托 metro_mapcore.js，实现只有一份）
        // ============================================================
        const extractPrefix = coreApi.extractPrefix;
        const extractLineNumber = coreApi.extractLineNumber;
        const compareLineName = coreApi.compareLineName;
        const getContrastTextColor = coreApi.getContrastTextColor;
        const generateSmoothPoints = coreApi.generateSmoothPoints;

        // ============================================================
        //  3. 主绘图（含优先级交互）
        // ============================================================
        let metroData = null;
        const LABEL_BASE_SIZE = 5;
        let globalBounds = null;

        function drawMap(data) {
            d3.select("#container").selectAll("*").remove();
            d3.select("#loading").style("display", "none");

            // ---- 模型构建统一走 metro_mapcore.js（与 `metro-lang html` 内嵌的是同一份） ----
            const core = window.MetroMapCore;
            if (!core) throw new Error('metro_mapcore.js 没有加载：index.html 的 <script> 顺序丢了？');
            const model = core.buildModel({
                key_city: data.key_city,
                stations: data.stations,
                lines: data.lines,
                zones: data.zones
            });

            const stations = model.stations;
            const lines = data.lines;
            const keyCity = model.keyCity;
            const rawDirections = model.rawDirections;
            const stationToDirKeys = model.stationToDirKeys;
            const platformCoordLookup = model.platformCoordLookup;
            const mergedLines = model.mergedLines;
            const expressColorByStation = model.expressColorByStation;
            const expressLinesByStation = model.expressLinesByStation;
            const routingByStation = model.routingByStation;
            // app.js 老代码按 Map 用方向→组的映射，这里包一层。
            const dirKeyToGroupKey = new Map(Object.entries(model.dirKeyToGroupKey));

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
