"""
通过 Clash Verge 的命名管道控制 API 测速并切换节点。

起因：本机代理吞吐从昨天的 6.4 MB/s 掉到 ~150 KB/s，测了 HF / GitHub / Google
多个目标都一样 —— 说明是当前代理节点的上游慢，不是 HuggingFace 或我的脚本。

Clash Verge 只开了命名管道控制口（\\\\.\\pipe\\verge-mihomo，配置里
external-controller-pipe），TCP 9097 没监听。但 Python 可以直接把命名管道当文件
打开，所以能走 HTTP-over-pipe 调用 mihomo 的 REST API：
    GET /proxies                     列出所有代理与分组
    GET /proxies/<name>/delay?...     测单个节点延迟
    PUT /proxies/<group>              切换分组选中的节点

用法:
  python tools\\clash_switch.py --list
  python tools\\clash_switch.py --test            # 测当前分组的全部节点
  python tools\\clash_switch.py --switch-fastest  # 切到最快的
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse

PIPE = r"\\.\pipe\verge-mihomo"
SECRET = "set-your-secret"
DELAY_URL = "http://www.gstatic.com/generate_204"


def _dechunk(body: bytes) -> bytes:
    """mihomo 对大响应（如 /proxies）用 Transfer-Encoding: chunked，
    直接 json.loads 会报 'Extra data'，所以要先去掉分块长度行。"""
    out = bytearray()
    i = 0
    n = len(body)
    while i < n:
        j = body.find(b"\r\n", i)
        if j < 0:
            break
        try:
            size = int(body[i:j].split(b";")[0], 16)
        except ValueError:
            return body          # 不是分块，原样返回
        if size == 0:
            break
        out += body[j + 2:j + 2 + size]
        i = j + 2 + size + 2     # 跳过数据与其后的 CRLF
    return bytes(out)


def request(method: str, path: str, body: dict | None = None,
            timeout: int = 120) -> dict:
    """HTTP over the Clash named pipe. One connection per call."""
    payload = b""
    headers = [
        f"{method} {path} HTTP/1.1",
        "Host: localhost",
        f"Authorization: Bearer {SECRET}",
        "Connection: close",
    ]
    if body is not None:
        payload = json.dumps(body).encode()
        headers.append("Content-Type: application/json")
        headers.append(f"Content-Length: {len(payload)}")
    raw = ("\r\n".join(headers) + "\r\n\r\n").encode() + payload

    with open(PIPE, "r+b", buffering=0) as f:
        f.write(raw)
        chunks = []
        while True:
            b = f.read(65536)
            if not b:
                break
            chunks.append(b)
    data = b"".join(chunks)
    head, _, body_bytes = data.partition(b"\r\n\r\n")
    status = int(head.split(b" ")[1])
    if b"chunked" in head.lower():
        body_bytes = _dechunk(body_bytes)
    text = body_bytes.decode("utf-8", errors="replace")
    if status >= 400:
        raise RuntimeError(f"HTTP {status}: {text[:300]}")
    return json.loads(text) if text.strip() else {}


def list_all() -> None:
    d = request("GET", "/proxies")
    proxies = d.get("proxies", {})
    groups = {k: v for k, v in proxies.items()
              if v.get("type") in ("Selector", "URLTest", "Fallback", "LoadBalance")}
    print(f"共 {len(proxies)} 个代理项，其中 {len(groups)} 个是分组/选择器\n")
    for name, g in groups.items():
        now = g.get("now", "")
        n = len(g.get("all", []))
        print(f"  分组 [{name}]  类型={g.get('type')}  节点数={n}")
        print(f"      当前 -> {now}")


def find_target_group(prefer: str | None) -> str:
    d = request("GET", "/proxies")
    proxies = d.get("proxies", {})
    cands = [(k, v) for k, v in proxies.items() if v.get("type") == "Selector"]
    if not cands:
        raise SystemExit("没有找到 Selector 类型的分组")
    if prefer:
        for k, _ in cands:
            if prefer.lower() in k.lower():
                return k
        raise SystemExit(f"没有名字含 '{prefer}' 的分组。可选：{[k for k, _ in cands]}")
    # 默认挑节点数最多的那个（通常是主选择器）
    return max(cands, key=lambda kv: len(kv[1].get("all", [])))[0]


def test_group(group: str, top: int = 0, workers: int = 8,
               timeout_ms: int = 3000) -> list[tuple[str, int]]:
    from concurrent.futures import ThreadPoolExecutor

    d = request("GET", "/proxies")
    g = d["proxies"].get(group)
    if not g:
        raise SystemExit(f"分组 {group} 不存在")
    nodes = g.get("all", [])
    print(f"测试分组 [{group}] 的 {len(nodes)} 个节点"
          f"（{workers} 并发，每个 {timeout_ms}ms 超时）...\n")

    def probe(node: str) -> tuple[str, int]:
        q = urllib.parse.urlencode({"timeout": timeout_ms, "url": DELAY_URL})
        try:
            r = request("GET", f"/proxies/{urllib.parse.quote(node, safe='')}/delay?{q}",
                        timeout=timeout_ms / 1000 + 6)
            return node, int(r.get("delay", -1))
        except Exception:
            return node, -1

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(probe, nodes))
    print(f"  测完 {len(nodes)} 个，用时 {time.time()-t0:.0f}s\n")

    ok = sorted([r for r in results if r[1] > 0], key=lambda x: x[1])
    bad = len(results) - len(ok)
    print(f"  可用 {len(ok)} 个，失败/超时 {bad} 个")
    if ok:
        print("\n最快的 10 个：")
        for n, dl in ok[:10]:
            print(f"   {dl:>5} ms   {n}")
        if top:
            return ok[:top]
    else:
        print("所有节点都失败 —— 订阅可能过期或上游整体不可用")
    return ok


def switch(group: str, node: str) -> None:
    request("PUT", f"/proxies/{urllib.parse.quote(group, safe='')}", {"name": node})
    time.sleep(1)
    d = request("GET", "/proxies")
    now = d["proxies"][group].get("now")
    print(f"已切换 [{group}] -> {now}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--switch-fastest", action="store_true")
    ap.add_argument("--group", default=None, help="分组名（子串匹配），默认节点最多的")
    a = ap.parse_args()

    if not any([a.list, a.test, a.switch_fastest]):
        ap.print_help()
        return 0

    try:
        if a.list:
            list_all()
            return 0
        group = find_target_group(a.group)
        print(f"目标分组: {group}\n")
        ok = test_group(group)
        if a.switch_fastest:
            if not ok:
                print("没有可用节点，不切换")
                return 1
            switch(group, ok[0][0])
        return 0
    except FileNotFoundError:
        print(f"打不开命名管道 {PIPE} —— Clash Verge 可能没在运行")
        return 2
    except Exception as e:  # noqa: BLE001
        print(f"失败: {type(e).__name__}: {e}")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
