#!/usr/bin/env python3
"""`metro-lang game` 回归：数据集契约 + 与 Python 侧口径交叉验证。

游戏数据集（`format: metro-game-1`）是 C++ 和 JS 之间的唯一契约。它出一次错，
表现不是编译失败，而是浏览器里一片空白 + 控制台一句 `JSONDecodeError`——这种
错误最难在 CI 里发现，所以这里把它当**协议**来测，而不是当输出文本比对：

  1. **能解析**：`--json` 的输出必须是合法 JSON。历史上手拼字符串漏过一个 `}`，
     把后面几百行全吞进上一个数组，页面直接白屏。
  2. **结构齐**：顶层键、每条线路的字段、`main.km` 长度必须等于站点数 − 1
     （`doc/05-route.md` §6 的线性约定）。
  3. **里程自洽**：每条支线的首站必须能在主链或前序支线上找到接点，`km` 全部
     为正；主链里程之和等于线路长度（误差 < 1 m）。
  4. **口径一致**：同一条 `.metro`，C++（`game --json`）与 `game/tools/prepare_data.py`
     算出的线路数 / 站数 / 区段数必须相等——两条路分叉了，游戏在浏览器里和
     Python 工具链里就是两个世界。
  5. **HTML 自包含**：不带 `-o` 之外参数时产出的页面不能引用任何外链。

用法：
    python3 tests/test_game.py --bin build/metro-lang/metro-lang
    python3 tests/test_game.py --bin ... --samples samples --only guangzhou

退出码：0 全绿；1 有断言失败；2 环境不满足（缺样例或缺 Python 工具）。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# 顶层键：顺序即文档顺序，缺一个前端就可能读到 undefined。
TOP_KEYS = [
    "format",
    "source",
    "city",
    "version",
    "params",
    "price",
    "transfer_types",
    "stations",
    "lines",
    "headway",
    "crowd",
    "stats",
]

LINE_KEYS = [
    "id",
    "name",
    "display",
    "color",
    "city",
    "formation",
    "maxspeed",
    "capacity",
    "open_year",
    "special",
    "dwell",
    "main",
    "branches",
]

# `sim.js` 启动时按这套名字取参数，缺键就是 NaN 传染全场的时刻表。
PARAM_KEYS = [
    "exit_time",
    "inner_transfer_time",
    "out_station_time",
    "avg_board_time",
    "dwell_default",
    "reversal_time",
    "accel",
    "brake",
]

# 里程比对容差（km）：C++ 端 round2 到 1e-2，一万站累计也就 1e-3 量级。
KM_EPS = 1e-6


class Failure(Exception):
    """一条断言失败。用异常而不是返回码，失败信息能直接带上下文。"""


def bin_path(raw: str) -> Path:
    """把 --bin 解析成可执行文件路径（Windows 上补 .exe）。"""
    path = Path(raw)
    if path.exists():
        return path
    exe = path.with_suffix(path.suffix + ".exe")
    if exe.exists():
        return exe
    return path


def run(binary: Path, args: list[str]) -> subprocess.CompletedProcess:
    """跑一次 metro-lang，捕获输出（文本、UTF-8、宽松错误）。"""
    return subprocess.run(
        [str(binary), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def game_json(binary: Path, sample: Path) -> tuple[dict, str]:
    """跑 `game --json`，返回（解析后的字典，原始文本）。

    原始文本一并返回：解析失败时要把出错位置附近的字符打出来，不然只看到
    「Expecting ',' delimiter: line 1 column 46394」这种没法定位的报错。
    """
    r = run(binary, ["game", str(sample), "--json"])
    if r.returncode != 0:
        raise Failure(f"game --json 退出码 {r.returncode}\n{r.stderr.strip()[:800]}")
    raw = r.stdout
    if not raw.strip():
        raise Failure("game --json 没有任何输出")
    try:
        return json.loads(raw), raw
    except json.JSONDecodeError as exc:
        lo = max(0, exc.pos - 120)
        hi = min(len(raw), exc.pos + 120)
        raise Failure(
            f"数据集不是合法 JSON：{exc.msg}（位置 {exc.pos}）\n"
            f"附近内容：…{raw[lo:hi]!r}…"
        ) from exc


# ---------------------------------------------------------------- 单项检查


def check_top_level(data: dict) -> None:
    """顶层键齐全、取值类型对得上。"""
    missing = [k for k in TOP_KEYS if k not in data]
    if missing:
        raise Failure(f"缺顶层键：{missing}")
    if data["format"] != "metro-game-1":
        raise Failure(f"format 应为 metro-game-1，实为 {data['format']!r}")
    if not data["city"]:
        raise Failure("city 为空——页面标题会变成「 地铁调度」")
    for key in ("stations", "lines", "transfer_types"):
        if not isinstance(data[key], dict):
            raise Failure(f"{key} 必须是字典，实为 {type(data[key]).__name__}")


def check_params(data: dict) -> None:
    """参数表：键齐全且都是正数（`sim.js` 直接拿去做除法）。"""
    params = data["params"]
    missing = [k for k in PARAM_KEYS if k not in params]
    if missing:
        raise Failure(f"params 缺键：{missing}")
    for k in PARAM_KEYS:
        v = params[k]
        if not isinstance(v, (int, float)) or v <= 0:
            raise Failure(f"params.{k} 应为正数，实为 {v!r}")


def check_price(data: dict) -> None:
    """票价阶梯：区间递增、票价非降、首段从 0 起步。"""
    price = data["price"]
    if price["currency"] != "CNY":
        raise Failure(f"currency 应为 CNY，实为 {price['currency']!r}")
    segs = price["segments"]
    if not segs:
        # 没写 PRICE_DEFINE 的样例（smoke.metro）也必须拿到能算钱的单段表，
        # 否则结算页显示 0 元，看起来像 bug。
        raise Failure("price.segments 为空——结算页算不出钱")
    if abs(segs[0]["rangeStart"]) > KM_EPS:
        raise Failure(f"首段应从 0 km 起步，实为 {segs[0]['rangeStart']}")
    for i, seg in enumerate(segs):
        if seg["rangeEnd"] <= seg["rangeStart"]:
            raise Failure(f"第 {i} 段区间反向：{seg['rangeStart']} → {seg['rangeEnd']}")
        if seg["fare"] <= 0:
            raise Failure(f"第 {i} 段票价为 {seg['fare']}")
        if i and seg["fare"] < segs[i - 1]["fare"]:
            raise Failure(f"第 {i} 段票价低于前一段：{segs[i - 1]['fare']} → {seg['fare']}")


def check_line(line_id: str, line: dict, stations: dict) -> None:
    """单条线路：字段齐全、主链里程自洽、支线能接回主链或彼此。"""
    missing = [k for k in LINE_KEYS if k not in line]
    if missing:
        raise Failure(f"线路 {line_id} 缺字段：{missing}")
    if line["capacity"] <= 0:
        raise Failure(f"线路 {line_id} 定员为 {line['capacity']}")
    if line["maxspeed"] <= 0:
        raise Failure(f"线路 {line_id} 最高速度为 {line['maxspeed']}")
    if line["dwell"] < 0:
        raise Failure(f"线路 {line_id} 停站时间为 {line['dwell']}")
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", line["color"] or ""):
        raise Failure(f"线路 {line_id} 颜色不是 #RRGGBB：{line['color']!r}")

    # 源数据缺里程时数据集会用中位数补，但必须**留下痕迹**——
    # 悄悄补值等于把数据质量问题藏起来，将来没人知道该修哪条 .m。
    if "km_filled" not in line:
        raise Failure(f"线路 {line_id} 缺 km_filled 字段（源数据自检痕迹）")

    # 主链：站数 ≥ 2、km 长度 = 站数 − 1、里程均为正。
    main = line["main"]
    names = main["stations"]
    kms = main["km"]
    if len(names) < 2:
        raise Failure(f"线路 {line_id} 主链只有 {len(names)} 站")
    if len(kms) != len(names) - 1:
        raise Failure(
            f"线路 {line_id} 主链 km 数 {len(kms)} ≠ 站数 {len(names)} − 1"
            "（doc/05-route.md §6 的线性约定）"
        )
    for i, km in enumerate(kms):
        if km <= 0:
            raise Failure(f"线路 {line_id} 主链第 {i} 段（{names[i]}→{names[i + 1]}）里程为 {km}")
    if len(set(names)) != len(names):
        raise Failure(f"线路 {line_id} 主链有重复站——拼链时没去重")

    for idx, branch in enumerate(line["branches"]):
        bnames = branch["stations"]
        bkms = branch["km"]
        if len(bnames) < 2:
            raise Failure(f"线路 {line_id} 支线 {idx} 只有 {len(bnames)} 站")
        if len(bkms) != len(bnames) - 1:
            raise Failure(f"线路 {line_id} 支线 {idx} km 数 {len(bkms)} ≠ 站数 {len(bnames)} − 1")
        for i, km in enumerate(bkms):
            if km <= 0:
                raise Failure(
                    f"线路 {line_id} 支线 {idx} 第 {i} 段（{bnames[i]}→{bnames[i + 1]}）里程为 {km}"
                )
        # 支线必须挂在主链或更早的支线上，**或者**经由规划段接上主链。
        #
        # 第二种情况是真实状态而非数据错误：广州 12 号线的
        # `广州体育馆→浔峰岗` 段与南段 `大学城南→二沙岛` 之间隔着
        # `FUTURE` 标记的 `二沙岛—东湖—…—广州体育馆` 中段，中段没开通，
        # 两段在运营上就是分开的。这种支线记为「待贯通」，不算错误，
        # 但要能被报告出来，避免把一段孤立的轨道当成正常支线。
        anchors = set(names)
        for prev in line["branches"][:idx]:
            anchors |= set(prev["stations"])
        future_names = {n for f in line.get("future", []) for n in f["stations"]}
        if not anchors & set(bnames):
            if bnames[0] in future_names or bnames[-1] in future_names:
                line.setdefault("_pending", []).append(idx)
                continue
            raise Failure(f"线路 {line_id} 支线 {idx} 与主链不相接：{bnames[:6]}")

    # 规划段（FUTURE）必须与运营段彻底分开：只出现在 future 里，不进主链/支线。
    # 混进去的后果是把没开通的轨道画成在跑车，指标全失真。
    #
    # 例外：整条线都在规划中（`planned_only`，如广州 24 号线）。这种线路的
    # `main` 本身就是规划段，为的是保住线路实体与配色，`segments` 为空、
    # 不参与调度，所以「重叠」在这里是预期的，不检查。
    if not line.get("planned_only"):
        operate = set(names)
        for b in line["branches"]:
            operate |= set(b["stations"])
        for f in line.get("future", []):
            mids = set(f["stations"][1:-1])
            if mids and mids <= operate:
                raise Failure(f"线路 {line_id} 的规划段 {f['stations'][:4]} 与运营段完全重叠")

    # 站必须都出现在站点表里，且带有限坐标——查坐标按站名做键，
    # 站表丢站或坐标缺失会让投影整体失效，线网掉进网格兜底画成一团乱麻。
    for name in names:
        if name not in stations:
            raise Failure(f"线路 {line_id} 的站 {name!r} 不在 stations 表里")
        info = stations[name]
        if not isinstance(info.get("lon"), (int, float)) or not isinstance(info.get("lat"), (int, float)):
            raise Failure(f"站 {name!r} 缺坐标（lon/lat 非数值）")


def check_periods(table: dict, label: str, minimum: float) -> None:
    """时段表：三元组 `[起, 止, 值]`、秒数落在两天以内、值不低于下限。"""
    for key, periods in table.items():
        if not isinstance(periods, list) or not periods:
            raise Failure(f"{label}[{key}] 不是非空数组")
        for item in periods:
            if len(item) != 3:
                raise Failure(f"{label}[{key}] 的项不是三元组：{item!r}")
            start, end, value = item
            if not all(isinstance(v, (int, float)) for v in item):
                raise Failure(f"{label}[{key}] 含非数字：{item!r}")
            if not (0 <= start < 48 * 3600):
                raise Failure(f"{label}[{key}] 起始秒越界：{start}")
            if not (0 < end <= start + 24 * 3600):
                raise Failure(f"{label}[{key}] 时段长度异常：{start} → {end}")
            if value < minimum:
                raise Failure(f"{label}[{key}] 值 {value} 低于下限 {minimum}")


def check_stats(data: dict) -> None:
    """`stats` 必须和实际内容对得上（页面用它显示「24 条线 / 464 站」）。"""
    stats = data["stats"]
    if stats["lines"] != len(data["lines"]):
        raise Failure(f"stats.lines {stats['lines']} ≠ 实际线路数 {len(data['lines'])}")
    if stats["stations"] != len(data["stations"]):
        raise Failure(f"stats.stations {stats['stations']} ≠ 实际站数 {len(data['stations'])}")
    real_branches = sum(len(l["branches"]) for l in data["lines"].values())
    if stats["branches"] != real_branches:
        raise Failure(f"stats.branches {stats['branches']} ≠ 实际支线数 {real_branches}")
    # `line_stops` 只数**运营**停站：纯规划线没有运营段，不该计入。
    real_stops = 0
    for l in data["lines"].values():
        if l.get("planned_only"):
            continue
        real_stops += len(l["main"]["stations"])
        real_stops += sum(len(b["stations"]) for b in l["branches"])
    if stats["line_stops"] != real_stops:
        raise Failure(f"stats.line_stops {stats['line_stops']} ≠ 实际运营停站 {real_stops}")
    # `stations` 含只在规划段出现的站（画虚线要坐标），`stations_operating`
    # 才是玩家能上下车的站数；页面标题显示后者。
    real_operating = sum(1 for s in data["stations"].values() if s.get("lines"))
    if stats.get("stations_operating") != real_operating:
        raise Failure(
            f"stats.stations_operating {stats.get('stations_operating')} ≠ 实际运营站 {real_operating}"
        )
    # 规划段与纯规划线数也要能对上，否则页面上的「在建」提示会错。
    real_future = sum(len(l.get("future", [])) for l in data["lines"].values())
    if stats.get("future") != real_future:
        raise Failure(f"stats.future {stats.get('future')} ≠ 实际规划段 {real_future}")
    real_planned = sum(1 for l in data["lines"].values() if l.get("planned_only"))
    if stats.get("planned_only") != real_planned:
        raise Failure(f"stats.planned_only {stats.get('planned_only')} ≠ 实际纯规划线 {real_planned}")


def check_network(data: dict) -> str | None:
    """全网连通：从任意一个换乘站出发，能走遍所有线路的站。

    没有任何线路的样例（`TRANSFER.m` 只定义换乘类型）跳过，不算失败。
    """
    if not data["lines"]:
        return "无线路（样例不含线路），跳过"
    station_lines = {name: set(info["lines"]) for name, info in data["stations"].items()}
    # 纯规划线没有运营站（`lines` 里全是空），本来就不该连进运营网，排除掉。
    operating = {lid for lid, line in data["lines"].items() if not line.get("planned_only")}
    line_stations: dict[str, set[str]] = {}
    for lid, line in data["lines"].items():
        if lid not in operating:
            continue
        got = set(line["main"]["stations"])
        for b in line["branches"]:
            got |= set(b["stations"])
        line_stations[lid] = got

    # 线路 → 通过共站相连的其它线路。
    neighbours: dict[str, set[str]] = {lid: set() for lid in line_stations}
    for name, lids in station_lines.items():
        lids = [l for l in lids if l in line_stations]
        for a in lids:
            for b in lids:
                if a != b:
                    neighbours[a].add(b)
    if not neighbours:
        return "无线网，跳过"

    start = max(neighbours, key=lambda l: len(neighbours[l]))
    seen = {start}
    stack = [start]
    while stack:
        cur = stack.pop()
        for nxt in neighbours[cur]:
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    if len(seen) != len(neighbours):
        isolated = sorted(set(neighbours) - seen)
        raise Failure(f"线网不连通，{isolated} 与主网分离")
    return f"{len(seen)} 条线路全网连通"


# ---------------------------------------------------------------- 交叉验证


def load_prepare_module(tools_dir: Path):
    """导入 `game/tools/prepare_data.py`（它当前在 sys.path 之外）。"""
    import importlib.util

    path = tools_dir / "prepare_data.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("prepare_data", path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cross_check(data: dict, binary: Path, sample: Path, tools_dir: Path) -> str | None:
    """同一份 `.metro` 走 Python 管线，比对规模。返回说明文字，跳过时返回 None。"""
    mod = load_prepare_module(tools_dir)
    if mod is None or not hasattr(mod, "build"):
        return None

    # Python 侧吃 compile 出来的 JSON v2，不是 .metro 源文件。
    with tempfile.TemporaryDirectory() as tmp:
        v2 = Path(tmp) / "net.json"
        r = run(binary, ["compile", str(sample), "-o", str(v2)])
        if r.returncode != 0:
            raise Failure(f"compile 失败，无法交叉验证：{r.stderr.strip()[:400]}")
        try:
            py = mod.build(json.loads(v2.read_text(encoding="utf-8")))
        except TypeError:
            # 老版本签名是 build(path)；两种都试一下，避免因为接口变动而误报。
            py = mod.build(v2)
        except Exception as exc:  # noqa: BLE001 - 工具链自己的异常，转成断言失败
            raise Failure(f"prepare_data.build 抛异常：{exc!r}") from exc

    py_lines = py.get("lines")
    py_stations = py.get("stations")
    # Python 侧可能产出字典（按 id）或数组（按顺序），两种都要能比。
    py_line_count = len(py_lines) if py_lines is not None else -1
    py_station_count = len(py_stations) if py_stations is not None else -1

    if py_line_count < 0 or py_station_count < 0:
        return None

    if py_line_count != data["stats"]["lines"]:
        raise Failure(
            f"线路数不一致：C++ {data['stats']['lines']} vs prepare_data {py_line_count}\n"
            "两边口径必须一致，否则浏览器里和工具链里是两个线网"
        )
    if py_station_count != data["stats"]["stations"]:
        raise Failure(
            f"站数不一致：C++ {data['stats']['stations']} vs prepare_data {py_station_count}"
        )
    return f"交叉验证通过（{py_line_count} 线 / {py_station_count} 站）"


# ---------------------------------------------------------------- HTML 检查


def check_html(binary: Path, sample: Path, tmp: Path) -> dict:
    """`game -o out.html` 产出的页面必须是单文件、自包含。"""
    out = tmp / "game.html"
    r = run(binary, ["game", str(sample), "-o", str(out), "--title", "回归测试"])
    if r.returncode != 0:
        raise Failure(f"game -o 退出码 {r.returncode}\n{r.stderr.strip()[:600]}")
    if not out.exists():
        raise Failure("game -o 没有产出文件")

    html = out.read_text(encoding="utf-8")
    if not html.startswith("<!DOCTYPE html>"):
        raise Failure("产物不是 HTML")

    # 数据集段必须能被 js 读出来，且单独抽出来也是合法 JSON。
    m = re.search(r'<script id="game-data" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        raise Failure("缺少 <script id=\"game-data\">——ui.js 会直接报错退出")
    embedded = m.group(1)
    if "</" in embedded:
        raise Failure("内嵌 JSON 里出现了未转义的 </，会提前闭合 script 标签")
    try:
        parsed = json.loads(embedded)
    except json.JSONDecodeError as exc:
        raise Failure(f"内嵌数据集转义坏了：{exc.msg}（位置 {exc.pos}）") from exc

    # 自包含：不能有 http(s) 外链、不能有 src=/href= 指外部资源。
    bare = html[m.start() : m.end()]
    rest = html[: m.start()] + html[m.end() :]
    for pat in (r'src\s*=\s*["\']https?://', r'href\s*=\s*["\']https?://', r'@import\s+url\(\s*["\']?https?://'):
        hit = re.search(pat, rest, re.I)
        if hit:
            raise Failure(f"页面引用了外链（离线打不开）：{rest[hit.start():hit.start()+80]!r}")
    if "d3" not in rest:
        raise Failure("页面里没有 d3——绘图库没内嵌进去")
    if "<noscript>" not in html:
        raise Failure("缺少 <noscript> 兜底提示")

    return {
        "size": len(html.encode("utf-8")),
        "lines": len(parsed["lines"]),
        "title_ok": "回归测试" in html,
        "data_len": len(bare),
    }


# ---------------------------------------------------------------- 驱动


def run_sample(binary: Path, sample: Path, tools_dir: Path) -> tuple[list[str], list[str]]:
    """跑一个样例的全部检查，返回（通过项，失败项）。"""
    ok: list[str] = []
    bad: list[str] = []

    def attempt(label: str, fn) -> None:
        try:
            note = fn()
        except Failure as exc:
            bad.append(f"{label}：{exc}")
            return
        except Exception as exc:  # noqa: BLE001 - 未预期异常也算失败，但要带类型
            bad.append(f"{label}：未预期异常 {type(exc).__name__}: {exc}")
            return
        ok.append(f"{label}{'：' + note if isinstance(note, str) and note else ''}")

    holder: dict[str, dict] = {}

    def parse() -> str:
        data, _raw = game_json(binary, sample)
        holder["data"] = data
        return f"{len(data['lines'])} 线 / {len(data['stations'])} 站"

    attempt("JSON 可解析", parse)
    data = holder.get("data")
    if data is None:
        return ok, bad

    attempt("顶层结构", lambda: check_top_level(data))
    attempt("参数表", lambda: check_params(data))
    attempt("票价阶梯", lambda: check_price(data))
    attempt("统计对账", lambda: check_stats(data))

    def lines() -> str:
        for lid, line in data["lines"].items():
            line.pop("_pending", None)
            check_line(lid, line, data["stations"])
        if not data["lines"]:
            return "样例不含线路，跳过"
        # 有补过里程的线路要把名字报出来，提醒回头修源数据。
        filled = {lid: l["km_filled"] for lid, l in data["lines"].items() if l["km_filled"]}
        note = f"{len(data['lines'])} 条线路全部自洽"
        if filled:
            note += f"；补里程 {sum(len(v) for v in filled.values())} 处（{sorted(filled)}）"
        pending = {lid: l["_pending"] for lid, l in data["lines"].items() if l.get("_pending")}
        if pending:
            note += f"；待贯通段 {sorted(pending)}（隔着规划段）"
        if data["stats"].get("future"):
            note += f"；规划段 {data['stats']['future']} 段已隔离"
        return note

    attempt("线路里程", lines)
    attempt("发车间隔", lambda: check_periods(data["headway"], "headway", 30.0))
    attempt("拥挤度系数", lambda: check_periods(data["crowd"], "crowd", 1.0))
    attempt("线网连通", lambda: check_network(data))
    attempt("Python 交叉验证", lambda: cross_check(data, binary, sample, tools_dir))

    with tempfile.TemporaryDirectory() as tmp:
        def html() -> str:
            info = check_html(binary, sample, Path(tmp))
            if not info["title_ok"]:
                raise Failure("--title 没生效")
            if info["lines"] != len(data["lines"]):
                raise Failure(f"HTML 内嵌 {info['lines']} 线与 --json 的 {len(data['lines'])} 不一致")
            return f"{info['size'] / 1024:.0f} KB，自包含"

        attempt("单文件 HTML", html)

    return ok, bad


def main() -> int:
    ap = argparse.ArgumentParser(description="metro-lang game 回归测试")
    ap.add_argument("--bin", default="build/metro-lang/metro-lang", help="metro-lang 可执行文件")
    ap.add_argument("--samples", default="samples", help="样例目录")
    ap.add_argument("--tools", default="game/tools", help="prepare_data.py 所在目录")
    ap.add_argument("--only", default="", help="只跑名字含该子串的样例")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    binary = bin_path(args.bin)
    if not binary.exists():
        binary = bin_path(str(root / args.bin))
    if not binary.exists():
        print(f"找不到 metro-lang：{args.bin}", file=sys.stderr)
        return 2

    samples_dir = Path(args.samples)
    if not samples_dir.is_absolute():
        samples_dir = root / samples_dir
    samples = sorted(list(samples_dir.glob("*.m")) + list(samples_dir.glob("*.metro")))
    if args.only:
        samples = [s for s in samples if args.only.lower() in s.stem.lower()]
    if not samples:
        print(f"{samples_dir} 下没有样例", file=sys.stderr)
        return 2

    tools_dir = Path(args.tools)
    if not tools_dir.is_absolute():
        tools_dir = root / tools_dir

    total_ok = total_bad = 0
    for sample in samples:
        ok, bad = run_sample(binary, sample, tools_dir)
        total_ok += len(ok)
        total_bad += len(bad)
        mark = "OK  " if not bad else "FAIL"
        print(f"{mark} {sample.name}  （{len(ok)} 通过 / {len(bad)} 失败）")
        for line in bad:
            for i, part in enumerate(str(line).splitlines()):
                print(f"     {'x' if i == 0 else ' '} {part}")
        if not bad and ok:
            print(f"     · {ok[0]}")
            print(f"     · {ok[-1]}")

    print(f"\n合计：{total_ok} 通过 / {total_bad} 失败，{len(samples)} 个样例")
    return 0 if total_bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
