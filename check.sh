#!/bin/sh
# metro-lang/check.sh —— 样例冒烟：
#   1) `check`   解析样例并打印统计（必须成功退出）；
#   2) `compile` 编译成 JSON，且 JSON 里出现关键字段；
#   3) `decompile` 把 JSON 反编译回 MetroLang，再 `compile` 一次做幂等回环；
#   4) `html`    渲染自包含地图，产出的 HTML 里含内联 SVG；
#   5) `route`   在样例上查一条最短时间路径（必须成功退出）。
#
# 用法：cd metro-lang && sh check.sh
#   （路径与中间产物都相对当前目录；可用 METRO_TMP=… 换临时目录）
#
# 可覆盖：DEMO=./build/metro-lang/metro-lang、SAMPLE=samples/demo.metro。
set -u

CHECK_TMP=${METRO_TMP:-build/check}
mkdir -p "$CHECK_TMP" 2>/dev/null || true
if [ ! -w "$CHECK_TMP" ]; then
    echo "临时目录不可写：$CHECK_TMP（用 METRO_TMP=… 换一个）" >&2
    exit 2
fi

# 注意 `./`：Git Bash / MSYS 下 `./metro-lang` 能自动找到 `metro-lang.exe`，
# 光写 `metro-lang` 会被当成 PATH 查找（找不到）。
DEMO=${DEMO:-./build/metro-lang/metro-lang}
if [ ! -x "$DEMO" ] && [ ! -x "$DEMO.exe" ]; then
    echo "找不到 $DEMO；先跑 make（生成 + 编译）" >&2
    exit 2
fi

SAMPLE=${SAMPLE:-samples/smoke.metro}
# 默认样例用 ASCII 站名（samples/smoke.metro）：中文站名在 Windows 控制台按本地
# 代码页传 argv 会被解释器按 GBK 收到，route 查站名必然失败；ASCII 站名在任何
# 平台的任何代码页下都能稳定跑通。
FROM=${FROM:-S1}
TO=${TO:-S5}

fail=0
count=0

step() { # 标题 命令...
    title=$1
    shift
    count=$((count + 1))
    if "$@" >"$CHECK_TMP/$count.out" 2>"$CHECK_TMP/$count.err"; then
        echo "[ok]   $title"
        return 0
    fi
    echo "[FAIL] $title"
    sed 's/^/       /' "$CHECK_TMP/$count.err"
    fail=1
    return 1
}

# 1) check：解析样例并打印统计。
step "check $SAMPLE" "$DEMO" check "$SAMPLE"

# 2) compile：编译成 JSON。
if step "compile $SAMPLE" "$DEMO" compile "$SAMPLE" -o "$CHECK_TMP/demo.json"; then
    if grep -q '"lines"' "$CHECK_TMP/demo.json" && grep -q '"stations"' "$CHECK_TMP/demo.json"; then
        echo "[ok]   JSON 含 lines / stations 字段"
    else
        echo "[FAIL] JSON 缺少 lines / stations 字段"
        fail=1
    fi
fi

# 3) decompile → 再 compile：幂等回环。
if step "decompile demo.json" "$DEMO" decompile "$CHECK_TMP/demo.json" -o "$CHECK_TMP/demo.roundtrip.metro"; then
    if step "compile 回环" "$DEMO" compile "$CHECK_TMP/demo.roundtrip.metro" -o "$CHECK_TMP/demo.roundtrip.json"; then
        if diff -q "$CHECK_TMP/demo.json" "$CHECK_TMP/demo.roundtrip.json" >/dev/null 2>&1; then
            echo "[ok]   compile → decompile → compile 幂等"
        else
            echo "[FAIL] 回环后 JSON 与首轮不一致"
            fail=1
        fi
    fi
fi

# 4) html：自包含地图。
if step "html $SAMPLE" "$DEMO" html "$SAMPLE" -o "$CHECK_TMP/demo.html"; then
    if grep -q '<svg' "$CHECK_TMP/demo.html"; then
        echo "[ok]   HTML 含内联 SVG"
    else
        echo "[FAIL] HTML 里没有内联 SVG"
        fail=1
    fi
fi

# 5) route：最短时间路径。
step "route $FROM → $TO" "$DEMO" route "$SAMPLE" --from "$FROM" --to "$TO"

# ---- 汇总 ----
echo
if [ "$fail" -eq 0 ]; then
    echo "全部通过（$count 项），产物在 $CHECK_TMP"
else
    echo "有检查失败，见上面的 [FAIL]"
fi
exit "$fail"
