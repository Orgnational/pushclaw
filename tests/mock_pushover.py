#!/usr/bin/env python3
"""Pushover mock 服务器（登录流程复现专用）。

实现 /1/users/login.json、/1/devices.json、/1/messages.json；
记录每个请求到 stdout（带时间戳），用于观测客户端卡在哪一步。
用法：python3 tests/mock_pushover.py <port>
"""
import json
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"login_count": 0, "register_count": 0}
LOG = sys.stdout


def log(msg):
    LOG.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    LOG.flush()


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _fields(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode() if n else ""
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        f = self._fields()
        if path == "/1/users/login.json":
            STATE["login_count"] += 1
            log(f"← login.json 请求 #{STATE['login_count']}（email={f.get('email')}）——即回响应")
            self._send(200, {"status": 1, "id": "ukey-mock", "secret": "sess-mock"})
        elif path == "/1/devices.json":
            STATE["register_count"] += 1
            log(f"← devices.json 请求 #{STATE['register_count']}（name={f.get('name')}）——即回响应")
            self._send(200, {"status": 1, "id": f"devid-mock-{STATE['register_count']}"})
        else:
            log(f"← 未知 POST {path}")
            self._send(404, {"errors": ["not found"]})

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/1/messages.json":
            log("← messages.json 轮询 —— 回空队列")
            self._send(200, {"status": 1, "messages": []})
        else:
            self._send(404, {"errors": ["not found"]})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18099
    srv = ThreadingHTTPServer(("127.0.0.1", port), Mock)
    log(f"mock 服务器就绪 :{port}")
    srv.serve_forever()
