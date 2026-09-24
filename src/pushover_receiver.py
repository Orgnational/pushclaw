#!/usr/bin/env python3
"""Pushover 接收端原型（纯标准库，零第三方依赖）。

基于 Open Client API 的桌面接收端，非官方，需账号持有 Pushover 桌面许可。
流程：login（邮箱+密码，支持两步验证）→ register（注册本机为 os=O 设备）
     → run（websocket 常驻收信号，实时拉取新消息落地 SQLite 历史库并弹 toast）
     → history / ack（本地历史查询、紧急消息确认）。

子命令：
  login                 邮箱+密码登录，缓存本次会话 secret（不存密码）
  register --name X     注册本机为接收设备（os=O），名字 <=25 位 [A-Za-z0-9_-]
  run                   常驻运行：websocket 实时收消息 → 历史库 → toast
  sync                  手动拉取一次新消息（不用 websocket，便于先验证链路）
  history               查询本地历史（--limit / --search / --priority / --json）
  ack <receipt>         确认紧急消息（全设备静默，服务器原生同步）
  prune                 删除服务端已拉取的队列（update_highest_message）
  selftest              本地回环自测 websocket 编解码与历史库读写

协议要点（官方 Open Client API）：
  - 服务器消息是按设备的队列；prune/自动清理后服务端即删除，历史以本地库为准
  - ws 帧：'#' 心跳（无需回应） '!' 有新消息 'R' 要求重连 'E' 永久错误 'A' 会话被接管
  - 同一设备名两个会话互踢，多台机器请用不同 --name
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html as _html
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
import re
import signal
import socket
import sqlite3
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = os.environ.get("PUSHOVER_API_BASE", "https://api.pushover.net/1")
LOGIN_URL = f"{API}/users/login.json"
DEVICE_URL = f"{API}/devices.json"
MESSAGES_URL = f"{API}/messages.json"
UPDATE_HIGHEST_URL = f"{API}/devices/{{device_id}}/update_highest_message.json"
ACK_URL = f"{API}/receipts/{{receipt}}/acknowledge.json"
WS_HOST = os.environ.get("PUSHOVER_WS_HOST", "client.pushover.net")
WS_PORT = int(os.environ.get("PUSHOVER_WS_PORT", "443"))
WS_TLS = os.environ.get("PUSHOVER_WS_TLS", "1" if WS_PORT == 443 else "0") == "1"
WS_PATH = "/push"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
__version__ = "0.3.0"
UA = f"pushover-receiver/{__version__} (unofficial; macOS/Windows)"

CONFIG_DIR = Path.home() / ".config" / "pushover"
RECEIVER_CONFIG = CONFIG_DIR / "receiver.json"
DATA_DIR = Path.home() / ".local" / "share" / "pushover"
HISTORY_DB = DATA_DIR / "history.db"

DEVICE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,25}$")
DEFAULT_HTTP_PORT = int(os.environ.get("PUSHOVER_HTTP_PORT", "8899"))
WS_READ_TIMEOUT = 180        # 无任何帧（含心跳）的最长等待秒数，超时判死重连
RECONNECT_MIN, RECONNECT_MAX = 3, 60


class ReceiverError(Exception):
    """本地校验失败或 API/ws 层错误。"""


# ---------------------------------------------------------------- HTTP 层

def _http_json(req: urllib.request.Request, timeout: float = 30.0) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            body = json.loads(raw)
        except ValueError:
            raise ReceiverError(f"HTTP {e.code}: {raw[:300]}") from e
        err = ReceiverError(f"HTTP {e.code}: {body.get('errors', body)}")
        err.code = e.code
        raise err from e
    except urllib.error.URLError as e:
        raise ReceiverError(f"网络错误: {e.reason}") from e


def _post_form(url: str, fields: dict[str, str]) -> dict:
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "User-Agent": UA},
        method="POST",
    )
    return _http_json(req)


def _get_json(url: str, params: dict[str, str]) -> dict:
    req = urllib.request.Request(
        f"{url}?{urllib.parse.urlencode(params)}",
        headers={"User-Agent": UA},
        method="GET",
    )
    return _http_json(req)


# ---------------------------------------------------------------- 配置与历史库

def load_config(require: tuple[str, ...] = ()) -> dict:
    if not RECEIVER_CONFIG.is_file():
        raise ReceiverError(
            f"尚未登录/注册：缺少 {RECEIVER_CONFIG}，请先执行 login 和 register"
        )
    cfg = json.loads(RECEIVER_CONFIG.read_text(encoding="utf-8"))
    missing = [k for k in require if not cfg.get(k)]
    if missing:
        raise ReceiverError(f"配置缺少 {missing}，请先执行对应子命令补全")
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    RECEIVER_CONFIG.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.chmod(RECEIVER_CONFIG, 0o600)   # 含会话 secret


_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,   -- 服务端按设备的消息 id
    umid        TEXT,
    title       TEXT,
    message     TEXT,
    html        INTEGER DEFAULT 0,
    priority    INTEGER,
    sound       TEXT,
    url         TEXT,
    url_title   TEXT,
    app         TEXT,
    aid         TEXT,
    date        INTEGER,               -- 消息时间（服务端）
    received_at INTEGER,               -- 本地落库时间
    acked       INTEGER DEFAULT 0,
    receipt     TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
CREATE INDEX IF NOT EXISTS idx_messages_umid ON messages(umid);
"""


def open_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(HISTORY_DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn


def insert_messages(conn: sqlite3.Connection,
                    msgs: list[dict]) -> tuple[int, list[dict]]:
    """落库新消息，返回 (新增条数, 新增的消息列表)（按设备内消息 id 去重）。"""
    now = int(time.time())
    added = 0
    new_msgs: list[dict] = []
    for m in msgs:
        cur = conn.execute(
            """INSERT OR IGNORE INTO messages
               (id, umid, title, message, html, priority, sound, url,
                url_title, app, aid, date, received_at, acked, receipt)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (int(m.get("id", 0)), m.get("umid"), m.get("title"),
             m.get("message"), 1 if m.get("html") else 0,
             m.get("priority", 0), m.get("sound"), m.get("url"),
             m.get("url_title"), m.get("app"), m.get("aid"),
             m.get("date"), now, 1 if m.get("acked") else 0,
             m.get("receipt")),
        )
        if cur.rowcount:
            added += 1
            new_msgs.append(m)
    conn.commit()
    return added, new_msgs


# ---------------------------------------------------------------- API 动作

def api_login(email: str, password: str, twofa: str | None) -> dict:
    fields = {"email": email, "password": password}
    if twofa:
        fields["twofa"] = twofa
    try:
        body = _post_form(LOGIN_URL, fields)
    except ReceiverError as e:
        if getattr(e, "code", None) == 412 and not twofa:
            raise ReceiverError(
                "账号开启了两步验证：请带 --twofa <验证码> 重新执行 login"
            ) from e
        raise
    return {"user_key": body["id"], "secret": body["secret"],
            "email": email, "ts": int(time.time())}


def api_register(secret: str, name: str) -> str:
    if not DEVICE_NAME_RE.match(name):
        raise ReceiverError("设备名限 1-25 位，仅字母/数字/下划线/连字符")
    body = _post_form(DEVICE_URL, {"secret": secret, "name": name, "os": "O"})
    return str(body["id"])


def fetch_messages(cfg: dict) -> list[dict]:
    body = _get_json(MESSAGES_URL, {"secret": cfg["secret"],
                                    "device_id": cfg["device_id"]})
    return body.get("messages", [])


def prune_server(cfg: dict, highest_id: int) -> None:
    _post_form(UPDATE_HIGHEST_URL.format(device_id=cfg["device_id"]),
               {"secret": cfg["secret"], "message": str(highest_id)})


def api_ack(secret: str, receipt: str) -> None:
    _post_form(ACK_URL.format(receipt=receipt), {"secret": secret})


# ---------------------------------------------------------------- Toast（尽力而为）

# 通知小程序的 AppleScript 源码：带 bundle 的独立 applet，通知归属显示为
# "Pushover Toolkit"（而不是 osascript 宿主的"脚本编辑器"）。
# 无环境变量启动（= 用户点击了通知）时打开点击目标（消息链接或本地历史网页）。
APPLET_SCRIPT = (
    'on _openTarget()\n'
    '\ttry\n'
    '\t\tset fPath to (system attribute "HOME") & '
    '"/.local/share/pushover/last_click_target"\n'
    '\t\tset t to read (POSIX file fPath) as «class utf8»\n'
    '\t\tif t is not "" then open location t\n'
    '\tend try\n'
    'end _openTarget\n'
    '\n'
    'on run\n'
    '\tif (system attribute "PO_TITLE") is "" then\n'
    '\t\t_openTarget()\n'
    '\telse\n'
    '\t\tdisplay notification (system attribute "PO_BODY") with title '
    '(system attribute "PO_TITLE")\n'
    '\tend if\n'
    'end run\n'
    '\n'
    'on reopen\n'
    '\t_openTarget()\n'
    'end reopen\n'
)


def build_toast_applet() -> Path | None:
    """构建（或复用）通知 applet，返回其可执行文件路径；不可用返回 None。"""
    app = DATA_DIR / "PushoverToolkit.app"
    exe_dir = app / "Contents" / "MacOS"
    marker = DATA_DIR / ".toast_applet_version"
    exe = next(iter(exe_dir.glob("*")), None) if exe_dir.is_dir() else None
    if exe and marker.is_file() and marker.read_text() == __version__:
        return exe
    if shutil_which("osacompile") is None:
        return None
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".applescript",
                                     delete=False, encoding="utf-8") as tf:
        tf.write(APPLET_SCRIPT)
        src = tf.name
    try:
        r = subprocess.run(["osacompile", "-o", str(app), src],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            print(f"[toast] osacompile 失败: {r.stderr.strip()[:200]}",
                  file=sys.stderr)
            return None
    finally:
        os.unlink(src)
    # 应用名与后台属性（不进 Dock、无窗口）
    pb, plist = "/usr/libexec/PlistBuddy", app / "Contents" / "Info.plist"
    subprocess.run([pb, "Set", ":CFBundleName", "Pushover Toolkit", str(plist)],
                   capture_output=True)
    subprocess.run([pb, "Add", ":LSUIElement", "bool", "true", str(plist)],
                   capture_output=True)   # 已存在时会失败，忽略
    marker.write_text(__version__)
    return next(iter(exe_dir.glob("*")), None)


def send_toast(title: str, body: str, url: str | None = None,
               click_target: str | None = None) -> str:
    """跨平台系统通知，返回实际使用的后端名；全部失败返回 'none'。

    click_target：用户点击通知后打开的地址（缺省用 url）。
    """
    sysname = sys.platform
    if click_target is None:
        click_target = url
    if sysname == "darwin":
        if click_target:
            try:
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                (DATA_DIR / "last_click_target").write_text(click_target)
            except OSError:
                pass
        # 首选：自建 applet（归属 "Pushover Toolkit"，点击可打开目标）
        applet = build_toast_applet()
        if applet:
            env = dict(os.environ, PO_TITLE=title, PO_BODY=body)
            try:
                r = subprocess.run([str(applet)], env=env, capture_output=True,
                                   timeout=15)
                if r.returncode == 0:
                    return "applet"
                print(f"[toast] applet 退出码 {r.returncode}，降级",
                      file=sys.stderr)
            except (OSError, subprocess.TimeoutExpired) as e:
                print(f"[toast] applet 调用失败: {e}，降级", file=sys.stderr)
        # 次选：terminal-notifier（brew 安装，可点击/分组）
        if shutil_which("terminal-notifier"):
            args = ["terminal-notifier", "-title", title, "-message", body,
                    "-group", "pushover-receiver"]
            if click_target:
                args += ["-open", click_target]
            if subprocess.run(args, timeout=15).returncode == 0:
                return "terminal-notifier"
        # 兜底：osascript（归属"脚本编辑器"，点击无动作）
        script = (f'display notification {json.dumps(body, ensure_ascii=False)} '
                  f'with title {json.dumps(title, ensure_ascii=False)}')
        r = subprocess.run(["osascript", "-e", script], timeout=15,
                           capture_output=True, text=True)
        if r.returncode == 0:
            return "osascript"
        print(f"[toast] osascript 失败: {r.stderr.strip()[:120]}",
              file=sys.stderr)
        return "none"
    if sysname == "win32":
        try:
            from windows_toasts import Toast, ToastDisplay  # type: ignore
            t = Toast()
            t.text_fields = [title, body]
            if click_target:
                t.on_activated = lambda *a, **k: _open_target(click_target)
            t.display = ToastDisplay.DURATION_SHORT
            t.show()
            return "windows-toasts"
        except ImportError:
            ps = (f"[Windows.UI.Notifications.ToastNotificationManager, "
                  f"Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; "
                  f"$t=[Windows.UI.Notifications.ToastNotificationManager]"
                  f"::CreateToastNotifier('Pushover Receiver')")
            subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           check=False, timeout=15, capture_output=True)
            return "powershell"
    return "none"


def _open_target(target: str) -> None:
    try:
        import webbrowser
        webbrowser.open(target)
    except Exception:
        pass


# ---------------------------------------------------------------- 本地历史网页

_PAGE_TMPL = """<!doctype html><meta charset="utf-8">
<title>Pushover 历史消息</title>
<style>
body{{font-family:-apple-system,system-ui,"Segoe UI",sans-serif;max-width:720px;
     margin:24px auto;padding:0 16px;background:#141414;color:#e8e8e8}}
a{{color:#7ab8ff}}
.m{{border:1px solid #333;border-radius:10px;padding:12px 16px;margin:10px 0}}
.m:target{{border-color:#e05555;background:#221316}}
.t{{font-weight:600}}
.p{{color:#e05555;font-weight:700;margin-right:6px}}
time{{color:#888;font-size:12px;float:right}}
pre{{white-space:pre-wrap;font-family:inherit;margin:6px 0 0}}
h2 small{{color:#888;font-size:13px;font-weight:400}}
</style>
<h2>Pushover 消息历史 <small>最近 {n} 条 / 共 {total} 条 · {addr}</small></h2>
{items}
"""


def start_history_server(port: int) -> bool:
    """在 127.0.0.1:port 起本地历史网页（后台线程），成功返回 True。"""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):   # 静默访问日志
            pass

        def do_GET(self):
            try:
                conn = open_db()
                total = conn.execute(
                    "SELECT COUNT(*) c FROM messages").fetchone()["c"]
                rows = conn.execute(
                    "SELECT * FROM messages ORDER BY date DESC, id DESC LIMIT 200"
                ).fetchall()
                items = []
                for r in rows:
                    body = r["message"] or ""
                    body_html = body if r["html"] else _html.escape(body)
                    if "\n" in body_html and not r["html"]:
                        body_html = body_html.replace("\n", "<br>")
                    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(
                        r["date"] or r["received_at"]))
                    flag = ("!" if r["priority"] == 2 else
                            "↑" if r["priority"] == 1 else "")
                    title = _html.escape(r["title"] or r["app"] or "-")
                    if r["url"]:
                        title = (f'<a href="{_html.escape(r["url"], quote=True)}">'
                                 f"{title}</a>")
                    items.append(
                        f'<div class="m" id="msg-{r["id"]}">'
                        f'<time>{ts}</time><span class="p">{flag}</span>'
                        f'<span class="t">{title}</span>'
                        f"<pre>{body_html}</pre></div>")
                page = _PAGE_TMPL.format(
                    n=len(rows), total=total, addr=f"127.0.0.1:{port}",
                    items="\n".join(items))
                raw = page.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        print(f"[web] 历史网页端口 {port} 不可用: {e}", file=sys.stderr)
        return False
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return True


def shutil_which(name: str) -> str | None:
    for p in os.environ.get("PATH", "").split(os.pathsep):
        cand = Path(p) / name
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return None


# ---------------------------------------------------------------- DNS 兜底

def doh_resolve(host: str) -> list[str]:
    """系统解析器失败时的 DoH 兜底（1.1.1.1/8.8.8.8 是 IP 字面量，无需再解析）。

    某些网络环境（VPN/代理 DNS、加密 DNS 配置文件）会对特定域名返回 NXDOMAIN，
    而直连公共 DNS 查询正常 —— 此时用 DoH 拿到 A 记录后按 IP 连接、SNI 用原域名。
    """
    for server in ("1.1.1.1", "8.8.8.8"):
        try:
            url = f"https://{server}/dns-query?name={host}&type=A"
            req = urllib.request.Request(
                url, headers={"accept": "application/dns-json",
                              "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            ips = [a["data"] for a in data.get("Answer", [])
                   if a.get("type") == 1]
            if ips:
                return ips
        except Exception:
            continue
    return []


# ---------------------------------------------------------------- 极简 WebSocket 客户端

class WSClient:
    """面向 Pushover ws 的最小 RFC6455 客户端：一次握手、发一条文本、
    之后只读服务端的单字节帧；协议级 ping 自动回 pong；
    空闲时按 keepalive_interval 主动发 '#' 保活（NAT 友好）。"""

    def __init__(self, host: str, port: int, path: str, timeout: float = 30.0,
                 use_tls: bool = True, keepalive_interval: float = 30.0,
                 dead_after: float = WS_READ_TIMEOUT):
        self.addr = (host, port, path)
        self.timeout = timeout
        self.use_tls = use_tls
        self.keepalive_interval = keepalive_interval
        self.dead_after = dead_after
        self.sock: socket.socket | None = None
        self.buf = b""
        self._last_rx = 0.0

    # -- 帧编解码（staticmethod 便于 selftest 单测）--
    @staticmethod
    def encode_frame(opcode: int, payload: bytes) -> bytes:
        """客户端帧：必须带掩码。"""
        head = bytearray([0x80 | opcode])
        n = len(payload)
        mask_bit = 0x80
        if n < 126:
            head.append(mask_bit | n)
        elif n < 65536:
            head.append(mask_bit | 126)
            head += struct.pack(">H", n)
        else:
            head.append(mask_bit | 127)
            head += struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        return bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

    @staticmethod
    def decode_frame(buf: memoryview) -> tuple[int, bytes, int]:
        """解析一帧，返回 (opcode, payload, 消耗字节数)。服务端帧按无掩码处理，
        但若带掩码也兼容解出。"""
        if len(buf) < 2:
            raise EOFError
        b1, b2 = buf[0], buf[1]
        opcode = b1 & 0x0F
        fin = b1 & 0x80
        masked = b2 & 0x80
        n = b2 & 0x7F
        offset = 2
        if n == 126:
            if len(buf) < 4:
                raise EOFError
            n = struct.unpack(">H", buf[2:4])[0]
            offset = 4
        elif n == 127:
            if len(buf) < 10:
                raise EOFError
            n = struct.unpack(">Q", buf[2:10])[0]
            offset = 10
        if len(buf) < offset + (4 if masked else 0) + n:
            raise EOFError
        if n > 1_000_000:
            raise ValueError(f"单帧过大: {n} 字节")
        if fin == 0:
            pass  # 分片帧：Pushover 只发单字节帧，此处不做续帧重组，直接按本帧处理
        mask = b""
        if masked:
            mask = bytes(buf[offset:offset + 4])
            offset += 4
        payload = bytes(buf[offset:offset + n])
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload, offset + n

    # -- 连接 --
    def _dial(self, host_or_ip: str) -> socket.socket:
        raw = socket.create_connection((host_or_ip, self.addr[1]),
                                       timeout=self.timeout)
        raw.settimeout(self.timeout)
        if self.use_tls:
            raw = ssl.create_default_context().wrap_socket(
                raw, server_hostname=self.addr[0])   # SNI/校验始终用真域名
        return raw

    def connect(self) -> None:
        try:
            self.sock = self._dial(self.addr[0])
        except socket.gaierror as e:
            # 系统解析器失败 → DoH 兜底按 IP 连
            ips = doh_resolve(self.addr[0])
            if not ips:
                raise ReceiverError(
                    f"域名 {self.addr[0]} 解析失败（系统与 DoH 均失败）: {e}") from e
            last_err: Exception | None = None
            for ip in ips:
                try:
                    self.sock = self._dial(ip)
                    print(f"[dns] getaddrinfo 失败，经 DoH 解析 {self.addr[0]}"
                          f" → {ip} 连接成功", flush=True)
                    break
                except OSError as ie:
                    last_err = ie
                    self.sock = None
            if self.sock is None:
                raise ReceiverError(f"DoH 解析的 IP 均连接失败: {last_err}")
        self.sock.settimeout(self.timeout)
        self._last_rx = time.monotonic()
        self._last_ka = 0.0

        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {self.addr[2]} HTTP/1.1\r\n"
               f"Host: {self.addr[0]}\r\n"
               f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
               f"User-Agent: {UA}\r\n\r\n")
        self.sock.sendall(req.encode("ascii"))

        # 读握手响应头
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ReceiverError("握手时连接被关闭")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        status = head.split(b"\r\n")[0].decode("latin-1")
        if " 101 " not in f" {status} ":
            raise ReceiverError(f"握手失败: {status}")
        expected = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        m = re.search(r"sec-websocket-accept:\s*(\S+)",
                      head.decode("latin-1"), re.IGNORECASE)
        if not m or m.group(1) != expected:
            raise ReceiverError("握手响应 Sec-WebSocket-Accept 校验失败")
        self.buf = rest   # 握手后可能已带首个帧的前几个字节，交给统一缓冲处理

    def send_text(self, text: str) -> None:
        assert self.sock
        self.sock.sendall(self.encode_frame(0x1, text.encode("utf-8")))

    def recv_app_frame(self) -> str:
        """阻塞读下一个应用层数据帧（自动处理 ping/pong/close），返回字符串。

        TCP 分包安全：解析不完整（EOFError）就继续读，不会误判断线。
        空闲超时则主动发 '#' 客户端保活帧；持续收不到服务端帧则断开重连。"""
        while True:
            while True:
                try:
                    opcode, payload, consumed = self.decode_frame(
                        memoryview(self.buf))
                    break
                except EOFError:
                    pass
                except ValueError as e:
                    raise ReceiverError(f"协议错误: {e}") from e
                try:
                    chunk = self.sock.recv(4096)   # type: ignore[union-attr]
                except socket.timeout:
                    now = time.monotonic()
                    if self._last_rx and now - self._last_rx > self.dead_after:
                        raise EOFError(
                            f"{self.dead_after:.0f}s 未收到服务端任何帧")
                    if now - self._last_ka >= self.keepalive_interval:
                        self.send_text("#")        # 客户端保活（NAT 友好）
                        self._last_ka = now
                    continue
                if not chunk:
                    raise EOFError("连接被关闭")
                self.buf += chunk
            self._last_rx = time.monotonic()
            self.buf = self.buf[consumed:]
            if opcode == 0x9:                     # 协议级 ping -> pong
                assert self.sock
                self.sock.sendall(self.encode_frame(0xA, payload))
                continue
            if opcode == 0x8:                     # close
                try:
                    self.sock.sendall(self.encode_frame(0x8, payload[:2]))
                except OSError:
                    pass
                raise EOFError("服务端关闭连接")
            if opcode in (0x1, 0x2):
                return payload.decode("utf-8", "replace")
            # 0xA pong / 其他控制帧忽略

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.sendall(self.encode_frame(0x8, b""))
                self.sock.close()
            except OSError:
                pass
            self.sock = None


# ---------------------------------------------------------------- 常驻运行

def run_daemon(cfg: dict, auto_clean: bool, toast: bool,
               http_port: int = DEFAULT_HTTP_PORT) -> None:
    conn = open_db()
    if start_history_server(http_port):
        log(f"本地历史网页: http://127.0.0.1:{http_port}")
    backoff = RECONNECT_MIN
    while True:
        try:
            ws = WSClient(WS_HOST, WS_PORT, WS_PATH, use_tls=WS_TLS)
            ws.connect()
            ws.send_text(f"login:{cfg['device_id']}:{cfg['secret']}\n")
            log(f"已连接 {WS_HOST}（设备 {cfg.get('device_name')}），等待新消息")
            backoff = RECONNECT_MIN
            while True:
                try:
                    frame = ws.recv_app_frame()
                except socket.timeout:
                    log("读超时，判定连接失效，重连")
                    break
                if frame == "#":
                    continue
                if frame == "!":
                    msgs = fetch_messages(cfg)
                    if msgs:
                        added, new_msgs = insert_messages(conn, msgs)
                        highest = max(int(m.get("id", 0)) for m in msgs)
                        if auto_clean and highest > 0:
                            try:
                                prune_server(cfg, highest)
                            except ReceiverError as e:
                                log(f"服务端清理失败（不影响本地）: {e}")
                        log(f"收到 {len(msgs)} 条，新入库 {added} 条")
                        if toast and new_msgs:
                            for m in new_msgs[-3:]:   # 只弹新消息，最多 3 条防刷屏
                                title = m.get("title") or m.get("app") or "Pushover"
                                target = m.get("url") or \
                                    f"http://127.0.0.1:{http_port}/#msg-{m.get('id')}"
                                backend = send_toast(title, m.get("message", ""),
                                                     m.get("url"),
                                                     click_target=target)
                                if backend == "none":
                                    log("toast 后端不可用")
                    else:
                        log("收到信号但队列为空")
                    continue
                if frame == "R":
                    log("服务端要求重连(R)")
                    break
                if frame == "E":
                    raise ReceiverError(
                        "服务端返回 E（永久错误），请重新 login")
                if frame == "A":
                    raise ReceiverError(
                        "此设备被另一会话接管(A)：多台机器请用不同 --name 注册")
                log(f"未知帧: {frame!r}")
        except ReceiverError as e:
            log(f"错误: {e}")
            return
        except (EOFError, OSError) as e:
            log(f"连接断开: {e}")
        finally:
            try:
                ws.close()  # type: ignore[name-defined]
            except Exception:
                pass
        log(f"{backoff}s 后重连")
        time.sleep(backoff)
        backoff = min(backoff * 2, RECONNECT_MAX)


def log(msg: str) -> None:
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


# ---------------------------------------------------------------- CLI

def cmd_history(args) -> int:
    conn = open_db()
    q = "SELECT * FROM messages"
    conds, params = [], []
    if args.search:
        conds.append("(title LIKE ? OR message LIKE ? OR app LIKE ?)")
        like = f"%{args.search}%"
        params += [like, like, like]
    if args.priority is not None:
        conds.append("priority = ?")
        params.append(args.priority)
    if conds:
        q += " WHERE " + " AND ".join(conds)
    q += " ORDER BY date DESC, id DESC LIMIT ?"
    params.append(args.limit)
    rows = conn.execute(q, params).fetchall()
    total = conn.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
    if args.json:
        print(json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print("（无记录）")
        return 0
    for r in rows:
        ts = time.strftime("%m-%d %H:%M:%S", time.localtime(r["date"] or r["received_at"]))
        flags = ("!" if r["priority"] == 2 else
                 "↑" if r["priority"] == 1 else
                 " " if r["priority"] is None else " ")
        title = r["title"] or r["app"] or "-"
        body = (r["message"] or "").replace("\n", " ")[:80]
        print(f"{ts} {flags} [{title}] {body}")
    print(f"-- 显示 {len(rows)} / 共 {total} 条（库 {HISTORY_DB}）")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="po-receive",
        description="Pushover 接收端（Open Client API，非官方，需桌面许可；详见 docs/RECEIVER.md）",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    lp = sub.add_parser("login", help="邮箱+密码登录，缓存会话 secret")
    lp.add_argument("email")
    lp.add_argument("password")
    lp.add_argument("--twofa", help="两步验证码（服务端要求 412 时需要）")

    rp = sub.add_parser("register", help="注册本机为接收设备")
    rp.add_argument("--name", required=True, help="设备名 <=25 位 [A-Za-z0-9_-]")

    sp = sub.add_parser("run", help="常驻接收")
    sp.add_argument("--auto-clean", action="store_true",
                    help="入库后删除服务端队列副本（默认保留）")
    sp.add_argument("--no-toast", action="store_true", help="禁用系统通知")
    sp.add_argument("--http-port", type=int, default=DEFAULT_HTTP_PORT,
                    help=f"本地历史网页端口（默认 {DEFAULT_HTTP_PORT}，仅 127.0.0.1）")

    sub.add_parser("sync", help="手动拉取一次（不用 websocket）")

    hp = sub.add_parser("history", help="查询本地历史")
    hp.add_argument("--limit", type=int, default=20)
    hp.add_argument("--search", help="按标题/正文/应用模糊搜索")
    hp.add_argument("--priority", type=int, help="按优先级过滤（如 2=紧急）")
    hp.add_argument("--json", action="store_true")

    ap = sub.add_parser("ack", help="确认紧急消息")
    ap.add_argument("receipt_id")

    sub.add_parser("prune", help="清空服务端本设备队列（本地库不受影响）")
    sub.add_parser("status", help="查看当前配置状态")
    sub.add_parser("selftest", help="本地回环自测 ws 编解码与历史库")
    return p


def cmd_selftest() -> int:
    """本地回环：起一个假 ws 服务端，验证握手、掩码发送、单字节帧收、ping/pong。"""
    import threading

    received: list[bytes] = []
    server_ready = threading.Event()

    def server(sock: socket.socket) -> None:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                return
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")   # rest 可能已含帧字节
        key = re.search(rb"Sec-WebSocket-Key: (\S+)", head).group(1)
        accept = base64.b64encode(
            hashlib.sha1(key + WS_GUID.encode()).digest()).decode()
        sock.sendall(
            (b"HTTP/1.1 101 Switching Protocols\r\n"
             b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
             b"Sec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n"))
        server_ready.set()

        buf = rest

        def read_exact(n: int) -> bytes:
            nonlocal buf
            while len(buf) < n:
                chunk = sock.recv(4096)
                if not chunk:
                    raise EOFError
                buf += chunk
            out, buf = buf[:n], buf[n:]
            return out

        # 读客户端的 login 帧（客户端帧带掩码，手动按 RFC 解析）
        hdr = read_exact(2)
        assert hdr[0] & 0x0F == 0x1, f"期望文本帧，得到 opcode {hdr[0] & 0x0F}"
        assert hdr[1] & 0x80, "客户端帧应带掩码位"
        n = hdr[1] & 0x7F
        mask = read_exact(4)
        plain = bytes(b ^ mask[i % 4] for i, b in enumerate(read_exact(n)))
        received.append(plain)
        # 发应用帧：!、心跳 #、协议 ping（0x81=FIN+文本，下一字节是长度）
        sock.sendall(bytes([0x81, 0x01, 0x21]))        # 文本 "!"
        sock.sendall(bytes([0x81, 0x01, 0x23]))        # 文本 "#"
        sock.sendall(bytes([0x89, 0x01, 0x42]))        # ping "B"
        # 等客户端 pong
        pong = sock.recv(64)
        assert pong and (pong[0] & 0x0F) == 0xA, f"期望 pong，得到 {pong[:8]!r}"
        sock.sendall(bytes([0x88, 0x00]))          # close
        sock.close()

    lst = socket.socket()
    lst.bind(("127.0.0.1", 0))
    lst.listen(1)
    port = lst.getsockname()[1]

    def serve() -> None:
        conn, _ = lst.accept()
        server(conn)

    threading.Thread(target=serve, daemon=True).start()

    ws = WSClient("127.0.0.1", port, "/push", timeout=5, use_tls=False)
    ws.connect()
    ws.send_text("login:dev1:secret123\n")
    server_ready.wait(5)
    f1 = ws.recv_app_frame()
    f2 = ws.recv_app_frame()
    assert f1 == "!" and f2 == "#", f"应用帧不符: {f1!r} {f2!r}"
    # 第三个"帧"是协议 ping：客户端应自动回 pong（服务端断言），随后收到 close
    try:
        ws.recv_app_frame()
        raise AssertionError("ping/pong/close 流程未按预期结束")
    except EOFError:
        pass
    assert received and b"login:dev1:secret123" in received[0], "服务端未收到登录帧"
    ws.close()

    # 历史库读写自测（用临时库路径）
    global DATA_DIR, HISTORY_DB
    orig = DATA_DIR
    DATA_DIR = Path("/tmp/po_selftest") / str(os.getpid())
    HISTORY_DB = DATA_DIR / "history.db"
    try:
        conn = open_db()
        n, _ = insert_messages(conn, [
            {"id": 1, "umid": "u1", "title": "t", "message": "hello",
             "priority": 2, "app": "App", "date": int(time.time()),
             "receipt": "rc1", "acked": 0},
            {"id": 2, "umid": "u2", "title": None, "message": "world",
             "priority": 0, "app": "App", "date": int(time.time())},
        ])
        again, _ = insert_messages(conn, [{"id": 1, "message": "dup"}])
        rows = conn.execute("SELECT * FROM messages ORDER BY id").fetchall()
        assert n == 2 and again == 0 and len(rows) == 2, "落库/去重失败"
        assert rows[0]["priority"] == 2 and rows[0]["acked"] == 0
    finally:
        import shutil as _sh
        _sh.rmtree(DATA_DIR, ignore_errors=True)
        DATA_DIR = orig

    print("selftest PASS：握手/掩码发送/应用帧/pong/历史库读写+去重 全部通过")
    return 0


def cmd_status() -> int:
    if not RECEIVER_CONFIG.is_file():
        print("未登录（无 receiver.json）")
        return 0
    cfg = json.loads(RECEIVER_CONFIG.read_text(encoding="utf-8"))
    for k in ("email", "user_key", "device_name", "device_id", "ts"):
        v = cfg.get(k, "-")
        if k == "ts" and v != "-":
            v = time.strftime("%Y-%m-%d %H:%M", time.localtime(v))
        print(f"{k:12} = {v}")
    print(f"secret       = {'已缓存' if cfg.get('secret') else '无'}")
    if HISTORY_DB.is_file():
        conn = open_db()
        cnt = conn.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
        print(f"history      = {cnt} 条（{HISTORY_DB}）")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "login":
            cfg = api_login(args.email, args.password, args.twofa)
            old = json.loads(RECEIVER_CONFIG.read_text(encoding="utf-8")) \
                if RECEIVER_CONFIG.is_file() else {}
            old.update(cfg)
            save_config(old)
            print(f"OK 已登录（{args.email}），会话 secret 已缓存到 {RECEIVER_CONFIG}")
            print("下一步: python3 pushover_receiver.py register --name <设备名>")
        elif args.cmd == "register":
            cfg = load_config(require=("secret",))
            cfg["device_id"] = api_register(cfg["secret"], args.name)
            cfg["device_name"] = args.name
            save_config(cfg)
            print(f"OK 设备已注册: {args.name} (id={cfg['device_id']})")
            print("下一步: python3 pushover_receiver.py sync  # 先手动验证链路")
        elif args.cmd == "sync":
            cfg = load_config(require=("secret", "device_id"))
            msgs = fetch_messages(cfg)
            conn = open_db()
            added, _ = insert_messages(conn, msgs)
            print(f"队列 {len(msgs)} 条，新入库 {added} 条")
        elif args.cmd == "run":
            cfg = load_config(require=("secret", "device_id"))
            run_daemon(cfg, auto_clean=args.auto_clean, toast=not args.no_toast,
                       http_port=args.http_port)
        elif args.cmd == "history":
            return cmd_history(args)
        elif args.cmd == "ack":
            cfg = load_config(require=("secret",))
            api_ack(cfg["secret"], args.receipt_id)
            conn = open_db()
            conn.execute("UPDATE messages SET acked=1 WHERE receipt=?",
                         (args.receipt_id,))
            conn.commit()
            print(f"OK 已确认 {args.receipt_id}（全部设备静默）")
        elif args.cmd == "prune":
            cfg = load_config(require=("secret", "device_id"))
            conn = open_db()
            row = conn.execute("SELECT MAX(id) m FROM messages").fetchone()
            if row["m"]:
                prune_server(cfg, row["m"])
                print(f"OK 已请求服务端删除 ≤{row['m']} 的队列消息")
            else:
                print("本地无记录，无需清理")
        elif args.cmd == "status":
            return cmd_status()
        elif args.cmd == "selftest":
            return cmd_selftest()
    except ReceiverError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n退出")
        return 0
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.default_int_handler)
    sys.exit(main())
