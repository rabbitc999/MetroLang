/**
 * @file loader.js
 * @brief 数据加载层：选解释器 → 拿 JSON → 归一化 → 交给 `js/app.js` 的 `drawMap()`。
 *
 * 绘图逻辑（`app.js`）一行未改，这个文件只负责"喂数据"，做三件事：
 *
 * 1. **选解释器位置**：页面上给一个 metro-lang 可执行文件的路径输入框，默认
 *    `../build/metro-lang/metro-lang`，改过之后记在 `localStorage` 里。
 *    拖进 `.m` / `.metro` 源码时用这个路径拼出编译命令；宿主（WebView2 /
 *    Electron）里还会直接把请求发给宿主执行，见下面的"宿主桥"。
 * 2. **读 JSON**：支持两种输入 —— `metro-lang compile` 写出的 JSON v2
 *    （`stations` 是**数组**）和地铁编辑器旧格式（`stations` 是**字典**）。
 * 3. **归一化**：把两者对齐到编辑器模型，绘图代码不需要知道来源。
 *
 * 浏览器本身不能起子进程，所以纯网页里"选解释器位置"的意义是把路径固定下来、
 * 给出可以直接粘贴到终端的命令；只有宿主窗口（`window.chrome.webview`）才能
 * 真的代跑一次解释器。
 */
(function () {
    'use strict';

    /** 数据源模式：`auto` 自动识别，其余两种强制按指定格式解读。 */
    const SCHEMA_AUTO = 'auto';
    const SCHEMA_METROLANG = 'metro-lang';
    const SCHEMA_EDITOR = 'editor';

    /** 解释器默认位置：相对 `map_view/` 的源码树构建产物。 */
    const DEFAULT_INTERPRETER = '../build/metro-lang/metro-lang';
    /** 解释器路径在 localStorage 里的键。 */
    const INTERPRETER_KEY = 'metro-lang.interpreter';

    // ==================================================================
    //  一、解释器位置
    // ==================================================================

    /**
     * @brief 当前配置的解释器路径（空则回默认值）。
     * @return {string} metro-lang 可执行文件路径。
     */
    function interpreterPath() {
        const el = document.getElementById('interpreter-path');
        const value = el && el.value ? el.value.trim() : '';
        return value || DEFAULT_INTERPRETER;
    }

    /**
     * @brief 写回解释器路径输入框，并记进 localStorage。
     * @param {string} value 路径。
     * @param {boolean} [persist] 是否落盘，默认 true。
     */
    function setInterpreterPath(value, persist) {
        const el = document.getElementById('interpreter-path');
        if (el) el.value = value || '';
        if (persist !== false) {
            try {
                window.localStorage.setItem(INTERPRETER_KEY, value || '');
            } catch (e) {
                /* 隐私模式下 localStorage 可能不可用，忽略 */
            }
        }
    }

    /** @brief 从 localStorage 恢复上次填的解释器路径。 */
    function restoreInterpreterPath() {
        let saved = '';
        try {
            saved = window.localStorage.getItem(INTERPRETER_KEY) || '';
        } catch (e) {
            saved = '';
        }
        setInterpreterPath(saved || DEFAULT_INTERPRETER, false);
    }

    /**
     * @brief 拼出把源码编成 JSON 的命令行。
     * @param {string} sourceName 源码文件名（`.m` / `.metro`）。
     * @return {string} 例如 `../build/metro-lang/metro-lang compile a.m -o a.json`。
     */
    function compileCommand(sourceName) {
        const src = sourceName || 'line.m';
        const out = src.replace(/\.(m|metro|txt)$/i, '') + '.json';
        return interpreterPath() + ' compile ' + src + ' -o ' + out;
    }

    /** @brief 宿主桥：metro_editor 的 WebView2 暴露 `window.chrome.webview`。 */
    function hostBridge() {
        return (window.chrome && window.chrome.webview) ? window.chrome.webview : null;
    }

    /**
     * @brief 请求宿主用指定解释器编译源码（纯浏览器里没有宿主，返回 false）。
     *
     * 约定：宿主收到 `{type:'metro-lang-compile', interpreter, source}` 后跑解释器，
     * 再把结果用 `{type:'metro-lang-data', json}` 发回页面（或直接调
     * `window.metroViewer.loadText`）。
     * @param {File} file 用户拖进来的源码文件。
     * @return {boolean} 是否已把请求交给宿主。
     */
    function requestHostCompile(file) {
        const host = hostBridge();
        if (!host) return false;
        const reader = new FileReader();
        reader.onload = function () {
            host.postMessage({
                type: 'metro-lang-compile',
                interpreter: interpreterPath(),
                source: file.name,
                text: String(reader.result)
            });
            setStatus('已请求宿主用「' + interpreterPath() + '」编译 ' + file.name + '…');
        };
        reader.readAsText(file, 'utf-8');
        return true;
    }

    /** @brief 把当前用得上的编译命令复制到剪贴板。 */
    function copyCompileCommand(sourceName) {
        const cmd = compileCommand(sourceName || lastSourceName || 'line.m');
        const done = function () { setStatus('已复制命令：' + cmd); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cmd).then(done, function () { setStatus('复制失败，命令：' + cmd, true); });
        } else {
            setStatus('命令：' + cmd);
        }
        return cmd;
    }

    // ==================================================================
    //  二、格式识别与归一化
    // ==================================================================

    /**
     * @brief 判断一份 JSON 用的是哪套站表布局。
     * @param {object} data 解析后的 JSON。
     * @return {string} `metro-lang`（stations 是数组）或 `editor`（stations 是字典）。
     */
    function detectSchema(data) {
        if (data && Array.isArray(data.stations)) return SCHEMA_METROLANG;
        return SCHEMA_EDITOR;
    }

    /**
     * @brief 站表数组 -> 以站名为键的字典。
     *
     * metro-lang 的站名允许跨城市重名（`doc/02` §5），字典键放不下两份，这里后出现
     * 的覆盖先出现的——与旧格式"站名即键"的语义一致，画图不受影响（路径取自方向表）。
     * @param {Array<object>} list metro-lang 的 `stations` 数组。
     * @param {string} keyCity 主城市，站点没写 `city` 时兜底。
     * @return {object} `{站名: 站点信息}`。
     */
    function indexStations(list, keyCity) {
        const out = {};
        (list || []).forEach(function (s) {
            if (!s || !s.name) return;
            out[s.name] = {
                lon: s.lon,
                lat: s.lat,
                city: s.city || keyCity || '',
                other_names: s.otherNames || s.other_names || [],
                lines: s.lines || [],
                accessibility: s.accessibility || null
            };
        });
        return out;
    }

    /**
     * @brief 线路字典：把 metro-lang 里数组化的 `formation` / `link` 拉平成字符串。
     *
     * `drawMap()` 只读 `color` / `name` / `city` / `direction`，其余字段原样带着，
     * 数组值顺手拉平，避免以后接信息面板时踩到 `[object Object]`。
     * @param {object} lines `lines` 字典。
     * @return {object} 同一批线路，`formation` / `link` 变成字符串。
     */
    function flattenLines(lines) {
        const out = {};
        Object.keys(lines || {}).forEach(function (id) {
            const ln = lines[id] || {};
            const copy = Object.assign({}, ln);
            if (Array.isArray(copy.formation)) copy.formation = copy.formation.join(' / ');
            if (Array.isArray(copy.link)) copy.link = copy.link[0] || '';
            if (Array.isArray(copy.pending) && copy.pending.length === 1) copy.pending = copy.pending[0];
            copy.direction = Array.isArray(copy.direction) ? copy.direction : [];
            out[id] = copy;
        });
        return out;
    }

    /**
     * @brief metro-lang 解析器产物（JSON v2）-> 查看器模型。
     * @param {object} data `metro-lang compile` 写出的 JSON。
     * @return {object} `{key_city, stations, lines, zones}`。
     */
    function fromMetroLang(data) {
        const keyCity = data.key_city || '';
        return {
            key_city: keyCity,
            stations: indexStations(data.stations, keyCity),
            lines: flattenLines(data.lines),
            zones: data.zones || []
        };
    }

    /**
     * @brief 地铁编辑器 JSON（旧格式）-> 查看器模型。
     *
     * 旧格式本就接近绘图模型，这里只补默认值，顺带接受 `otherNames` 写法。
     * @param {object} data 编辑器导出的 JSON。
     * @return {object} `{key_city, stations, lines, zones}`。
     */
    function fromEditor(data) {
        const keyCity = data.key_city || '';
        const stations = {};
        Object.keys(data.stations || {}).forEach(function (name) {
            const s = data.stations[name] || {};
            stations[name] = Object.assign({}, s, {
                city: s.city || keyCity,
                other_names: s.other_names || s.otherNames || [],
                lines: s.lines || []
            });
        });
        return {
            key_city: keyCity,
            stations: stations,
            lines: flattenLines(data.lines),
            zones: data.zones || []
        };
    }

    /**
     * @brief 按选定模式把 JSON 归一化；模式与数据形状不符时回落到自动识别。
     * @param {object} data 解析后的 JSON。
     * @param {string} mode `auto` / `metro-lang` / `editor`。
     * @return {{model: object, schema: string}} 归一化结果与实际使用的格式。
     */
    function normalize(data, mode) {
        const detected = detectSchema(data);
        let schema = mode === SCHEMA_AUTO ? detected : mode;
        if (schema === SCHEMA_METROLANG && !Array.isArray(data.stations)) schema = detected;
        if (schema === SCHEMA_EDITOR && Array.isArray(data.stations)) schema = detected;
        const model = schema === SCHEMA_METROLANG ? fromMetroLang(data) : fromEditor(data);
        return { model: model, schema: schema };
    }

    // ==================================================================
    //  三、载入
    // ==================================================================

    /** 最近一次拖进来的源码文件名，供"复制编译命令"用。 */
    let lastSourceName = '';

    /**
     * @brief 更新左上角状态文本。
     * @param {string} text 状态文本。
     * @param {boolean} [isError] 出错时标红。
     */
    function setStatus(text, isError) {
        const el = document.getElementById('status');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? '#c62828' : '#555';
    }

    /** @brief 当前选择的数据源模式。 */
    function currentMode() {
        const sel = document.getElementById('source-select');
        return sel ? sel.value : SCHEMA_AUTO;
    }

    /**
     * @brief 载入一份 JSON 文本并重绘地图。
     * @param {string} text JSON 文本。
     * @param {string} label 来源描述，写进状态栏。
     */
    function loadText(text, label) {
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            setStatus('JSON 解析失败：' + e.message, true);
            alert('数据解析失败: ' + e.message);
            return;
        }
        let normalized;
        try {
            normalized = normalize(data, currentMode());
        } catch (e) {
            setStatus('数据归一化失败：' + e.message, true);
            alert('数据格式不符合预期: ' + e.message);
            return;
        }
        metroData = normalized.model; // 供窗口 resize 时重绘（app.js 里声明的全局变量）
        drawMap(metroData);
        const stationCount = Object.keys(metroData.stations).length;
        const lineCount = Object.keys(metroData.lines).length;
        setStatus(
            '已载入 ' + label + '（' +
            (normalized.schema === SCHEMA_METROLANG ? 'metro-lang JSON' : '编辑器 JSON') +
            '，' + lineCount + ' 条线路 / ' + stationCount + ' 座车站）'
        );
    }

    /**
     * @brief 读一个本地文件：JSON 直接载入，`.m` / `.metro` 交给解释器。
     * @param {File} file 用户选择的文件。
     */
    function loadFile(file) {
        if (!file) return;
        const name = file.name || '';
        if (/\.(m|metro|txt)$/i.test(name)) {
            lastSourceName = name;
            if (requestHostCompile(file)) return;   // 宿主窗口：直接代跑解释器
            const cmd = compileCommand(name);
            setStatus('这是源码，先用解释器编译：' + cmd, true);
            alert('浏览器里起不了子进程，请先在终端用配置的解释器编译：\n\n  ' + cmd +
                  '\n\n（解释器位置：' + interpreterPath() + '）\n' +
                  '再把生成的 JSON 拖进来；宿主窗口里这一步会自动完成。');
            return;
        }
        const reader = new FileReader();
        reader.onload = function () {
            loadText(String(reader.result), name || '文件');
        };
        reader.onerror = function () {
            setStatus('读取文件失败', true);
        };
        reader.readAsText(file, 'utf-8');
    }

    // ==================================================================
    //  四、绑定
    // ==================================================================

    /** @brief 绑定解释器路径、文件选择、拖放与数据源切换。 */
    function bind() {
        restoreInterpreterPath();

        const pathInput = document.getElementById('interpreter-path');
        if (pathInput) {
            pathInput.addEventListener('change', function () {
                setInterpreterPath(pathInput.value);
                setStatus('解释器位置已切到：' + interpreterPath());
            });
        }

        // 浏览器出于安全不暴露完整路径，只有 Electron 这类宿主会给 file.path
        const pickBtn = document.getElementById('pick-interpreter');
        const pickInput = document.getElementById('interpreter-file');
        if (pickBtn && pickInput) {
            pickBtn.addEventListener('click', function () { pickInput.click(); });
            pickInput.addEventListener('change', function () {
                const f = pickInput.files && pickInput.files[0];
                if (!f) return;
                const real = f.path || f.webkitRelativePath || '';
                if (real) {
                    setInterpreterPath(real);
                    setStatus('解释器位置已切到：' + real);
                } else {
                    setInterpreterPath(f.name);
                    setStatus('浏览器只给了文件名「' + f.name + '」，完整路径请手填', true);
                }
            });
        }

        const input = document.getElementById('file-input');
        if (input) {
            input.addEventListener('change', function () {
                if (input.files && input.files[0]) loadFile(input.files[0]);
            });
        }

        const copyBtn = document.getElementById('copy-command');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                copyCompileCommand(prompt('源码文件名（.m / .metro）', lastSourceName || 'line.m') || 'line.m');
            });
        }

        const sel = document.getElementById('source-select');
        if (sel) {
            sel.addEventListener('change', function () {
                setStatus('数据源已切到' + sel.options[sel.selectedIndex].text + '，请重新选择文件');
            });
        }

        // 拖放：整页接收，免得非要点按钮
        window.addEventListener('dragover', function (e) { e.preventDefault(); });
        window.addEventListener('drop', function (e) {
            e.preventDefault();
            const dt = e.dataTransfer;
            if (dt && dt.files && dt.files[0]) loadFile(dt.files[0]);
        });

        // 宿主回包：{type:'metro-lang-data', json}
        window.addEventListener('message', function (e) {
            const msg = e.data || {};
            if (msg.type === 'metro-lang-data' && typeof msg.json === 'string') {
                loadText(msg.json, msg.source || '宿主解释器');
            } else if (msg.type === 'metro-lang-error') {
                setStatus('宿主解释器报错：' + (msg.message || '未知错误'), true);
            }
        });

        setStatus('把 metro-lang 生成的 JSON 拖进来；源码请先过解释器（默认 ' +
                  DEFAULT_INTERPRETER + '）');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    // 给宿主 / 控制台留的入口（与 map.html 的 loadMetroData 语义一致）
    window.metroViewer = {
        loadText: loadText,
        loadFile: loadFile,
        normalize: normalize,
        detectSchema: detectSchema,
        interpreterPath: interpreterPath,
        setInterpreterPath: setInterpreterPath,
        compileCommand: compileCommand,
        copyCompileCommand: copyCompileCommand
    };
})();
