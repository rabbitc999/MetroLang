#!/usr/bin/env python3
"""LSP 语义能力端到端测试：hover / definition / documentSymbol / completion。

用法：
    python tests/test_lsp.py [--bin build/metro-lang/metro-lang]

测试喂给语言服务器一段 MetroLang 源码，然后在指定位置发请求，检查返回的
结构里是否包含期望的标识符类型与说明。它不依赖任何 LSP 客户端库，直接按
`Content-Length` 帧收发。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SOURCE = """PROGRAM_DEFINE
    KEY_CITY '测试市'
    AUTHOR 'tester'
END_DEFINE

OPERATION_DEFINE
    ENTRY_TIME 120
    TRANSFER_TIME 180
    DWELL_TIME 30
END_DEFINE

STATION_DEFINE
    NODE '甲站' 113.30 23.10
    NODE '乙站' 113.32 23.12
    NODE '丙站' 113.34 23.14
END_DEFINE

LINE_DEFINE T1
    NAME '一号线'
    COLOR '#FF0000'
    MAXSPEED 80
    FORMATION '6B'
    DIRECTION_DEFINE T1_0
        STATIONS '甲站' '乙站' '丙站'
    END_DEFINE
END_DEFINE

PRICE_DEFINE
    DEFAULT_FARE 2
    SEGMENT 0 6 2
    SEGMENT 6 12 3
END_DEFINE
"""


def frame(payload: dict) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


def read_frame(stream) -> dict | None:
    length = 0
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    body = stream.read(length)
    if len(body) != length:
        return None
    return json.loads(body.decode("utf-8"))


class Client:
    def __init__(self, binary: str) -> None:
        self.proc = subprocess.Popen(
            [binary, "lsp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.next_id = 1

    def send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(frame(payload))
        self.proc.stdin.flush()

    def request(self, method: str, params: dict) -> dict:
        ident = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params})
        while True:
            message = read_frame(self.proc.stdout)
            if message is None:
                raise RuntimeError(f"{method}: 服务器没有响应就关闭了")
            if message.get("id") == ident:
                return message
            # 通知（publishDiagnostics）跳过

    def notify(self, method: str, params: dict) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def close(self) -> None:
        try:
            self.request("shutdown", {})
            self.notify("exit", {})
        except Exception:
            pass
        self.proc.wait(timeout=10)


def find_position(line_text: str, needle: str, occurrence: int = 0) -> tuple[int, int]:
    """在源码里找 needle 第 occurrence 次出现的行号与列（字节）。"""
    count = 0
    for index, line in enumerate(SOURCE.splitlines()):
        start = 0
        while True:
            at = line.find(needle, start)
            if at < 0:
                break
            if count == occurrence:
                return index, len(line[:at].encode("utf-8"))
            count += 1
            start = at + 1
    raise AssertionError(f"源码里没有 {needle!r} 的第 {occurrence} 次出现")


failures: list[str] = []
checks = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if condition:
        print(f"[ok]   {name}")
    else:
        print(f"[fail] {name}" + (f"\n       {detail}" if detail else ""))
        failures.append(name)


def hover_text(client: Client, uri: str, line: int, column: int) -> str:
    response = client.request(
        "textDocument/hover",
        {"textDocument": {"uri": uri}, "position": {"line": line, "character": column}},
    )
    result = response.get("result")
    if not result:
        return ""
    return ((result.get("contents") or {}).get("value")) or ""


def main() -> int:
    # Windows 上产物带 .exe，两个都试一遍。
    candidates = [
        os.path.join(ROOT, "build", "metro-lang", "metro-lang.exe"),
        os.path.join(ROOT, "build", "metro-lang", "metro-lang"),
    ]
    binary = next((c for c in candidates if os.path.exists(c)), candidates[-1])
    if "--bin" in sys.argv:
        binary = sys.argv[sys.argv.index("--bin") + 1]
    if not os.path.exists(binary):
        print(f"找不到可执行文件：{binary}（先 make）", file=sys.stderr)
        return 2

    uri = "file:///test/语义.metro"
    client = Client(binary)
    try:
        init = client.request("initialize", {"processId": None, "rootUri": None, "capabilities": {}})
        caps = (init.get("result") or {}).get("capabilities") or {}
        check("initialize 声明 hoverProvider", bool(caps.get("hoverProvider")), str(caps))
        check("initialize 声明 definitionProvider", caps.get("definitionProvider") is True, str(caps))
        check("initialize 声明 documentSymbolProvider", caps.get("documentSymbolProvider") is True, str(caps))
        client.notify("initialized", {})
        client.notify(
            "textDocument/didOpen",
            {"textDocument": {"uri": uri, "languageId": "metrolang", "version": 1, "text": SOURCE}},
        )

        # ---- hover：线路定义 ----
        line, col = find_position("LINE_DEFINE T1", "T1")
        text = hover_text(client, uri, line, col)
        check("hover 线路：含签名 LINE_DEFINE T1", "LINE_DEFINE T1" in text, text[:200])
        check("hover 线路：含「线路」类型", "线路" in text, text[:200])
        check("hover 线路：含最高速度", "80" in text, text[:200])

        # ---- hover：车站定义 ----
        line, col = find_position("NODE '甲站'", "甲站")
        text = hover_text(client, uri, line, col)
        check("hover 车站：含站名", "甲站" in text, text[:200])
        check("hover 车站：含坐标", "113.3" in text, text[:200])

        # ---- hover：站名引用（STATIONS 行） ----
        line, col = find_position("STATIONS '甲站'", "甲站")
        text = hover_text(client, uri, line, col)
        check("hover 引用处：仍是车站", "车站" in text, text[:200])

        # ---- hover：运营参数 ----
        line, col = find_position("ENTRY_TIME 120", "ENTRY_TIME")
        text = hover_text(client, uri, line, col)
        check("hover 运营参数：含「时间」", "时间" in text, text[:200])
        check("hover 运营参数：含当前值 120", "120" in text, text[:200])

        # ---- hover：方向 ----
        line, col = find_position("DIRECTION_DEFINE T1_0", "T1_0")
        text = hover_text(client, uri, line, col)
        check("hover 方向：含方向 ID", "T1_0" in text, text[:200])

        # ---- hover：空白处返回 null ----
        response = client.request(
            "textDocument/hover",
            {"textDocument": {"uri": uri}, "position": {"line": 0, "character": 0}},
        )
        check("hover 空处返回 null", response.get("result") is None, str(response)[:200])

        # ---- definition：从引用跳到定义 ----
        line, col = find_position("STATIONS '丙站'", "丙站")
        response = client.request(
            "textDocument/definition",
            {"textDocument": {"uri": uri}, "position": {"line": line, "character": col}},
        )
        locations = response.get("result") or []
        check("definition 有结果", len(locations) > 0, str(response)[:200])
        if locations:
            defined_line = locations[0]["range"]["start"]["line"]
            expected_line, _ = find_position("NODE '丙站'", "丙站")
            check("definition 指向 NODE 定义行", defined_line == expected_line,
                  f"得到 {defined_line}，期望 {expected_line}")

        # ---- documentSymbol：块头都在大纲里 ----
        response = client.request("textDocument/documentSymbol", {"textDocument": {"uri": uri}})
        symbols = response.get("result") or []
        names = [s.get("name") for s in symbols]
        check("大纲含 T1", "T1" in names, str(names))
        check("大纲含 甲站", "甲站" in names, str(names))
        check("大纲含 ENTRY_TIME", "ENTRY_TIME" in names, str(names))

        # ---- completion ----
        response = client.request(
            "textDocument/completion",
            {"textDocument": {"uri": uri}, "position": {"line": 0, "character": 0}},
        )
        items = response.get("result") or []
        labels = [i.get("label") for i in items]
        check("补全含车站", "乙站" in labels, str(labels[:10]))
        check("补全含线路", "T1" in labels, str(labels[:10]))

        # ---- 自定义请求：metro/dataSummary ----
        response = client.request(
            "metro/dataSummary",
            {"textDocument": {"uri": uri}},
        )
        summary = response.get("result") or {}
        rows = summary.get("rows") or []
        keys = [row[0] for row in rows if isinstance(row, list) and row]
        values = dict((row[0], row[1]) for row in rows if isinstance(row, list) and len(row) > 1)
        check("dataSummary 编译成功", summary.get("ok") is True, str(summary)[:200])
        check("dataSummary 返回 14 行", len(rows) == 14, str(keys))
        check("dataSummary 含车站", "车站" in keys, str(keys))
        check("dataSummary 含线路", "线路" in keys, str(keys))
        check("dataSummary 线路计数 = 1", values.get("线路") == "1", str(values))
        check("dataSummary 车站计数 = 3", values.get("车站") == "3", str(values))

        # ---- 自定义请求：metro/route ----
        response = client.request(
            "metro/route",
            {"textDocument": {"uri": uri}, "from": "甲站", "to": "丙站"},
        )
        route = response.get("result") or {}
        check("route 找到路线", route.get("ok") is True, str(route)[:300])
        check("route 含耗时秒数", (route.get("totalSeconds") or 0) > 0, str(route)[:300])
        check("route 含换乘次数", route.get("transfers") == 0, str(route)[:300])
        check("route 含票价", (route.get("fare") or 0) > 0, str(route)[:300])
        check("route 含引导文本", len(route.get("guidance") or []) > 0, str(route)[:300])
        check("route 含线路名", any("一号线" in s for s in (route.get("lines") or [])), str(route)[:300])

        # ---- 自定义请求：route 起终点不存在时给出 ok=false + error ----
        response = client.request(
            "metro/route",
            {"textDocument": {"uri": uri}, "from": "不存在的站", "to": "丙站"},
        )
        route = response.get("result") or {}
        check("route 未知站返回 ok=false", route.get("ok") is False, str(route)[:300])
        check("route 未知站给出原因", "找不到" in (route.get("error") or ""), str(route)[:300])
    finally:
        client.close()

    print()
    if failures:
        print(f"失败 {len(failures)} / {checks} 项：")
        for name in failures:
            print(f"  - {name}")
        return 1
    print(f"LSP 语义测试全部通过（{checks} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
