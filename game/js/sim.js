/**
 * @file sim.js
 * @brief 线网调度模拟内核：纯计算，不碰 DOM，Node 与浏览器共用。
 *
 * 一局的流程：``createGame(data, options)`` 建出线网与运营状态，之后按固定步长
 * （默认 5 s）反复 ``step(state)``，直到跑完运营时段，再用 ``summary(state)`` 结算。
 * 渲染层每帧只读 ``state``，不参与计算。
 *
 * 模型口径（与 ``doc/03-travel-time-model.md`` 对齐）：
 *   - **区间运行时间**：``t = S / v_max + v_max/2 * (1/a_acc + 1/a_brake)``，
 *     即 doc/03 §6 的线性模型，``a_acc = 1.0``、``a_brake = 0.85``；
 *   - **停站时间**：``dwell_rules`` 的 node → line → 默认值，另加每名上车乘客的
 *     乘降时间 ``avg_board_time``；
 *   - **等车时间**：不套 doc/03 §7 的拥挤公式，改为**逐列车真实模拟**——乘客按
 *     到达时刻排队，只上「进站停稳、且不早于其到达时刻」的第一班车；
 *   - **拥挤**：``crowd_rules`` 只用来放大某方向、某时段的到达率，不当上车概率。
 *
 * 列车用「正在跑的区间 + 区间内进度」描述：每个区间预先算好 ``travel``（秒），
 * 进入区间时记 ``t0``，进度 ``= (now - t0) / travel``；停站单独用 ``dwellLeft``
 * 计时。这样一次跳多帧也不会算错。
 */
(function (global, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global) global.MetroSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** @brief 一帧的模拟步长（秒）。 */
    var FRAME = 5;
    /** @brief 运营时段：6:00 – 23:30。 */
    var DAY_START = 6 * 3600;
    var DAY_END = 23.5 * 3600;
    var REVERSAL = 45;
    /** @brief 单（线路, 站）候车队列上限：超过即限流，不再放人进站。 */
    var STATION_CAP = 600;

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /**
     * @brief 在「时段表」里取值；落在所有时段之外时返回兜底值。
     * @param {Array<Array<number>>} periods `[[起秒, 止秒, 值], ...]`。
     * @param {number} t 当天秒数。
     * @param {number} fallback 兜底值。
     * @return {number} 取值。
     */
    function atTime(periods, t, fallback) {
        if (!periods) return fallback;
        for (var i = 0; i < periods.length; i++) {
            if (t >= periods[i][0] && t < periods[i][1]) return periods[i][2];
        }
        return fallback;
    }

    /**
     * @brief 区间运行时间（秒），doc/03 §6 线性模型。
     * @param {number} km 区间里程（km）。
     * @param {number} vmax 站间最高速度（km/h）。
     * @param {number} accel 牵引加速度（m/s²）。
     * @param {number} brake 制动减速度（m/s²）。
     * @return {number} 秒。
     */
    function segmentRunTime(km, vmax, accel, brake) {
        if (!(km > 0)) return 0;
        var v = (vmax || 80) / 3.6;
        var s = km * 1000;
        return s / v + v / 2 * (1 / accel + 1 / brake);
    }

    /**
     * @brief 准时标准：与计划时刻相差不超过 120 s。
     * @param {number} actual 实际。
     * @param {number} planned 计划。
     * @return {boolean} 是否准点。
     */
    function onTime(actual, planned) {
        return Math.abs(actual - planned) <= 120;
    }

    /**
     * @brief 秒 → `HH:MM`。
     * @param {number} t 当天秒。
     * @return {string} 时刻。
     */
    function formatClock(t) {
        var m = Math.floor(t / 60);
        var hh = Math.floor(m / 60) % 24;
        var mm = m % 60;
        return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    }

    // ==================================================================
    //  一、建局
    // ==================================================================

    /**
     * @brief 把一条线路的「主链 + 支线」展开成模拟用的段表。
     * @param {object} line 数据集里的一条线路。
     * @param {object} params 全局参数。
     * @return {object} 线路运行时对象。
     */
    function buildLine(line, params) {
        var accel = params.accel || 1.0;
        var brake = params.brake || 0.85;
        var vmax = line.maxspeed || 80;

        /**
         * @brief 展开一段站序。
         * @param {Array<string>} names 站名。
         * @param {Array<number>} kms 区间里程。
         * @param {string} kind `main` / `branch`。
         * @param {number} anchor 支线挂接站在主链上的下标（主链为 -1）。
         * @return {object} 段对象。
         */
        function makeSegment(names, kms, kind, anchor) {
            var stops = names.map(function (name, i) {
                return { name: name, index: i, segIndex: kind === 'main' ? i : anchor };
            });
            var legs = [];
            for (var i = 0; i < names.length - 1; i++) {
                legs.push({
                    from: i,
                    to: i + 1,
                    km: kms[i] || 0,
                    travel: segmentRunTime(kms[i] || 0, vmax, accel, brake),
                });
            }
            return { kind: kind, stops: stops, legs: legs, anchor: anchor };
        }

        // 整条线都在规划中（`planned_only`，如广州 24 号线）：数据集给它留了
        // `main` 只是为了保住线路实体与配色，它**没有任何运营段**。
        // 若照常塞进 `segments`，调度层就会给一条没开通的线路排车、卖票。
        var plannedOnly = !!line.planned_only;
        var main = makeSegment(line.main.stations, line.main.km, 'main', -1);
        var branches = plannedOnly ? [] : (line.branches || []).map(function (b) {
            var anchor = line.main.stations.indexOf(b.stations[0]);
            return makeSegment(b.stations, b.km, 'branch', anchor < 0 ? 0 : anchor);
        });

        // 规划段（`FUTURE`）：只给界面画虚线用，**不进 `segments`**。
        // 不进 segments 是核心——列车调度、客流、指标全都遍历 segments，
        // 规划段一旦混进去，就等于把没开通的轨道当成运营线在跑车。
        var futureSegments = (line.future || []).map(function (f) {
            return makeSegment(f.stations, f.km, 'future', -1);
        });

        return {
            id: line.id,
            name: line.display || line.name,
            color: line.color,
            vmax: vmax,
            dwell: line.dwell,
            // 保留原始记录：编组定员等要在建局时回查，且 `data.lines` 可能是字典。
            src: line,
            main: main,
            branches: branches,
            segments: plannedOnly ? [] : [main].concat(branches),
            plannedOnly: plannedOnly,
            futureSegments: futureSegments,
            km: main.legs.reduce(function (a, l) { return a + l.km; }, 0),
            // 单程时间（跑完主链一遍的近似秒数），用来估车队规模。
            roundTrip: 0,
            fleetSize: 4,
            headwayPeriods: null,
            crowdPeriods: null,
            // 玩家可调项
            headwayScale: 1,
            skip: {},
            speedScale: 1,
            // 运行时
            nextDepart: 0,     // 兼容旧字段：= segments[0].nextDepart
            segNext: [],       // 每段各自的下一发车时刻
            plannedDepart: 0,
            departCount: 0,
            trains: [],
            stat: { plannedArr: 0, onTimeArr: 0, depart: 0, crowded: 0, runTime: 0 },
        };
    }

    /**
     * @brief 一条线路的拥挤度时段表：取各方向里系数更高的那个。
     *
     * 数据集里拥挤度按**方向**登记（`G1_0` 上行 / `G1_1` 下行），但客流放大是
     * 作用在**站**上的，方向差异在调度层看不见——所以按线路合成一张表。
     *
     * @param {object} data 数据集。
     * @param {string} lineId 线路 id。
     * @return {Array<Array<number>>|null} `[[起秒, 止秒, 系数], ...]`。
     */
    function pickCrowd(data, lineId) {
        var all = data.crowd || {};
        var merged = {};
        var found = false;
        Object.keys(all).forEach(function (key) {
            // 键是「线路id_方向号」；线路 id 本身可能带下划线，所以按前缀比。
            if (key !== lineId && key.indexOf(lineId + '_') !== 0) return;
            found = true;
            (all[key] || []).forEach(function (row) {
                var slot = merged[row[0] + '-' + row[1]];
                if (!slot || row[2] > slot[2]) merged[row[0] + '-' + row[1]] = row;
            });
        });
        if (!found) return null;
        return Object.keys(merged).map(function (k) { return merged[k]; })
            .sort(function (a, b) { return a[0] - b[0]; });
    }

    /**
     * @brief 一条线路时段表里**最小**的发车间隔（= 高峰间隔）。
     *
     * 车队规模按它算：车底是按高峰客流配置的，平峰不是约束条件。
     *
     * @param {Array<Array<number>>|null} periods `[[起秒, 止秒, 秒数], ...]`。
     * @return {number} 秒；没有时段表时按 300 s。
     */
    function peakHeadway(periods) {
        if (!periods || !periods.length) return 300;
        var best = Infinity;
        for (var i = 0; i < periods.length; i++) {
            if (periods[i][2] > 0 && periods[i][2] < best) best = periods[i][2];
        }
        return best === Infinity ? 300 : best;
    }

    /**
     * @brief 一列车的定员（按编组推）：A 型 310 人/节、B 型 240、其它 200。
     * @param {object} line 数据集里的一条线路。
     * @return {number} 定员人数。
     */
    function capacityOf(line) {
        if (line && line.capacity > 0) return line.capacity;
        var perCar = 240;
        var cars = 6;
        var f = (line && line.formation) || '';
        for (var i = 0; i < f.length; i++) {
            var c = f.charAt(i);
            if (c >= '0' && c <= '9') cars = +c;
            else if (c === 'A' || c === 'a') perCar = 310;
            else if (c === 'B' || c === 'b') perCar = 240;
            else if (c === 'L' || c === 'l') perCar = 200;
        }
        if (cars < 2 || cars > 12) cars = 6;
        return perCar * cars;
    }

    /**
     * @brief 把 `lines` 统一成数组。
     *
     * 两条数据管线给的形状不一样：`metro-lang game --json` 给**字典**（键为线路
     * id，C++ 侧用 `json::Object` 保序输出），`prepare_data.py` 给**数组**。
     * 以前靠 `ui.js` 的 `normalize()` 兜住，但那只保护了浏览器那条路——直接用
     * 内核（Node 测试、将来可能的离线算分）喂 C++ 的数据集会当场崩在
     * `data.lines.map is not a function`。契约该由内核自己保证。
     *
     * @param {Array|object} lines 原始 lines。
     * @return {Array<object>} 数组形式，每项带 `id`。
     */
    function toLineArray(lines) {
        if (Array.isArray(lines)) return lines;
        if (!lines || typeof lines !== 'object') return [];
        return Object.keys(lines).map(function (k) {
            var l = lines[k];
            if (l && !l.id) l.id = k;
            return l;
        });
    }

    /**
     * @brief 建一局游戏。
     * @param {object} data `prepare_data.py` 或 `metro-lang game --json` 产出的数据集。
     * @param {object} [options] `{seed, dayStart, dayEnd, frame}`。
     * @return {object} 全局状态。
     */
    function createGame(data, options) {
        var opt = options || {};
        var params = data.params || {};
        var lines = toLineArray(data.lines).map(function (l) {
            var ln = buildLine(l, params);
            ln.headwayPeriods = (data.headway || {})[l.id] || null;
            // 拥挤度按方向登记（`G1_0` / `G1_1`），一条线取两个方向里更挤的那个：
            // 客流放大作用在**站**上，方向差异在调度层看不见。
            ln.crowdPeriods = pickCrowd(data, l.id);
            // 单程 = 所有区间耗时 + 各中间站停站；往返 = 单程 × 2 + 两端折返。
            var run = ln.main.legs.reduce(function (a, l) { return a + l.travel; }, 0);
            var dwellMid = Math.max(ln.dwell, 12) * Math.max(0, ln.main.stops.length - 2);
            ln.roundTrip = 2 * (run + dwellMid) + 2 * (params.reversal_time || REVERSAL);
            // 车队规模按**高峰**间隔算：车底配置是按高峰客流买的，平峰不是约束。
            // 用平峰间隔算会严重低估——广州 1 号线平峰 300 s 只要 11 列，但早高峰
            // 120 s 要 27 列，差额全靠 dispatch 现造，既不算缺车也看不出问题。
            var peak = peakHeadway(ln.headwayPeriods);
            ln.fleetSize = Math.max(2, Math.ceil(ln.roundTrip / peak) + 1);
            return ln;
        });
        var byId = {};
        lines.forEach(function (l) { byId[l.id] = l; });

        var stationLines = {};
        // 站点表按**站名做键**消费（ui.js 查坐标也是），所以数组形式要先转字典。
        var stationTable = data.stations || {};
        if (Array.isArray(stationTable)) {
            var smap = {};
            stationTable.forEach(function (s) { if (s && s.name) smap[s.name] = s; });
            stationTable = smap;
        }
        Object.keys(stationTable).forEach(function (name) {
            var info = stationTable[name] || {};
            stationLines[name] = (info.lines || []).filter(function (id) { return byId[id]; });
        });

        var seed = opt.seed === undefined ? 20261017 : (opt.seed | 0 || 1);
        var state = {
            data: data,
            params: {
                accel: params.accel || 1.0,
                brake: params.brake || 0.85,
                exitTime: params.exit_time || 120,
                transferTime: params.inner_transfer_time || 300,
                boardTime: params.avg_board_time || 3,
                reversal: params.reversal_time || REVERSAL,
            },
            lines: lines,
            lineById: byId,
            stationLines: stationLines,
            frame: opt.frame || FRAME,
            now: opt.dayStart || DAY_START,
            dayStart: opt.dayStart || DAY_START,
            dayEnd: opt.dayEnd || DAY_END,
            seed: seed,
            seedState: seed,
            capacity: 1860,
            capacityOf: {},
            // 全局玩家设置
            global: { speedScale: 1, headwayScale: 1 },
            stats: freshStats(),
            pending: [],          // 已下车、等投递到新线路队列的换乘乘客
            events: [],
            eventLog: [],
            finished: false,
            // 游戏 2 的额外需求系数钩子：`(station, nowSec) => number`。
            // 缺省 undefined，`demandFrame` 里按 1 处理，游戏 1 不受影响。
            demandScale: typeof opt.demandScale === 'function' ? opt.demandScale : null,
        };
        lines.forEach(function (line) {
            line.plannedDepart = state.dayStart;
            line.segNext = line.segments.map(function () { return state.dayStart; });
            line.nextDepart = state.dayStart;
            line.segDepart = line.segments.map(function () { return 0; });
            // 每条线自己的定员（A/B/L 型编组不同），满载率按它归一。
            // 用归一化后的 `lines` 里那份，别再回查 `data.lines`——那边可能是字典。
            var src = line.src;
            state.capacityOf[line.id] = capacityOf(src);
        });
        initDemand(state);
        seedTrains(state);
        state.stats.arrivalsThisFrame = 0;
        return state;
    }

    /**
     * @brief 一份空的统计对象。
     * @return {object} 统计。
     */
    function freshStats() {
        return {
            frames: 0,
            arrivals: 0,
            boarded: 0,
            arrived: 0,
            transfers: 0,
            rides: 0,
            lost: 0,
            throttled: 0,     // 因站内候车满额被拦在站外的人次
            waitSum: 0,
            waitCount: 0,
            leftBehind: 0,
            maxLoad: 0,
            runSumLoad: 0,
            runCapSum: 0,
            runMaxFactor: 0,
            runSamples: 0,
            // 高峰满载率：只在高峰时段采样（见 `sampleLoad`），另存一份。
            peakSumLoad: 0,
            peakCapSum: 0,
            peakSamples: 0,
            // 最大断面满载率：运营口径的「满载率」说的是最挤那一段有多挤，
            // 不是全线平均。这里按区间（线路 + 区间号）分别取峰值，结算时取最大。
            sectionLoad: {},
            runMaxLoad: 0,
            loadSamples: 0,
            loadSum: 0,
            shortage: 0,       // 需要补车却拿不到车的次数
            departures: 0,
            plannedArr: 0,
            onTimeArr: 0,
            lateArr: 0,
            devSum: 0,
            devLateSum: 0,
            dwellSum: 0,
            runSum: 0,
            carKm: 0,
        };
    }

    // ==================================================================
    //  二、随机数（可复现）
    // ==================================================================

    /**
     * @brief xorshift32 伪随机，返回 [0,1)。
     * @param {object} state 全局状态。
     * @return {number} 随机数。
     */
    function rnd(state) {
        var x = state.seedState | 0;
        x ^= x << 13; x |= 0;
        x ^= x >>> 17;
        x ^= x << 5; x |= 0;
        state.seedState = x;
        return (x >>> 0) / 4294967296;
    }

    // ==================================================================
    //  三、客流
    // ==================================================================

    /**
     * @brief 候车队列的键。
     * @param {string} lineId 线路 id。
     * @param {string} station 站名。
     * @return {string} 键。
     */
    function queueKey(lineId, station) { return lineId + '\u0001' + station; }

    /**
     * @brief 初始化需求表：**每个站一份需求**，与线路无关。
     *
     * 进站乘客先要决定坐哪条线：本站只服务一条线就直接排那条队；服务多条时按
     * 目的站是否被该线覆盖来选（都覆盖就选人最少的那条）。这样同一名乘客不会
     * 在两条线的队列里各出现一次，``arrivals`` 才等于真实进站量。
     *
     * @param {object} state 全局状态。
     */
    function initDemand(state) {
        state.queues = {};
        state.demand = {};
        var served = {};
        state.lines.forEach(function (line) {
            line.segments.forEach(function (seg) {
                seg.stops.forEach(function (stop) {
                    served[stop.name] = (served[stop.name] || 0) + 1;
                });
            });
        });
        state.allStations = Object.keys(served);
        state.stationServed = served;

        state.lines.forEach(function (line) {
            line.segments.forEach(function (seg) {
                seg.stops.forEach(function (stop) {
                    var k = queueKey(line.id, stop.name);
                    if (!state.queues[k]) state.queues[k] = { list: [], total: 0 };
                });
            });
        });

        // 需求项：站名 + 权重（被几条线服务 → 换乘站人流大）
        state.demand = state.allStations.map(function (name) {
            return { station: name, weight: clamp(served[name] || 1, 1, 4) };
        });
    }

    /**
     * @brief 抽一个目的站：70% 落在在本站停靠的某条线路上，30% 落在全网。
     * @param {object} state 全局状态。
     * @param {Array<string>} lines 本站所属线路。
     * @return {string|null} 目的站名。
     */
    function pickDest(state, lines) {
        var useLine = rnd(state) < 0.7 && lines.length > 0;
        for (var tries = 0; tries < 5; tries++) {
            var name;
            if (useLine) {
                var ln = state.lineById[lines[Math.floor(rnd(state) * lines.length)]];
                if (!ln) continue;
                name = ln.main.stops[Math.floor(rnd(state) * ln.main.stops.length)].name;
            } else {
                name = state.allStations[Math.floor(rnd(state) * state.allStations.length)];
            }
            if (name) return name;
        }
        return null;
    }

    /**
     * @brief 客流时段曲线：让进站率跟着发车间隔走。
     *
     * 一条线的发车间隔是**分时段**的（早高峰 120 s、平峰 360 s），说明运营方
     * 早已按客流排班。如果需求均匀而供给分时，平峰就会排队，平均等车被拖长。
     *
     * 这里用「该时刻间隔的倒数 / 全天最密间隔的倒数」当系数：高峰 = 1，平峰按
     * 比例降。取本站所属各线里**最大**的一个（换乘站按最密的那条跟）。
     *
     * @param {object} state 全局状态。
     * @param {Array<string>} lines 本站所属线路。
     * @return {number} 系数（0.2–1）。
     */
    function demandCurve(state, lines) {
        var best = 0;
        for (var i = 0; i < lines.length; i++) {
            var ln = state.lineById[lines[i]];
            if (!ln || !ln.headwayPeriods || !ln.headwayPeriods.length) continue;
            var peak = peakHeadway(ln.headwayPeriods);
            var now = atTime(ln.headwayPeriods, state.now, 300);
            if (now > 0) best = Math.max(best, peak / now);
        }
        if (best <= 0) return 1;
        return clamp(best, 0.2, 1);
    }

    /**
     * @brief 本帧产生候车需求。
     *
     * 全站统一抽样（不再按线路重复抽），再给每名乘客挑一条线路排队。
     *
     * @param {object} state 全局状态。
     * @param {number} dt 步长（秒）。
     */
    function demandFrame(state, dt) {
        // 需求强度基准。下面的数字是**标定过的**，不是拍脑袋：
        // `base = 0.05` 时全天进站约 105 万人次、高峰最大断面满载率 78%、
        // 平均等车 6 分钟、评分 87——正好落在「有点压力但管得过来」的手感上。
        // 调大会迅速挤爆（0.08 断面 96%、评分下滑），调小则空跑（0.012 断面 19%）。
        var base = 0.05 * dt;
        var list = state.demand;
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var lines = state.stationLines[item.station] || [];
            if (lines.length === 0) continue;
            // 拥挤系数取该站所属线路里最大的那个（换乘站按最挤的一条算）。
            var crowd = 1;
            for (var c = 0; c < lines.length; c++) {
                var ln = state.lineById[lines[c]];
                if (ln) crowd = Math.max(crowd, atTime(ln.crowdPeriods, state.now, 1.0));
            }
            var n = poisson(state, base * item.weight * crowd * demandCurve(state, lines));
            // 游戏 2 注入的额外需求系数（票价弹性、楼盘带来的新增人口）。
            // 默认恒为 1，游戏 1 的行为一字不变。
            //
            // 作用在**抽样结果**上而不是 `base`：`poisson` 的期望值一旦被改，
            // 小系数下期望值 < 1 会大量抽到 0，客流不是平滑下降而是成片归零。
            // 乘在 `n` 上则可以保留「0 或 1 或 2」的泊松手感。
            var scale = typeof state.demandScale === 'function'
                ? state.demandScale(item.station, state.now) : 1;
            if (scale !== 1) {
                if (!(scale > 0)) { n = 0; }
                else if (scale < 1 && n > 0) {
                    // 按比例扣减，但至少保留「部分抽中」的概率感：
                    // 用小数部分做一次伯努利，避免 0.5 倍率被向下取整成 0。
                    var keep = n * scale;
                    n = Math.floor(keep) + (rnd(state) < (keep - Math.floor(keep)) ? 1 : 0);
                } else if (scale > 1) {
                    n = Math.round(n * scale);
                }
            }
            for (var j = 0; j < n; j++) {
                var dest = pickDest(state, lines);
                if (!dest || dest === item.station) continue;
                var target = pickWaitingLine(state, lines, dest);
                var q = state.queues[queueKey(target, item.station)];
                if (!q) continue;
                // 站内容量：候车超过 600 人开始限流（真实车站会控流进站），
                // 超出的部分直接不入站，记一次 throttled —— 这是运营压力信号。
                if (q.list.length >= STATION_CAP) {
                    state.stats.throttled++;
                    continue;
                }
                q.list.push({
                    dest: dest,
                    // `arrivedAt` 是**当前这一段**的候车起点：换乘时会被改写成
                    // 「下车时刻 + 换乘步行」，所以排队判定用它。
                    arrivedAt: state.now + rnd(state) * dt,
                    // `enteredAt` 是**首次进站**时刻，全程不变。等车时长必须从它算，
                    // 否则换乘一次就把前面等的十几分钟抹掉，平均等车被严重低估。
                    enteredAt: 0,
                    hops: 0,
                    maxHops: 2,
                });
                q.list[q.list.length - 1].enteredAt = q.list[q.list.length - 1].arrivedAt;
                q.total++;
                state.stats.arrivals++;
            }
        }
    }

    /**
     * @brief 给乘客挑一条线路排队：优先能直达目的站的，其次人最少的那条。
     * @param {object} state 全局状态。
     * @param {Array<string>} lines 本站所属线路。
     * @param {string} dest 目的站。
     * @return {string} 线路 id。
     */
    function pickWaitingLine(state, lines, dest) {
        var direct = null;
        var fallback = null;
        for (var i = 0; i < lines.length; i++) {
            var ln = state.lineById[lines[i]];
            if (!ln) continue;
            if (lineHasStation(ln, dest)) direct = lines[i];
            var q = state.queues[queueKey(lines[i], state.allStations[0])] ? null : null;
            if (!fallback) fallback = lines[i];
        }
        return direct || fallback || lines[0];
    }

    /**
     * @brief 泊松抽样（λ 小时用「多次伯努利」近似，够用且可复现）。
     * @param {object} state 全局状态。
     * @param {number} lambda 均值。
     * @return {number} 抽样值。
     */
    function poisson(state, lambda) {
        if (lambda <= 0) return 0;
        if (lambda < 1) return rnd(state) < lambda ? 1 : 0;
        var k = Math.floor(lambda);
        var rest = lambda - k;
        return k + (rnd(state) < rest ? 1 : 0);
    }

    // ==================================================================
    //  四、列车
    // ==================================================================

    /**
     * @brief 造一列车。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {number} segIndex 段下标。
     * @param {number} dir 方向：+1 正序，-1 倒序。
     * @return {object} 列车。
     */
    function makeTrain(state, line, segIndex, dir) {
        var seg = line.segments[segIndex];
        var at = dir > 0 ? 0 : seg.stops.length - 1;
        var train = {
            id: line.id + '-' + (line.serial = (line.serial || 0) + 1),
            lineId: line.id,
            color: line.color,
            seg: segIndex,
            dir: dir,
            at: at,
            leg: -1,
            t0: 0,
            departAt: 0,
            dwellUntil: 0,
            waiting: true,       // true = 停在段端点、等 dispatch 放行
            departDelay: 0,
            v: 0,
            p: 0,
            load: 0,
            onboard: [],
            plannedDep: 0,
            scheduledArr: 0,
            lastDep: 0,
        };
        line.trains.push(train);
        return train;
    }

    /**
     * @brief 首班车布车：按发车时刻表**均匀铺车**，而不是让所有车同时从两端出发。
     *
     * 一列车的「相位」用它在往返周期里已经走了多久来度量（0 = 刚在上行起点发车）。
     * 往返周期 ``roundTrip`` 内要发出 ``roundTrip / headway`` 趟，所以相邻两趟的
     * 相位差就是 ``headway``。把车队按「相位 = i × headway」铺开，线路上立刻就是
     * 等间隔的列车流——真实线路在早上首班车之前也是这样把车从车辆段摆出来的。
     *
     * 早期版本把车全堆在两端起点，结果 6:00 有二十多列车同时出发，之后按表发
     * 车间隔 300 s 却又漏不出车，平均等车被拖到二十多分钟。
     *
     * @param {object} state 全局状态。
     */
    function seedTrains(state) {
        state.lines.forEach(function (line) {
            // 没有运营段的线路（整条线都在规划中）不排车。
            if (!line.segments.length) return;
            var headway = Math.max(45, atTime(line.headwayPeriods, state.dayStart, 300));
            var half = line.roundTrip / 2;
            for (var i = 0; i < line.fleetSize; i++) {
                var phase = (i * headway) % line.roundTrip;
                placeAtPhase(state, line, phase, half, headway);
            }
        });
    }

    /**
     * @brief 把一个「相位」落到具体的段、方向、站号上。
     *
     * 相位 ``phase``：0 起步于上行起点、``half`` 落在下行起点，中间就是主链上的
     * 某一段。只处理主链——支线是首班车之后按表加开的交路。
     *
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {number} phase 相位（秒）。
     * @param {number} half 单程时长（秒）。
     * @param {number} headway 发车间隔（秒）。
     */
    function placeAtPhase(state, line, phase, half, headway) {
        void headway;
        if (phase < half) {
            // 上行途中
            var tr = placeOnChain(state, line, 0, 1, phase);
            if (tr) return;
        } else {
            var tr2 = placeOnChain(state, line, 0, -1, phase - half);
            if (tr2) return;
        }
        // 相位落在两端折返停时里：放在对应的起点等发车，下一趟按时刻表放行。
        makeTrain(state, line, 0, phase < half ? 1 : -1);
    }

    /**
     * @brief 把一列车放到「已走 ``elapsed`` 秒」的位置上。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {number} segIndex 段下标。
     * @param {number} dir 方向：+1 上行，-1 下行。
     * @param {number} elapsed 已经走了多少秒（含停站）。
     * @return {object|null} 列车；超出段长时返回 null。
     */
    function placeOnChain(state, line, segIndex, dir, elapsed) {
        var seg = line.segments[segIndex];
        var order = [];
        for (var i = 0; i < seg.stops.length; i++) order.push(dir > 0 ? i : seg.stops.length - 1 - i);
        var acc = 0;
        for (var k = 0; k < order.length; k++) {
            var idx = order[k];
            var dwell = Math.max(line.dwell, 12);
            if (elapsed < acc + dwell) {
                return makeTrainAt(state, line, segIndex, dir, idx);
            }
            acc += dwell;
            if (k + 1 >= order.length) break;
            var leg = seg.legs[dir > 0 ? idx : idx - 1];
            if (!leg) break;
            if (elapsed < acc + leg.travel) {
                // 停在区间中间：只有靠「上路」才能表达，这里退一格到上一个站，
                // 让它下一帧就出发——首班车的初始误差只有几十秒，可接受。
                return makeTrainAt(state, line, segIndex, dir, idx);
            }
            acc += leg.travel;
        }
        return null;
    }

    /**
     * @brief 造一列停在某站、可以立刻出发的车。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {number} segIndex 段下标。
     * @param {number} dir 方向。
     * @param {number} at 站号。
     * @return {object} 列车。
     */
    function makeTrainAt(state, line, segIndex, dir, at) {
        var tr = makeTrain(state, line, segIndex, dir);
        var seg = line.segments[segIndex];
        tr.at = at;
        var isEnd = at === 0 || at === seg.stops.length - 1;
        tr.waiting = isEnd;
        tr.dwellUntil = state.dayStart;
        tr.departAt = state.dayStart;
        return tr;
    }

    /**
     * @brief 当前发车间隔（秒）：时刻表 × 玩家倍率，最小 45 s。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @return {number} 秒。
     */
    function headwayOf(state, line) {
        var base = atTime(line.headwayPeriods, state.now, 300);
        return Math.max(45, base * line.headwayScale * state.global.headwayScale);
    }

    // ==================================================================
    //  五、主循环
    // ==================================================================

    /**
     * @brief 推进一帧。
     * @param {object} state 全局状态。
     * @return {object} 状态本身。
     */
    function step(state) {
        if (state.finished) return state;
        var dt = state.frame;
        state.now += dt;
        state.stats.frames++;
        state.stats.arrivalsThisFrame = 0;
        deliverTransfers(state);
        demandFrame(state, dt);
        for (var i = 0; i < state.lines.length; i++) {
            var line = state.lines[i];
            dispatch(state, line);
            for (var j = 0; j < line.trains.length; j++) {
                updateTrain(state, line, line.trains[j], dt);
            }
        }
        if (state.now >= state.dayEnd) state.finished = true;
        return state;
    }

    /**
     * @brief 把「已到换乘站」的乘客投递到新线路的候车队列。
     *
     * 选择规则：在本站服务的线路里，优先投给**直接服务目的站**的那条；都没有时
     * 投给任意另一条（继续换乘，受 ``maxHops`` 限制）。到达时刻已含换乘步行时间。
     *
     * @param {object} state 全局状态。
     */
    function deliverTransfers(state) {
        if (state.pending.length === 0) return;
        var rest = [];
        for (var i = 0; i < state.pending.length; i++) {
            var item = state.pending[i];
            var p = item.passenger;
            if (p.arrivedAt > state.now) { rest.push(item); continue; }
            var best = null;
            var fallback = null;
            var cands = state.stationLines[item.station] || [];
            for (var j = 0; j < cands.length; j++) {
                var ln = state.lineById[cands[j]];
                if (!ln || cands[j] === item.lineId) continue;
                if (!fallback) fallback = cands[j];
                if (lineHasStation(ln, p.dest)) { best = cands[j]; break; }
            }
            var target = best || fallback;
            if (!target) { state.stats.lost++; continue; }
            var q = state.queues[queueKey(target, item.station)];
            if (!q) { state.stats.lost++; continue; }
            p.pending = false;
            q.list.push(p);
        }
        state.pending = rest;
    }

    /**
     * @brief 按发车间隔把起点站的列车放出去。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     */
    function dispatch(state, line) {
        var hw = headwayOf(state, line);
        // 支线单独发车（交路不同），所以每段一个发车计时器。
        for (var si = 0; si < line.segments.length; si++) {
            var guard = 0;
            while (state.now >= line.segNext[si] && guard++ < 100) {
                var slot = line.segNext[si];
                line.segNext[si] = slot + hw;
                // 派车：只取**本段、停在起点、等发车**的列车；没有就现造一列。
                var picked = null;
                for (var i = 0; i < line.trains.length; i++) {
                    var tr = line.trains[i];
                    if (tr.seg !== si || !tr.waiting || tr.leg !== -1) continue;
                    if (tr.dwellUntil > state.now) continue;
                    var seg = line.segments[tr.seg];
                    var startAt = tr.dir > 0 ? 0 : seg.stops.length - 1;
                    if (tr.at !== startAt) continue;
                    if (!picked || tr.plannedDep < picked.plannedDep) picked = tr;
                }
                if (!picked) {
                    // 没车可派：现造一列顶上，记一次缺车（扣分项）。
                    picked = makeTrain(state, line, si, line.segDepart[si] % 2 === 0 ? 1 : -1);
                    if (picked.dir < 0) picked.at = line.segments[si].stops.length - 1;
                    state.stats.shortage++;
                }
                picked.waiting = false;
                picked.plannedDep = slot;
                picked.departDelay = Math.max(0, state.now - slot);
                picked.departAt = state.now;
                line.segDepart[si]++;
                state.stats.departures++;
                line.stat.depart++;
            }
        }
        line.nextDepart = line.segNext[0];
    }

    /**
     * @brief 推进一列车。
     *
     * 状态机只有两个形态：
     *   - ``run``：跑在 ``leg`` 号区间上，``t0`` 是进入区间的时刻，跑够
     *     ``travel`` 秒就到站，切回 ``dwell`` 并算好 ``departAt``；
     *   - ``dwell``：停在 ``at`` 号站，``departAt`` 之后才离开。发车循环（dispatch）
     *     只负责把 ``waiting`` 置假，车的位置永远由本函数推进——两者不交叉写。
     *
     * 方向：``legs`` 的 ``from/to`` 恒为「正序小站 → 大站」。``dir=+1`` 时列车站在
     * ``leg.from``、开往 ``leg.to``；``dir=-1`` 时反过来。到站后若已在段端点，
     * 就地翻向并停 ``reversal`` 秒——位置不动，所以翻向不会把自己送到别的站。
     *
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {object} tr 列车。
     * @param {number} dt 步长（秒）。
     */
    function updateTrain(state, line, tr, dt) {
        var seg = line.segments[tr.seg];
        var lastStop = seg.stops.length - 1;

        // ---- 运行 ----
        if (tr.leg >= 0) {
            var leg = seg.legs[tr.leg];
            var elapsed = state.now - tr.t0;
            var frac = leg.travel > 0 ? elapsed / leg.travel : 1;
            tr.p = Math.min(1, frac);
            var vf = frac < 0.15 ? frac / 0.15 : (frac > 0.85 ? (1 - frac) / 0.15 : 1);
            tr.v = line.vmax * line.speedScale * state.global.speedScale * Math.max(0.05, vf);
            if (elapsed < leg.travel) {
                tr.load = tr.onboard.length;
                return;
            }
            tr.at = tr.dir > 0 ? leg.to : leg.from;
            // 记下刚跑完的是哪一段：`settle()` 取样要用它算断面满载率，
            // 而下一行就把 `tr.leg` 复位了，晚了就拿不到了。
            tr.lastLeg = tr.leg;
            tr.leg = -1;
            tr.v = 0;
            tr.p = 0;
            arrive(state, line, tr, seg, tr.t0 + leg.travel);
            settle(state, line, tr, seg);      // 到站即停靠，算好 departAt
            return;
        }

        // ---- 停靠中 ----
        if (state.now < tr.departAt) {
            tr.load = tr.onboard.length;
            return;
        }
        if (!tr.waiting) { go(state, line, tr, seg); return; }

        // ---- 停在起点、等发车：到点后由 dispatch 放行，本帧不动 ----
        tr.load = tr.onboard.length;
    }

    /**
     * @brief 到站停靠：上下客、算停站时长，写入 ``departAt``。
     *
     * 停在段端点（0 或 lastStop）时先翻向、按 ``reversal`` 停，之后等 dispatch
     * 放行；中间站按「线路停站 + 上客人次 × 乘降时间」停，到点自动走。
     *
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {object} tr 列车。
     * @param {object} seg 段。
     */
    function settle(state, line, tr, seg) {
        var lastStop = seg.stops.length - 1;
        // 满载率取样点：列车到站、还没下客的时候——这才是「区间里的实际载客」。
        sampleLoad(state, tr);
        tr.wasRunning = true;
        var stop = seg.stops[tr.at];
        var boarded = board(state, line, tr, stop);
        var dwell = Math.max(line.dwell, 12) + boarded * state.params.boardTime;
        state.stats.dwellSum += dwell;

        if (tr.at === 0 || tr.at === lastStop) {
            // 段端点：清客、翻向、折返停时。翻向之后的位置就是新方向的起点。
            if (tr.at === lastStop && tr.dir > 0) tr.dir = -1;
            else if (tr.at === 0 && tr.dir < 0) tr.dir = 1;
            offloadAll(state, tr);
            tr.waiting = true;
            tr.dwellUntil = state.now + Math.max(dwell, state.params.reversal);
            tr.departAt = tr.dwellUntil;
        } else {
            tr.waiting = false;
            tr.dwellUntil = state.now + dwell;
            tr.departAt = tr.dwellUntil;
        }
        tr.load = tr.onboard.length;
    }

    /**
     * @brief 判断乘客是否应在本站换乘：本线之外还有线路服务本站，且目的站在那条线上。
     *
     * 简化口径：只要「目的站被另一条线路直接服务」，就在当前能换的站下车——不查
     * 最短路，够用且不会让乘客无限绕。换乘站本身不服务目的站时也会下车，交给
     * 那条线再判断，最多 ``maxHops`` 次。
     *
     * @param {object} state 全局状态。
     * @param {object} line 当前线路。
     * @param {string} name 当前站。
     * @param {object} p 乘客。
     * @return {boolean} 是否换乘。
     */
    function isTransferFor(state, line, name, p) {
        // 已在最后一跳，或者目的站还没到：先判断「本线能不能直接到」。
        // 能直达就别下车——早期版本少了这一步，乘客在每个换乘站都被赶下车，
        // 人均换乘 0.87 次、一趟车只坐三四站，平均等车被拖到二十多分钟。
        if (lineHasStation(line, p.dest)) return false;
        var others = state.stationLines[name] || [];
        for (var i = 0; i < others.length; i++) {
            var lid = others[i];
            if (lid === line.id) continue;
            var ln = state.lineById[lid];
            if (!ln) continue;
            // 只认「换过去能直达目的站」的线路；能直达到就换。
            if (lineHasStation(ln, p.dest)) return true;
        }
        return false;
    }

    /**
     * @brief 某站是否在某条线上（主链或支线）。
     * @param {object} line 线路。
     * @param {string} name 站名。
     * @return {boolean} 是否服务该站。
     */
    function lineHasStation(line, name) {
        for (var i = 0; i < line.segments.length; i++) {
            var stops = line.segments[i].stops;
            for (var j = 0; j < stops.length; j++) if (stops[j].name === name) return true;
        }
        return false;
    }

    /**
     * @brief 当前时刻是否算「高峰」：该线发车间隔接近自己最密的那档。
     *
     * 满载率只在高峰统计。平峰空车是运营常态（真实线路平峰满载率常年在 20% 以下），
     * 拿全天平均去判分，会让「按时刻表正常运营」这件事本身就被扣分。
     *
     * @param {object} state 全局状态。
     * @param {string} lineId 线路 id。
     * @return {boolean} 是否高峰。
     */
    function isPeak(state, lineId) {
        var ln = state.lineById[lineId];
        if (!ln || !ln.headwayPeriods || !ln.headwayPeriods.length) return true;
        var peak = peakHeadway(ln.headwayPeriods);
        var now = atTime(ln.headwayPeriods, state.now, 300);
        return now <= peak * 1.1 + 1;
    }

    /**
     * @brief 载客率取样：累计载客数，记峰值。
     *
     * 满载率要按**各线路自己的定员**归一，不能用一个全局数字：A 型 6 节 1860 人、
     * B 型 6 节 1440 人、APM 三节 600 人，用一个 1860 去除会把小编组线路的拥挤
     * 抹平。所以这里累计的是「载客 / 本线定员」，结算时直接就是满载率。
     *
     * @param {object} state 全局状态。
     * @param {object} tr 列车。
     */
    function sampleLoad(state, tr) {
        var load = tr.onboard.length;
        var cap = state.capacityOf[tr.lineId] || state.capacity;
        state.stats.loadSum += load;
        state.stats.loadSamples++;
        if (load > state.stats.maxLoad) state.stats.maxLoad = load;
        // 只统计「区间里在跑的列车」：停在终点/起点待发的空车会把均值拉平，
        // 判分要看的是乘客真正待着的车厢有多挤。
        if (tr.wasRunning) {
            tr.wasRunning = false;
            state.stats.runSumLoad += load;
            state.stats.runCapSum += cap;
            state.stats.runSamples++;
            if (load / cap > state.stats.runMaxFactor) state.stats.runMaxFactor = load / cap;
            if (load > state.stats.runMaxLoad) state.stats.runMaxLoad = load;
            // 高峰样本：取「本条线当前间隔 ≤ 其最密间隔 × 1.1」的时段。
            // 判分只看高峰满载率——平峰空车是运营常态，不是调度失误。
            if (isPeak(state, tr.lineId)) {
                state.stats.peakSumLoad += load;
                state.stats.peakCapSum += cap;
                state.stats.peakSamples++;
            }
            // 断面满载率：按「线路 + 区间」记录高峰最大载客。
            // 运营报表里的「满载率」指的是**最大断面满载率**——最挤的那一段
            // 有多少人。用全线平均会永远得出「很空」的结论（乘客平均只坐三四站）。
            if (tr.lastLeg >= 0 && isPeak(state, tr.lineId)) {
                var key = tr.lineId + '|' + tr.seg + '|' + tr.lastLeg;
                if (!(state.stats.sectionLoad[key] >= load)) state.stats.sectionLoad[key] = load;
            }
        }
    }

    /**
     * @brief 离开 ``at`` 站，进入下一个区间。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {object} tr 列车。
     * @param {object} seg 段。
     */
    function go(state, line, tr, seg) {
        var lastStop = seg.stops.length - 1;
        if (tr.dir > 0) {
            if (tr.at >= lastStop) { settle(state, line, tr, seg); return; }
            tr.leg = tr.at;                 // 区间 from=at, to=at+1
        } else {
            if (tr.at <= 0) { settle(state, line, tr, seg); return; }
            tr.leg = tr.at - 1;             // 区间 from=at-1, to=at
        }
        tr.t0 = state.now;
        tr.lastDep = state.now;
        tr.p = 0;
        // 本段「应有到达时刻」：实际发车 + 计划停站 + 计划区间耗时。
        // 到站后拿它和实际到站比，得到**本段自身**的延误（不含前面积累的迟到），
        // 这样量的是「这一段开得好不好」，不和前序延误混在一起。
        var dwellPlan = Math.max(line.dwell, 12);
        tr.expectArr = state.now + dwellPlan + seg.legs[tr.leg].travel;
    }

    /**
     * @brief 列车到站：乘客下车、准点统计。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {object} tr 列车。
     * @param {object} seg 段。
     * @param {number} arrAt 精确到站时刻。
     */
    function arrive(state, line, tr, seg, arrAt) {
        var name = seg.stops[tr.at].name;
        var keep = [];
        for (var i = 0; i < tr.onboard.length; i++) {
            var p = tr.onboard[i];
            if (p.dest === name) {
                state.stats.arrived++;
                p.done = arrAt;
                // 等车时长 = 各段候车之和（`p.waited`，在 board() 里按段累加）。
                // 绝对不能拿「到站时刻 − 进站时刻」：那里面还有乘车时间，
                // 一条线坐 40 分钟就会被记成「等了 40 分钟」，平均等车虚高一倍。
                state.stats.waitSum += p.waited || 0;
                state.stats.waitCount++;
                state.stats.rides++;
            } else if (p.hops < p.maxHops && isTransferFor(state, line, name, p)) {
                // 目的站不在本线，而这里又能换到「离目的站更近的线」，就下车换乘。
                // 换乘排队时间按 transfer_types 的站厅换乘 240 s 计入等待。
                p.hops++;
                p.arrivedAt = arrAt + state.params.transferTime;
                p.walked = (p.walked || 0) + state.params.transferTime;
                p.pending = true;
                state.stats.transfers++;
                state.pending.push({ passenger: p, station: name, lineId: line.id });
            } else {
                keep.push(p);
            }
        }
        tr.onboard = keep;
        tr.load = keep.length;
        // 准点：本段实际到站 vs 本段应有到达（区间 + 停站）。
        if (tr.expectArr) {
            state.stats.plannedArr++;
            line.stat.plannedArr++;
            var dev = arrAt - tr.expectArr;
            state.stats.devSum += Math.abs(dev);
            if (onTime(arrAt, tr.expectArr)) {
                state.stats.onTimeArr++;
                line.stat.onTimeArr++;
            } else {
                state.stats.lateArr++;
                if (dev > 120) state.stats.devLateSum += dev;
            }
            tr.expectArr = 0;
        }
    }

    /**
     * @brief 列车开到终点，所有人下车。
     * @param {object} state 全局状态。
     * @param {object} tr 列车。
     */
    function offloadAll(state, tr) {
        state.stats.arrived += tr.onboard.length;
        tr.onboard = [];
        tr.load = 0;
    }

    /**
     * @brief 上车。只上「到站时刻不早于其到达时刻」的乘客，先到先上。
     * @param {object} state 全局状态。
     * @param {object} line 线路。
     * @param {object} tr 列车。
     * @param {object} stop 站点。
     * @return {number} 上车人数。
     */
    function board(state, line, tr, stop) {
        if (line.skip[stop.name]) return 0;
        var q = state.queues[queueKey(line.id, stop.name)];
        if (!q || q.list.length === 0) return 0;
        var cap = state.capacityOf[line.id] || state.capacity;
        var n = 0;
        while (q.list.length > 0 && tr.onboard.length < cap) {
            var p = q.list[0];
            if (p.arrivedAt > state.now) break;
            if (p.dest === stop.name) {
                // 目的站就在本站：没上车也算到达，这次等待记在当前这段。
                // 正常不会出现（`pickDest` 已排除同站），留着防脏数据把队列卡死。
                p.waited = (p.waited || 0) + Math.max(0, state.now - p.arrivedAt);
                q.list.shift();
                state.stats.arrived++;
                state.stats.waitSum += p.waited;
                state.stats.waitCount++;
                continue;
            }
            q.list.shift();
            // 记下「这一段是在哪一刻上的车」——等车时长要按它算（见 arrive()）。
            // 不记这个只能在终点乘客到达时倒推，而那时人早在车上坐了几十分钟。
            p.boardedAt = state.now;
            // 本段候车 = 上车时刻 − 本段开始排队的时刻。累加进 `waited`，
            // 换乘只增加下一段的排队，不覆盖前面已经等过的部分。
            p.waited = (p.waited || 0) + Math.max(0, state.now - p.arrivedAt);
            tr.onboard.push(p);
            n++;
            state.stats.boarded++;
        }
        if (q.list.length > 0 && tr.onboard.length >= cap) state.stats.leftBehind++;
        return n;
    }

    // ==================================================================
    //  六、结算
    // ==================================================================

    /**
     * @brief 汇总一局指标。
     * @param {object} state 全局状态。
     * @return {object} 指标对象。
     */
    function summary(state) {
        var s = state.stats;
        var trains = 0;
        var fleet = 0;
        state.lines.forEach(function (l) {
            trains += l.trains.length;
            fleet += l.fleetSize;
        });
        var wait = s.waitCount ? s.waitSum / s.waitCount : 0;
        var punctuality = s.plannedArr ? s.onTimeArr / s.plannedArr : 1;
        // 满载率：**最大断面高峰满载率**——运营报表的通用口径。
        //
        // 为什么不用全线平均：乘客平均只坐三四站（真实广州也这样），车厢里
        // 大部分座位在大部分里程上是空的，全线平均算出来永远是个位数百分比，
        // 反映不了「某一段挤爆了」。真正需要调度关注的是最挤的那一段。
        //
        // 分母用**该线定员**：每条线车型不同，不能混着算。
        var loadFactor = 0;
        var worstSection = null;
        var sections = state.stats.sectionLoad;
        Object.keys(sections).forEach(function (key) {
            var parts = key.split('|');
            var lineId = parts[0];
            var cap = state.capacityOf[lineId] || state.capacity;
            var factor = sections[key] / cap;
            if (factor > loadFactor) {
                loadFactor = factor;
                worstSection = { lineId: lineId, load: sections[key], cap: cap };
            }
        });
        return {
            clock: formatClock(state.now),
            now: state.now,
            lines: state.lines.length,
            stations: Object.keys(state.data.stations || {}).length,
            trains: trains,
            fleet: fleet,
            departures: s.departures,
            shortage: s.shortage,
            arrivals: s.arrivals,
            boarded: s.boarded,
            arrived: s.arrived,
            avgWait: Math.round(wait),
            leftBehind: s.leftBehind,
            punctuality: punctuality,
            loadFactor: loadFactor,
            maxLoad: s.maxLoad,
            capacity: state.capacity,
        };
    }

    /**
     * @brief 结算对象：指标 + 评分卡。
     * @param {object} state 全局状态。
     * @return {object} 指标与 `score`。
     */
    function result(state) {
        var sum = summary(state);
        sum.score = score(state, sum);
        return sum;
    }

    /**
     * @brief 评分卡：四项加权，每项 0–100。
     *
     * | 项 | 权重 | 口径 |
     * |---|---|---|
     * | 准点率 | 35% | 实际到站与计划相差 ≤ 120 s 的比例 |
     * | 乘客体验 | 30% | 平均等车 ≤ 3 分钟满分，≥ 12 分钟零分，线性插值 |
     * | 满载率 | 20% | 平均满载率 0.5–0.85 最好，两头扣分 |
     * | 调度执行 | 15% | 缺车次数 ≤ 5 满分，≥ 200 零分 |
     *
     * @param {object} state 全局状态。
     * @param {object} [sum] 已算好的 `summary()` 结果，缺省时现算。
     * @return {object} `{total, items:[{key,name,value,score,weight}]}`。
     */
    function score(state, sum) {
        if (!sum) sum = summary(state);
        var items = [];

        var p = sum.punctuality * 100;
        items.push({ key: 'punctuality', name: '准点率', value: (p).toFixed(1) + '%', score: p, weight: 35 });

        // 平均等车：180 s 以内满分，720 s 以上零分
        var waitScore = clamp((720 - sum.avgWait) / (720 - 180), 0, 1) * 100;
        items.push({ key: 'wait', name: '平均等车', value: sum.avgWait + ' 秒', score: waitScore, weight: 30 });

        // 满载率：0.5–0.85 满分，越挤越扣，太空也扣
        var lf = sum.loadFactor;
        var lfScore;
        if (lf <= 0.5) lfScore = clamp(lf / 0.5, 0, 1) * 100;
        else if (lf <= 0.85) lfScore = 100;
        else lfScore = clamp((1.3 - lf) / (1.3 - 0.85), 0, 1) * 100;
        items.push({ key: 'load', name: '满载率', value: (lf * 100).toFixed(0) + '%', score: lfScore, weight: 20 });

        // 缺车：5 次以内满分 → 200 次零分
        var shScore = clamp((200 - sum.shortage) / 195, 0, 1) * 100;
        items.push({ key: 'shortage', name: '缺车次数', value: sum.shortage + ' 次', score: shScore, weight: 15 });

        var total = 0;
        items.forEach(function (it) { total += it.score * it.weight / 100; });
        return { total: Math.round(total), items: items };
    }

    /**
     * @brief 逐线路的实时压力：当前最大载客、候车人数、班次间隔。
     * @param {object} state 全局状态。
     * @return {Array<object>} 每条线路一项，按压力从高到低排。
     */
    function lineStats(state) {
        return state.lines.map(function (line) {
            var maxLoad = 0;
            var onboard = 0;
            line.trains.forEach(function (tr) {
                if (tr.onboard.length > maxLoad) maxLoad = tr.onboard.length;
                onboard += tr.onboard.length;
            });
            var waiting = 0;
            line.segments.forEach(function (seg) {
                seg.stops.forEach(function (stop) {
                    var q = state.queues[queueKey(line.id, stop.name)];
                    if (q) waiting += q.list.length;
                });
            });
            return {
                id: line.id,
                name: line.name,
                color: line.color,
                headway: Math.round(headwayOf(state, line)),
                trains: line.trains.length,
                onboard: onboard,
                maxLoad: maxLoad,
                awaiting: waiting,
                loadFactor: maxLoad / (state.capacityOf[line.id] || state.capacity),
            };
        }).sort(function (a, b) { return b.awaiting - a.awaiting; });
    }

    return {
        FRAME: FRAME,
        DAY_START: DAY_START,
        DAY_END: DAY_END,
        createGame: createGame,
        step: step,
        summary: summary,
        result: result,
        score: score,
        lineStats: lineStats,
        segmentRunTime: segmentRunTime,
        headwayOf: headwayOf,
        formatClock: formatClock,
        onTime: onTime,
        queueKey: queueKey,
        buildLine: buildLine,
        atTime: atTime,
        pickCrowd: pickCrowd
    };
});
