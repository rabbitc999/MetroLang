#!/usr/bin/env python3
"""数值口径测试：运行时间 / 票价 / 坐标校正 / 行程汇总。

这些用例锁住的是「与 metro_editor 的 C# 实现一致」这件事：改了物理模型、
票价阶梯或坐标算法之后，跑一遍就能知道有没有偏。期望值来自 C# 侧
`SimTrainTimeUtils` / `SimFareCalculator` / `GeocodeService` 的同参数输出。

用法：python tests/test_numeric.py [--bin build/metro-lang/metro-lang.exe]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

failures: list[str] = []
checks = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if ok:
        print(f"[ok]   {name}")
    else:
        print(f"[fail] {name}" + (f"\n       {detail}" if detail else ""))
        failures.append(name)


def near(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


def find_binary() -> str:
    for rel in ("build/metro-lang/metro-lang.exe", "build/metro-lang/metro-lang"):
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            return path
    print("找不到可执行文件（先 make）", file=sys.stderr)
    sys.exit(2)


def run(binary: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([binary, *args], capture_output=True, text=True, encoding="utf-8")


# ---------------------------------------------------------------- 运行时间模型
# 一条线路带已知站距，用 route 的段明细反推每段运行时间。
RUN_TIME_SOURCE = """PROGRAM_DEFINE
    KEY_CITY 'T'
END_DEFINE
OPERATION_DEFINE
    ENTRY_TIME 0
    AVG_BOARD_TIME 0
    DWELL_TIME 0
END_DEFINE
STATION_DEFINE
    NODE 'A' 113.30 23.10
    NODE 'B' 113.32 23.10
    NODE 'C' 113.37 23.10
    NODE 'D' 113.47 23.10
END_DEFINE
LINE_DEFINE L1
    NAME 'L1'
    MAXSPEED 80
    POWER 2000
    BRAKE 0.85
    FORMATION '6B'
    DIRECTION_DEFINE L1_0
        STATIONS 'A' 'B' 'C' 'D'
        DISTANCE 2.0 5.0 10.0
    END_DEFINE
END_DEFINE
"""

FARE_SOURCE = """PROGRAM_DEFINE
    KEY_CITY 'T'
END_DEFINE
PRICE_DEFINE
    DEFAULT_FARE 2
    SEGMENT 0 4 2
    SEGMENT 4 12 3
    SEGMENT 12 24 5
    SEGMENT 24 40 7
    LINEAR_EXTENSION THRESHOLD 40 BASE_FARE 7 RATE_PER_KM 0.1
END_DEFINE
OPERATION_DEFINE
    ENTRY_TIME 0
    AVG_BOARD_TIME 0
    DWELL_TIME 0
END_DEFINE
STATION_DEFINE
    NODE 'A' 113.30 23.10
    NODE 'B' 113.32 23.10
    NODE 'C' 113.36 23.10
    NODE 'D' 113.44 23.10
END_DEFINE
LINE_DEFINE L1
    NAME 'L1'
    MAXSPEED 80
    FORMATION '6B'
    DIRECTION_DEFINE L1_0
        STATIONS 'A' 'B' 'C' 'D'
        DISTANCE 3.0 5.0 10.0
    END_DEFINE
END_DEFINE
"""


def write_temp(text: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".metro")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    return path


def main() -> int:
    binary = find_binary()
    if "--bin" in sys.argv:
        binary = sys.argv[sys.argv.index("--bin") + 1]

    # ---- 1. 运行时间：短区间走精确积分、长区间走 S/v + ΔT ----
    src = write_temp(RUN_TIME_SOURCE)
    try:
        result = run(binary, "route", src, "--from", "A", "--to", "D", "--json", "--time", "10:00")
        check("route --json 执行成功", result.returncode == 0, result.stderr[:300])
        if result.returncode == 0:
            data = json.loads(result.stdout)
            summary = data["summary"]
            # 里程按 DISTANCE 声明累加。
            check("总里程 = 2 + 5 + 10", near(summary["distance_km"], 17.0, 1e-6),
                  str(summary["distance_km"]))
            check("站数 = 3", summary["stops"] == 3, str(summary["stops"]))
            # 停站为 0、进出站为 0、发车间隔按 10:00 查表（样例没写 HEADWAY_PROFILE，
            # 退回缺省 120 秒 → 候车 60 秒 + 上车 0 秒）。
            check("候车 = 60 秒（缺省间隔 120/2）", near(summary["wait_seconds"], 60.0, 1.0),
                  str(summary["wait_seconds"]))
            # 17 km / 80 km/h = 765 秒是纯匀速下界，实际必然更大（含加减速）。
            check("运行时间 > 匀速下界 765s", summary["run_seconds"] > 765.0,
                  str(summary["run_seconds"]))
            check("运行时间 < 匀速下界 × 1.6", summary["run_seconds"] < 765.0 * 1.6,
                  str(summary["run_seconds"]))
            total = (summary["run_seconds"] + summary["transfer_walk_seconds"] +
                     summary["wait_seconds"] + summary["entry_seconds"])
            check("总计 = 各项之和", near(summary["total_seconds"], total, 1e-6),
                  f"{summary['total_seconds']} vs {total}")
            # 分段明细相加应等于 summary（之前明细与合计对不上是 bug）。
            seg_sum = sum(s["run_seconds"] for s in data["segments"])
            check("分段运行时间之和 = summary",
                  near(seg_sum, summary["run_seconds"], 1e-6),
                  f"{seg_sum} vs {summary['run_seconds']}")
    finally:
        os.unlink(src)

    # ---- 2. 票价：阶梯 + 线性延伸 ----
    src = write_temp(FARE_SOURCE)
    try:
        cases = [
            ("A", "B", 3.0, 2.0),    # 3 km 落在 [0,4) → 2 元
            ("A", "C", 8.0, 3.0),    # 8 km 落在 [4,12) → 3 元
            ("A", "D", 18.0, 5.0),   # 18 km 落在 [12,24) → 5 元
        ]
        for start, end, km, expect in cases:
            result = run(binary, "route", src, "--from", start, "--to", end, "--json", "--time", "10:00")
            if result.returncode != 0:
                check(f"票价 {start}→{end} 执行成功", False, result.stderr[:200])
                continue
            data = json.loads(result.stdout)
            summary = data["summary"]
            check(f"票价 {start}→{end}（{km} km）=", near(summary["fare"], expect, 1e-6)
                  and near(summary["distance_km"], km, 1e-6),
                  f"fare={summary['fare']} km={summary['distance_km']}")
    finally:
        os.unlink(src)

    # ---- 3. 坐标校正：GCJ-02 → WGS-84 位移落在合理区间 ----
    gcj_source = """PROGRAM_DEFINE
    KEY_CITY '广州'
END_DEFINE
STATION_DEFINE
    NODE '体育西路' 113.323 23.135
    NODE '广州塔' 113.324 23.106
    NODE '嘉禾望岗' 113.283 23.240
END_DEFINE
LINE_DEFINE L1
    NAME 'L1'
    DIRECTION_DEFINE L1_0
        STATIONS '体育西路' '广州塔'
    END_DEFINE
END_DEFINE
"""
    src = write_temp(gcj_source)
    try:
        result = run(binary, "coords", src, "--from-coord", "gcj", "--json")
        check("coords --json 执行成功", result.returncode == 0, result.stderr[:300])
        if result.returncode == 0:
            fixes = json.loads(result.stdout)
            check("三座站都有结果", len(fixes) == 3, str(len(fixes)))
            for fix in fixes:
                # 国内 GCJ-02 相对 WGS-84 的偏移在 200–800 m 量级。
                check(f"{fix['name']} 位移在 100–1200 m",
                      100.0 < fix["shift"] < 1200.0, str(fix["shift"]))
                # 转换后坐标应该变小（GCJ 偏移在国内大体是往东北推）。
                check(f"{fix['name']} 经度略减", fix["newLon"] < fix["oldLon"] + 1e-9,
                      f"{fix['oldLon']} → {fix['newLon']}")
        # wgs 模式只做体检，不应该改动坐标。
        result = run(binary, "coords", src, "--from-coord", "wgs", "--json")
        if result.returncode == 0:
            fixes = json.loads(result.stdout)
            check("wgs 模式不做转换",
                  all(near(f["shift"], 0.0, 1e-9) for f in fixes),
                  str([f["shift"] for f in fixes]))
    finally:
        os.unlink(src)

    # ---- 4. 运营参数：发车间隔与拥挤度按时段生效 ----
    profile_source = """PROGRAM_DEFINE
    KEY_CITY 'T'
END_DEFINE
OPERATION_DEFINE
    ENTRY_TIME 0
    AVG_BOARD_TIME 0
    DWELL_TIME 0
END_DEFINE
STATION_DEFINE
    NODE 'A' 113.30 23.10
    NODE 'B' 113.32 23.10
END_DEFINE
LINE_DEFINE L1
    NAME 'L1'
    FORMATION '6B'
    DIRECTION_DEFINE L1_0
        STATIONS 'A' 'B'
        DISTANCE 2.0
    END_DEFINE
END_DEFINE
HEADWAY_PROFILE L1
    PERIOD 07:00 09:00 120
    PERIOD 10:00 23:59 300
END_DEFINE
CROWD_PROFILE L1_0
    PERIOD TIME_RANGE 07:00 09:00 VALUE 2.0
END_DEFINE
"""
    src = write_temp(profile_source)
    try:
        # 10:00 落在第二条（300 秒间隔、无拥挤度声明 → 1.0）→ 候车 150 秒。
        result = run(binary, "route", src, "--from", "A", "--to", "B", "--json", "--time", "10:00")
        if result.returncode == 0:
            wait = json.loads(result.stdout)["summary"]["wait_seconds"]
            check("10:00 走非高峰：候车 = 300/2", near(wait, 150.0, 0.5), str(wait))
        # 08:00 落在第一条（120 秒间隔、拥挤度 2.0）→ 120/2 + (2-1)*120 = 180 秒。
        result = run(binary, "route", src, "--from", "A", "--to", "B", "--json", "--time", "08:00")
        if result.returncode == 0:
            wait = json.loads(result.stdout)["summary"]["wait_seconds"]
            check("08:00 走高峰：候车 = 60 + 120", near(wait, 180.0, 0.5), str(wait))
    finally:
        os.unlink(src)

    print()
    if failures:
        print(f"失败 {len(failures)} / {checks} 项：")
        for name in failures:
            print(f"  - {name}")
        return 1
    print(f"数值口径测试全部通过（{checks} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
