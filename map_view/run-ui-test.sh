#!/bin/sh
# metro-lang/map_view/run-ui-test.sh —— 跑查看器 UI 端到端测试（需要 jsdom）。
#
# jsdom 是可选依赖（纯 JS，几秒装完），没装就安静跳过，免得 `make test` 变红：
#   cd map_view && npm i jsdom
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE" || exit 2

if node -e "require('jsdom')" >/dev/null 2>&1; then
    exec node test/route_ui.js "$@"
fi

echo "[skip] 查看器 UI 测试（没装 jsdom：cd map_view && npm i jsdom）"
exit 0
