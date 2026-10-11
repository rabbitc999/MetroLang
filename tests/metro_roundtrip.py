#!/usr/bin/env python3
"""真实城市样例回归：`compile → decompile → compile` 幂等。

对 `samples/` 下每份 `.m` / `.metro` 线路数据：
  1. `metro-lang compile <src> -o <tmp>/first.json`
  2. `metro-lang decompile <tmp>/first.json -o <tmp>/roundtrip.metro`
  3. `metro-lang compile <tmp>/roundtrip.metro -o <tmp>/second.json`
  4. 比对两份 JSON 必须逐字节一致（幂等）。

用法：
    python3 tests/metro_roundtrip.py --bin build/metro-lang/metro-lang
    python3 tests/metro_roundtrip.py --bin ... --samples samples --tmp build/ci/roundtrip

退出码：0 全绿；1 有样例不幂等；2 环境不满足。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


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


def main() -> int:
    parser = argparse.ArgumentParser(description="MetroLang 样例幂等回归")
    parser.add_argument("--bin", required=True, help="metro-lang 可执行文件")
    parser.add_argument("--samples", default="samples", help="样例目录（默认 samples）")
    parser.add_argument("--tmp", default="build/ci/roundtrip", help="中间产物目录")
    args = parser.parse_args()

    binary = bin_path(args.bin)
    if not binary.exists():
        print(f"找不到 metro-lang：{binary}（先跑 make）", file=sys.stderr)
        return 2

    samples_dir = Path(args.samples)
    tmp_dir = Path(args.tmp)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    sources = sorted(samples_dir.glob("*.m")) + sorted(samples_dir.glob("*.metro"))
    if not sources:
        print(f"样例目录没有 .m / .metro 文件：{samples_dir}", file=sys.stderr)
        return 2

    failed = 0
    for src in sources:
        name = src.stem
        first = tmp_dir / f"{name}.first.json"
        rt = tmp_dir / f"{name}.roundtrip.metro"
        second = tmp_dir / f"{name}.second.json"

        compile1 = run(binary, ["compile", str(src), "-o", str(first)])
        if compile1.returncode != 0:
            print(f"[FAIL] {name}：compile 失败\n       {compile1.stderr.strip()}")
            failed += 1
            continue

        decompile = run(binary, ["decompile", str(first), "-o", str(rt)])
        if decompile.returncode != 0:
            print(f"[FAIL] {name}：decompile 失败\n       {decompile.stderr.strip()}")
            failed += 1
            continue

        compile2 = run(binary, ["compile", str(rt), "-o", str(second)])
        if compile2.returncode != 0:
            print(f"[FAIL] {name}：回环 compile 失败\n       {compile2.stderr.strip()}")
            failed += 1
            continue

        if first.read_bytes() != second.read_bytes():
            print(f"[FAIL] {name}：compile → decompile → compile 不幂等")
            failed += 1
            continue

        print(f"[ok]   {name}")

    print()
    if failed == 0:
        print(f"全部通过（{len(sources)} 份样例幂等）")
        return 0
    print(f"有 {failed} 份样例失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
