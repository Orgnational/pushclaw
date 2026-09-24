#!/usr/bin/env python3
"""接收端端到端集成测试：本地模拟 Pushover 服务端（HTTP + WebSocket），
以子进程驱动 pushover_receiver.py 的 login/register/sync/run/history/ack/prune
全流程，验证真实代码路径（含配置落盘、SQLite、ws 帧循环）。

运行：python3 test_receiver_e2e.py    （无需真实账号，全程本地）
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import select
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROOT = Path(__file__).parent.parent
SRC = ROOT / "src"

# ---------------------------------------------------------------- 模拟状态

STATE = {
    "users": {},     # email -> {password, secret, user_key}
    "devices": {},   # device_id -> {name, secret, queue: []}
    "acked": set(),  # receipts
    "pruned": [],    # update_highest 调用记录
}
_next_id = [100]


def make_msg(mid: int, text: str, priority: int = 1, receipt: str | None = None) -> dict:
    return {"id": mid, "id_str": str(mid), "umid": f"u{mid}", "title": f"标题{mid}",
            "message": text, "app": "TestApp", "aid": "aid1", "date": int(time.time()),
            "priority": priority, "sound": "pushover", "acked": 0,
            **({"receipt": receipt} if receipt else {})}


# ---------------------------------------------------------------- 模拟 HTTP 服务端

class MockAPI(BaseHTTPRequestHandler):
    def log_message(self, *a):  # 静默
        pass

    def _send(self, code: int, body: dict):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _fields(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode() if n else ""
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        f = self._fields()
        if path == "/1/users/login.json":
            user = STATE["users"].get(f.get("email", ""))
            if user and f.get("password") == "412please" and not f.get("twofa"):
                self._send(412, {"errors": ["2FA required"]})
                return
            if user and f.get("password") == user["password"]:
                self._send(200, {"status": 1, "id": user["user_key"],
                                 "secret": user["secret"]})
            else:
                self._send(400, {"errors": ["user/email or password is invalid"]})
        elif path == "/1/devices.json":
            if not STATE["users"] or f.get("secret") != "sess-ok":
                self._send(400, {"errors": ["invalid secret"]})
                return
            _next_id[0] += 1
            did = f"dev{_next_id[0]}"
            STATE["devices"][did] = {"name": f["name"], "secret": f["secret"],
                                     "queue": []}
            self._send(200, {"status": 1, "id": did})
        elif path == "/1/users/validate.json":
            self._send(200, {"status": 1, "devices": list(
                d["name"] for d in STATE["devices"].values())})
        elif "/update_highest_message" in path:
            did = path.split("/")[3]
            dev = STATE["devices"].get(did)
            if not dev or f.get("secret") != "sess-ok":
                self._send(400, {"errors": ["invalid secret"]})
                return
            highest = int(f.get("message", 0))
            dev["queue"] = [m for m in dev["queue"] if m["id"] > highest]
            STATE["pruned"].append((did, highest))
            self._send(200, {"status": 1})
        elif "/acknowledge" in path:
            rid = path.split("/")[3]
            STATE["acked"].add(rid)
            self._send(200, {"status": 1})
        else:
            self._send(404, {"errors": ["not found"]})

    def do_GET(self):
        split = urllib.parse.urlsplit(self.path)
        params = {k: v[0] for k, v in urllib.parse.parse_qs(split.query).items()}
        if split.path == "/1/messages.json":
            dev = next((d for d in STATE["devices"].values()
                        if d["secret"] == params.get("secret")
                        and params.get("device_id") in STATE["devices"]
                        and STATE["devices"][params["device_id"]] is d), None)
            if dev is None:
                self._send(400, {"errors": ["invalid secret or device"]})
                return
            self._send(200, {"status": 1, "messages": dev["queue"]})
        else:
            self._send(404, {"errors": ["not found"]})


# ---------------------------------------------------------------- 模拟 WS 服务端

def ws_server(host: str, port: int, on_login, holder: dict):
    """接受一个 ws 连接，验证握手，读 login 帧，回调 on_login(device, secret)
    后保持连接；holder['conn'] 供主测试随时补发 '!' 信号。仅测试用。"""
    lst = socket.socket()
    lst.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    lst.bind((host, port))
    lst.listen(1)
    conn, _ = lst.accept()
    data = b""
    while b"\r\n\r\n" not in data:
        data += conn.recv(4096)
    head, _, rest = data.partition(b"\r\n\r\n")
    key = re.search(rb"Sec-WebSocket-Key: (\S+)", head).group(1)
    accept = base64.b64encode(
        hashlib.sha1(key + WS_GUID.encode()).digest()).decode()
    conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                 b"Connection: Upgrade\r\nSec-WebSocket-Accept: "
                 + accept.encode() + b"\r\n\r\n")
    buf = rest

    def read_exact(n):
        nonlocal buf
        while len(buf) < n:
            chunk = conn.recv(4096)
            if not chunk:
                raise EOFError
            buf += chunk
        out, buf = buf[:n], buf[n:]
        return out

    hdr = read_exact(2)
    n = hdr[1] & 0x7F
    mask = read_exact(4)
    line = bytes(b ^ mask[i % 4] for i, b in enumerate(read_exact(n))).decode()
    device_id, secret = line.strip().split(":")[1:3]
    holder["conn"] = conn
    on_login(device_id, secret)
    conn.sendall(bytes([0x81, 0x01, 0x21]))   # "!" 帧：模拟有新消息
    # 保持连接（读走心跳/其他帧），由测试进程退出时统一关闭
    try:
        while True:
            if not conn.recv(4096):
                break
    except OSError:
        pass


# ---------------------------------------------------------------- 测试驱动

def run_cli(home: Path, env_extra: dict, *args: str, timeout: int = 20):
    env = dict(os.environ, HOME=str(home), **env_extra)
    r = subprocess.run([sys.executable, str(SRC / "pushover_receiver.py"), *args],
                       capture_output=True, text=True, env=env, timeout=timeout)
    return r


def expect(cond: bool, name: str, detail: str = ""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f": {detail}" if detail and not cond else ""))
    if not cond:
        sys.exit(1)


def main() -> int:
    tmp = Path("/tmp/po_e2e_test")
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)

    api = ThreadingHTTPServer(("127.0.0.1", 0), MockAPI)
    api_port = api.server_address[1]
    threading.Thread(target=api.serve_forever, daemon=True).start()

    ws_ready = threading.Event()
    ws_logins: list[tuple[str, str]] = []
    holder: dict = {}

    def on_login(device_id: str, secret: str):
        ws_logins.append((device_id, secret))
        ws_ready.set()

    # 先占端口再取实际值
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    ws_port = probe.getsockname()[1]
    probe.close()
    threading.Thread(target=ws_server, args=("127.0.0.1", ws_port, on_login, holder),
                     daemon=True).start()

    env = {"PUSHOVER_API_BASE": f"http://127.0.0.1:{api_port}/1",
           "PUSHOVER_WS_HOST": "127.0.0.1",
           "PUSHOVER_WS_PORT": str(ws_port),
           "PUSHOVER_WS_TLS": "0"}

    # 预置账号
    STATE["users"]["tester@example.com"] = {
        "password": "pw123", "secret": "sess-ok", "user_key": "ukey123"}

    # 1. login（含 2FA 412 路径）
    r = run_cli(tmp, env, "login", "tester@example.com", "412please")
    expect(r.returncode == 1 and "两步验证" in r.stderr, "login 412 → 提示 --twofa",
           r.stderr)
    r = run_cli(tmp, env, "login", "tester@example.com", "badpw")
    expect(r.returncode == 1 and "invalid" in r.stderr, "login 错误密码被拒", r.stderr)
    r = run_cli(tmp, env, "login", "tester@example.com", "pw123")
    expect(r.returncode == 0 and "已登录" in r.stdout, "login 成功", r.stdout + r.stderr)

    # 2. register
    r = run_cli(tmp, env, "register", "--name", "bad name!")
    expect(r.returncode == 1, "register 非法设备名被拒", r.stderr)
    r = run_cli(tmp, env, "register", "--name", "test-dev")
    expect(r.returncode == 0 and "已注册" in r.stdout, "register 成功",
           r.stdout + r.stderr)

    # 3. 服务端队列注入两条（其中一条带 receipt 的紧急消息）→ sync
    dev = next(iter(STATE["devices"].values()))
    dev["queue"] = [
        make_msg(101, "普通消息 hello", priority=1),
        make_msg(102, "紧急消息 fire", priority=2, receipt="rc-abc"),
    ]
    r = run_cli(tmp, env, "sync")
    expect(r.returncode == 0 and "队列 2 条，新入库 2 条" in r.stdout, "sync 拉取入库",
           r.stdout + r.stderr)

    # 4. history 查询
    r = run_cli(tmp, env, "history", "--json")
    rows = json.loads(r.stdout)
    expect(len(rows) == 2 and rows[0]["receipt"] == "rc-abc", "history JSON 查询",
           r.stdout)
    r = run_cli(tmp, env, "history", "--search", "fire")
    expect("紧急消息 fire" in r.stdout, "history 搜索", r.stdout)

    # 5. ack 紧急消息
    r = run_cli(tmp, env, "ack", "rc-abc")
    expect(r.returncode == 0 and "rc-abc" in STATE["acked"], "ack 到达服务端并本地标记",
           r.stdout + r.stderr)
    r = run_cli(tmp, env, "history", "--json")
    row = next(x for x in json.loads(r.stdout) if x["id"] == 102)
    expect(row["acked"] == 1, "本地 acked 已置 1")

    # 6. run 常驻：ws 连上后再注入一条 → 应自动入库并弹 toast（--no-toast 关闭）
    popen = subprocess.Popen(
        [sys.executable, str(SRC / "pushover_receiver.py"), "run", "--no-toast"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env=dict(os.environ, HOME=str(tmp), **env))
    ws_ready.wait(10)
    got_pre = ""
    t_end = time.time() + 8
    while time.time() < t_end:
        ready, _, _ = select.select([popen.stdout], [], [], 1)
        if not ready:
            if popen.poll() is not None:
                break
            continue
        ln = popen.stdout.readline()
        if not ln:
            break
        got_pre += ln
    print(f"[DBG] receiver out: {got_pre.strip()[:300]!r} poll={popen.poll()}")
    expect(bool(ws_logins), "run 通过 ws 发送 login 帧",
           f"out={got_pre.strip()[:400]} exit={popen.poll()}")
    got = got_pre
    dev["queue"].append(make_msg(103, "常驻模式实时消息"))
    time.sleep(0.3)
    holder["conn"].sendall(bytes([0x81, 0x01, 0x21]))   # 再发 "!"：模拟新消息到达
    deadline = time.time() + 15
    while time.time() < deadline and "新入库 1 条" not in got:
        ready, _, _ = select.select([popen.stdout], [], [], 2)
        if not ready:
            continue
        line = popen.stdout.readline()
        got += line
        if "新入库 1 条" in line:
            break
    expect("新入库 1 条" in got, "run 实时收到 ! 帧并入库", got[-400:])
    popen.send_signal(signal.SIGTERM)
    try:
        popen.wait(5)
    except subprocess.TimeoutExpired:
        popen.kill()

    # 7. prune 清服务端队列
    r = run_cli(tmp, env, "prune")
    expect(r.returncode == 0 and dev["queue"] == [], "prune 清空服务端队列",
           r.stdout + str(dev["queue"]))
    r = run_cli(tmp, env, "history", "--json")
    expect(len(json.loads(r.stdout)) == 3, "本地历史不受 prune 影响")

    api.shutdown()
    print("\nE2E PASS：login(412/错密/成功)/register/sync/history/ack/run 实时/prune 全链路通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
