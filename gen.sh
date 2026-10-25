#!/bin/sh
# 重新生成本工程的解析器与模板头。
#
#   sh gen.sh
#
# 文法生成器（ParseEngine）是外部依赖，按下面顺序找（也可用 ENGINE=<路径> 指定）：
#   ./ParseEngine.exe、./ParseEngine             —— 放到本项目根目录（最省事）
#   ../ParseEngine/build/bin/ParseEngine[.exe]   —— 与 ParseEngine 仓库并排时
#   ../build/bin/ParseEngine[.exe]               —— 还住在 ParseEngine 仓库里时
# Windows 上都没找到时，自动下载最新发布版 ParseEngine.exe 到本项目根目录；
# 其它平台仍走下面的三条提示（发布版只提供 Windows 可执行文件）。
set -e
cd "$(dirname "$0")"

# 文法生成器（ParseEngine）在哪：ENGINE=<路径> 显式指定；否则先看**本项目根目录**（默认就
# 找它），再退回同级的 ParseEngine 仓库 build/bin/。生成器是外部依赖：本项目只有 .gram。
if [ -z "${ENGINE:-}" ]; then
    # 两条讲究：① 候选要写成带 `./` 的路径 —— 裸名会被 bash 当成 PATH 查找，
    # 当前目录不在 PATH 里，于是报 `ParseEngine.exe: command not found`；
    # ② Windows 上 `.exe` 排在前面 —— MSYS 的 `test -x ParseEngine` 会因 .exe 后缀假命中。
    for candidate in "./ParseEngine.exe" "./ParseEngine" \
                     "../ParseEngine/build/bin/ParseEngine.exe" "../ParseEngine/build/bin/ParseEngine" \
                     "../build/bin/ParseEngine.exe" "../build/bin/ParseEngine"; do
        if [ -x "$candidate" ]; then
            ENGINE="$candidate"
            break
        fi
    done
fi
# Windows 上没找到就地下载——与同门的 magel 工程同一套逻辑：
#   * 先落到同目录的隐藏临时文件（.ParseEngine-*.download），校验通过再 os.replace
#     换名：下载中断 / 内容不对都不会留下半个 ParseEngine.exe 让下次误判为「已存在」；
#   * 头两字节必须是 MZ（PE 可执行文件魔数）。Github 在限流或发版缺失时返回的是
#     HTML 错误页（200 + text/html），不校验就会得到一个「能执行但一跑就报错」的假生成器。
if [ -z "${ENGINE:-}" ]; then
    case "${OS:-}:$(uname -s)" in
    Windows_NT:*|*:MINGW*|*:MSYS*|*:CYGWIN*)
        echo "未找到 ParseEngine，正在下载最新发布版……"
        python - <<'PY'
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request

url = "https://github.com/rabbitc999/ParseEngine/releases/download/latest/ParseEngine.exe"
temporary = None
try:
    with tempfile.NamedTemporaryFile(prefix=".ParseEngine-", suffix=".download", dir=".", delete=False) as output:
        temporary = Path(output.name)
        with urllib.request.urlopen(url, timeout=60) as response:
            shutil.copyfileobj(response, output)
    with temporary.open("rb") as downloaded:
        if downloaded.read(2) != b"MZ":
            raise ValueError("下载内容不是 Windows 可执行文件")
    temporary.chmod(0o755)
    os.replace(temporary, "ParseEngine.exe")
except Exception as error:
    raise SystemExit("下载 ParseEngine 失败：" + str(error))
finally:
    if temporary is not None:
        temporary.unlink(missing_ok=True)
PY
        ENGINE=./ParseEngine.exe
        ;;
    esac
fi
if [ -z "${ENGINE:-}" ] || [ ! -x "$ENGINE" ]; then
    echo "找不到 ParseEngine 文法生成器（本项目只有 .gram，生成器是外部依赖）。任选一种：" >&2
    echo "  1) 从旁边的 ParseEngine 仓库构建：make -C ../ParseEngine/source -j4" >&2
    echo "     产出 ../ParseEngine/build/bin/ParseEngine[.exe]，之后本脚本会自动找到它" >&2
    echo "  2) 复制到本项目根目录：cp ../ParseEngine/build/bin/ParseEngine.exe ." >&2
    echo "     （PowerShell：Copy-Item ..\\ParseEngine\\build\\bin\\ParseEngine.exe .）" >&2
    echo "  3) 显式指路径：ENGINE=/path/to/ParseEngine.exe sh gen.sh" >&2
    exit 2
fi

echo "文法生成器：$ENGINE"

GEN=build/metro-lang/gen
mkdir -p "$GEN"

# --no-build-files：本目录的 Makefile 是手写、纳入版本管理的「生成代码 → 构建」
# 工程文件（见 Makefile），不能让生成器覆盖它，也别删它。
# 解析器源码（gen/parser.cpp 一带）照旧生成到 build/metro-lang/gen/。
"$ENGINE" metrolang.gram --lang cpp17 --out-dir "$GEN" --no-build-files

# 模板固化头（反编译模板 → C++ 源）：与 Makefile 的同一目标保持一致。
# 检测可用的 Python 3：Windows 的 `python3` 可能是应用商店占位程序（跑起来只会
# 提示"Python was not found"），所以逐个候选验一次版本，别光看能不能执行。
if [ -z "${PYTHON:-}" ]; then
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 && \
           [ "$("$candidate" -c 'import sys; print("OK" if sys.version_info.major == 3 else "")' 2>/dev/null)" = "OK" ]; then
            PYTHON="$candidate"
            break
        fi
    done
fi
if [ -z "${PYTHON:-}" ]; then
    echo "找不到可用的 Python 3，请安装 python3 或 python，或设置 PYTHON" >&2
    exit 2
fi
"$PYTHON" tools/embed_templates.py --out "$GEN/metro_templates.hpp" template/templates/*.tmpl

echo "生成完成：分析器与模板头在 $GEN"
