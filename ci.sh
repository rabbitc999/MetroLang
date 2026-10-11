#!/bin/sh
# metro-lang/ci.sh —— MetroLang 的发布门禁：一条命令跑完所有"必须绿"的检查。
#
# 用法（在本目录跑）：
#   sh ci.sh                 全部
#   sh ci.sh --no-python     只编 / 跑工具链，不跑 Python 自检
#   sh ci.sh --help
#
# 环境要求：g++ / make / python3 必需；还要一份 **ParseEngine 文法生成器**
# （本项目只有 .gram，生成器是外部依赖）：用 ENGINE=<路径> 指定，或让它待在
# 项目根目录 / 旁边的 ParseEngine 仓库 build/bin/；不在就报错退出 2。
#
# 退出码：0 全绿；1 有检查失败；2 环境不满足。

set -u
export METRO_LANG=zh

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
cd "$root" || exit 2

run_python=1
for arg in "$@"; do
    case "$arg" in
    --no-python) run_python=0 ;;
    -h | --help)
        awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
        exit 0
        ;;
    *)
        echo "未知参数：$arg（用 --help 看用法）" >&2
        exit 2
        ;;
    esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# make 的名字按平台挑：Windows 的 MinGW / MSYS 常常只装了 `mingw32-make`。
MAKE=''
for candidate in make mingw32-make; do
    if have "$candidate"; then MAKE="$candidate"; break; fi
done

echo "== 环境检测 =="
missing=''
if [ -n "$MAKE" ]; then
    printf '  %-8s %s\n' make "$(command -v "$MAKE")"
else
    printf '  %-8s 缺失（必需）\n' make
    missing="$missing make"
fi
for tool in g++; do
    if have "$tool"; then
        printf '  %-8s %s\n' "$tool" "$(command -v "$tool")"
    else
        printf '  %-8s 缺失（必需）\n' "$tool"
        missing="$missing $tool"
    fi
done
PYTHON=''
for candidate in python3 python; do
    if have "$candidate" && [ "$("$candidate" -c 'import sys; print("METRO-PYTHON-OK" if sys.version_info.major == 3 else "too-old")' 2>/dev/null)" = "METRO-PYTHON-OK" ]; then PYTHON="$candidate"; break; fi
done
if [ -n "$PYTHON" ]; then
    printf '  %-8s %s\n' python "$(command -v "$PYTHON")"
else
    printf '  %-8s 缺失（必需）\n' python
    missing="$missing python"
fi
# 文法生成器是外部依赖：本项目只有 .gram，生成器由 ParseEngine 仓库产出。
ENGINE=${ENGINE:-}
if [ -z "$ENGINE" ]; then
    for candidate in "./ParseEngine.exe" "./ParseEngine" \
                     "../ParseEngine/build/bin/ParseEngine.exe" "../ParseEngine/build/bin/ParseEngine" \
                     "../build/bin/ParseEngine.exe" "../build/bin/ParseEngine"; do
        if [ -x "$candidate" ]; then ENGINE="$candidate"; break; fi
    done
fi
if [ -n "$ENGINE" ] && [ -x "$ENGINE" ]; then
    printf '  %-8s %s\n' engine "$ENGINE"
else
    printf '  %-8s 缺失（必需）：用 ENGINE=<路径> 指一份 ParseEngine 生成器\n' engine
    missing="$missing ParseEngine"
fi
if [ -n "$missing" ]; then
    echo
    echo "缺少必需工具：$missing —— 装好再跑。" >&2
    exit 2
fi

step=0
failed=''
run_step() { # 标题 命令...
    title=$1
    shift
    step=$((step + 1))
    printf '\n[%2d] %s ... ' "$step" "$title"
    started=$(date +%s)
    if "$@" >"build/ci/logs/$(printf '%02d' "$step").log" 2>&1; then
        echo "ok（$(($(date +%s) - started))s）"
        return 0
    fi
    echo "失败（$(($(date +%s) - started))s）"
    echo "     完整输出：build/ci/logs/$(printf '%02d' "$step").log"
    failed="$failed
  - $title"
    return 1
}

mkdir -p build/ci/logs

# ---- 1. 生成解析器 + 固化模板 + 编译工具链 ----
run_step "生成分析器与模板头（make gen）" "$MAKE" gen "ENGINE=$ENGINE"
run_step "构建 metro-lang（make）" "$MAKE" all "ENGINE=$ENGINE"

# ---- 2. 样例冒烟：编译 → JSON → 反编译 → HTML → 路线 ----
run_step "样例冒烟（check.sh）" sh check.sh

# ---- 3. Python 自检（可选）----
if [ "$run_python" = 1 ]; then
    # 7 份真实城市样例的 compile → decompile → compile 幂等回归。
    if [ -f tests/metro_roundtrip.py ]; then
        run_step "真实样例幂等回归" "$PYTHON" tests/metro_roundtrip.py --bin build/metro-lang/metro-lang
    fi
fi

# ---- 汇总 ----
echo
echo "== 汇总 =="
if [ -z "$failed" ]; then
    echo "  步骤：$step，全部通过"
    echo "  版本：$(cat VERSION 2>/dev/null || echo '（无 VERSION 文件）')"
    exit 0
fi
fail_count=$(printf '%s\n' "$failed" | grep -c '^  - ')
echo "  步骤：$step，成功 $((step - fail_count))，失败 $fail_count"
echo "  失败：$failed"
exit 1
