#!/usr/bin/env python3
"""Pushover 发送端原型（纯标准库，零第三方依赖）。

向 Pushover 账号下的设备推送消息，支持：
  - 富文本：有限 HTML（<b> <i> <u> <font color> <a>）或等宽字体，二者互斥
  - 图片附件：仅图片，单张 <= 5MB（bmp/gif/jpeg/png/tiff），Pushover 不支持视频
  - 强提醒：priority=2，未确认前按 retry 间隔在所有设备上重复响铃（最长 expire 秒），
    任意设备确认后所有设备静默（跨设备确认同步为服务器原生行为），回执可查
  - 定向设备 / 辅助链接 / TTL 自动消失 / 自定义音效 / 确认回调 callback

子命令：
  send      发送一条消息
  validate  校验凭据并返回账号下的设备列表（不发消息）
  receipt   查询 priority=2 消息的确认状态

凭据解析顺序：命令行参数 > 环境变量 PUSHOVER_TOKEN / PUSHOVER_USER
             > ~/.config/pushover/config.json

示例：
  python3 pushover_sender.py validate
  python3 pushover_sender.py send "磁盘告警" -t "运维" -p 2 --html \
      -i chart.png --url "https://grafana.example.com" --url-title "查看面板"
  python3 pushover_sender.py receipt <receipt-id>
"""

from __future__ import annotations

import argparse
import io
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

API_URL = "https://api.pushover.net/1/messages.json"
VALIDATE_URL = "https://api.pushover.net/1/users/validate.json"
RECEIPT_URL = "https://api.pushover.net/1/receipts/{receipt}.json"
__version__ = "0.3.0"
USER_AGENT = f"pushover-sender/{__version__}"

MAX_MESSAGE_LEN = 1024        # 正文上限（字符数）
MAX_TITLE_LEN = 250           # 标题上限
MAX_URL_LEN = 512             # 辅助链接上限
MAX_URL_TITLE_LEN = 100       # 链接标题上限
MAX_ATTACHMENT_BYTES = 5_242_880  # 附件上限 5.0 MB，仅图片
MIN_RETRY = 30                # priority=2 重试间隔下限（秒）
MAX_EXPIRE = 10_800           # priority=2 确认窗口上限（3 小时）
DEFAULT_EXPIRE = 3_600        # priority=2 未指定 expire 时的默认值（1 小时）

# Pushover 官方支持的附件图片类型
IMAGE_MIMES = {"image/bmp", "image/gif", "image/jpeg", "image/png", "image/tiff"}

# 官方音效名（--sound 可自由填写，服务端会拒绝非法值）
SOUNDS = [
    "pushover", "bike", "bugle", "cashregister", "classical", "cosmic",
    "falling", "gamelan", "incoming", "intermission", "magic", "mechanical",
    "pianobar", "siren", "spacealarm", "tugboat", "alien", "climb",
    "persistent", "echo", "updown", "vibrate", "none",
]

CONFIG_FILE = Path.home() / ".config" / "pushover" / "config.json"


class PushoverError(Exception):
    """本地参数校验失败或 API 返回错误。"""


# ---------------------------------------------------------------- HTTP 层

def _http_json(req: urllib.request.Request, timeout: float = 30.0) -> dict:
    """发起请求并解析 JSON 响应；HTTPError 时把服务端 errors 提出来。"""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            body = json.loads(raw)
        except ValueError:
            raise PushoverError(f"HTTP {e.code}: {raw[:300]}") from e
        raise PushoverError(f"HTTP {e.code}: {body.get('errors', body)}") from e
    except urllib.error.URLError as e:
        raise PushoverError(f"网络错误: {e.reason}") from e


def _post_multipart(url: str, fields: dict[str, str],
                    image: Path | None, mime: str | None) -> dict:
    """以 multipart/form-data 提交；image 为 None 时退化为普通表单。"""
    boundary = "----pushoverproto" + uuid.uuid4().hex
    buf = io.BytesIO()
    for key, value in fields.items():
        buf.write(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )
    if image is not None:
        buf.write(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="attachment"; '
            f'filename="{image.name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n".encode("utf-8")
        )
        buf.write(image.read_bytes())
        buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode("utf-8"))

    req = urllib.request.Request(
        url,
        data=buf.getvalue(),
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    return _http_json(req)


def _get_json(url: str, params: dict) -> dict:
    req = urllib.request.Request(
        f"{url}?{urllib.parse.urlencode(params)}",
        headers={"User-Agent": USER_AGENT},
        method="GET",
    )
    return _http_json(req)


# ---------------------------------------------------------------- 凭据

def resolve_credentials(token: str | None, user: str | None,
                        need: bool = True, need_user: bool = True) -> tuple[str | None, str | None]:
    """按 命令行 > 环境变量 > 配置文件 的顺序解析凭据。

    need_user=False 时只要求 token（如 receipt 查询不需要用户 Key）。
    """
    cfg: dict = {}
    if CONFIG_FILE.is_file():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError) as e:
            raise PushoverError(f"配置文件 {CONFIG_FILE} 解析失败: {e}") from e

    token = token or os.environ.get("PUSHOVER_TOKEN") or cfg.get("token")
    user = user or os.environ.get("PUSHOVER_USER") or cfg.get("user")
    missing = not token or (need_user and not user)
    if need and missing:
        raise PushoverError(
            "缺少凭据：请设置 --token/--user 参数、PUSHOVER_TOKEN/PUSHOVER_USER "
            f"环境变量，或在 {CONFIG_FILE} 写入 {{\"token\": ..., \"user\": ...}}"
        )
    return token, user


# ---------------------------------------------------------------- API

def send_message(
    token: str,
    user: str,
    message: str,
    *,
    title: str | None = None,
    priority: int = 0,
    html: bool = False,
    monospace: bool = False,
    image: str | os.PathLike | None = None,
    device: str | None = None,
    url: str | None = None,
    url_title: str | None = None,
    sound: str | None = None,
    ttl: int | None = None,
    retry: int | None = None,
    expire: int | None = None,
    callback: str | None = None,
    timestamp: int | None = None,
    dry_run: bool = False,
) -> dict:
    """发送一条消息。priority=2 时返回值里带 receipt，可用 receipt 命令查询。

    dry_run=True 时只做校验并返回将要提交的载荷，不发起网络请求。
    """
    # ---- 本地校验（与官方文档的限制一致）----
    if not message:
        raise PushoverError("message 不能为空")
    if len(message) > MAX_MESSAGE_LEN:
        raise PushoverError(
            f"消息正文 {len(message)} 字符，超过上限 {MAX_MESSAGE_LEN}"
        )
    if title and len(title) > MAX_TITLE_LEN:
        raise PushoverError(f"标题超过 {MAX_TITLE_LEN} 字符")
    if html and monospace:
        raise PushoverError("html 与 monospace 互斥，只能二选一")
    if url and len(url) > MAX_URL_LEN:
        raise PushoverError(f"url 超过 {MAX_URL_LEN} 字符")
    if url_title and len(url_title) > MAX_URL_TITLE_LEN:
        raise PushoverError(f"url_title 超过 {MAX_URL_TITLE_LEN} 字符")
    if not -2 <= priority <= 2:
        raise PushoverError("priority 取值范围 -2..2")

    fields: dict[str, str] = {"token": token, "user": user, "message": message}
    if title:
        fields["title"] = title
    if html:
        fields["html"] = "1"
    if monospace:
        fields["monospace"] = "1"
    if device:
        fields["device"] = device
    if url:
        fields["url"] = url
    if url_title:
        fields["url_title"] = url_title
    if sound:
        fields["sound"] = sound
    if callback:
        fields["callback"] = callback
    if timestamp is not None:
        fields["timestamp"] = str(timestamp)

    if priority == 2:
        retry = MIN_RETRY if retry is None else retry
        expire = DEFAULT_EXPIRE if expire is None else expire
        if retry < MIN_RETRY:
            raise PushoverError(f"priority=2 时 retry 最小 {MIN_RETRY} 秒")
        if expire > MAX_EXPIRE:
            raise PushoverError(f"priority=2 时 expire 最大 {MAX_EXPIRE} 秒")
        fields["priority"] = "2"
        fields["retry"] = str(retry)
        fields["expire"] = str(expire)
        if ttl is not None:
            print("[warn] priority=2 时 ttl 会被服务端忽略", file=sys.stderr)
    else:
        fields["priority"] = str(priority)
        if ttl is not None:
            fields["ttl"] = str(ttl)

    # ---- 附件 ----
    image_path: Path | None = None
    mime: str | None = None
    if image is not None:
        image_path = Path(image)
        if not image_path.is_file():
            raise PushoverError(f"附件不存在: {image_path}")
        size = image_path.stat().st_size
        if size > MAX_ATTACHMENT_BYTES:
            raise PushoverError(
                f"附件 {size} 字节，超过上限 {MAX_ATTACHMENT_BYTES}（5.0 MB，仅图片）"
            )
        mime = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
        if mime not in IMAGE_MIMES:
            print(
                f"[warn] 附件类型 {mime} 不在官方支持列表 "
                f"(bmp/gif/jpeg/png/tiff)，服务端可能拒绝",
                file=sys.stderr,
            )

    if dry_run:
        payload = {"dry_run": True, "url": API_URL, "fields": fields}
        if image_path:
            payload["attachment"] = {
                "path": str(image_path), "size": image_path.stat().st_size,
                "mime": mime,
            }
        return payload

    return _post_multipart(API_URL, fields, image_path, mime)


def validate_credentials(token: str, user: str,
                         device: str | None = None) -> dict:
    """校验凭据（不发消息），返回值含 devices 设备列表。"""
    fields = {"token": token, "user": user}
    if device:
        fields["device"] = device
    return _post_multipart(VALIDATE_URL, fields, None, None)


def check_receipt(token: str, receipt: str) -> dict:
    """查询 priority=2 消息的确认状态。"""
    return _get_json(RECEIPT_URL.format(receipt=receipt), {"token": token})


# ---------------------------------------------------------------- 输出

def _fmt_ts(ts) -> str:
    if not ts:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(ts)))


def _print_send_result(body: dict) -> None:
    print(f"OK status={body.get('status')} request={body.get('request')}")
    if body.get("receipt"):
        print(f"  priority=2 回执: {body['receipt']}")
        print(f"  查询确认状态: python3 {Path(sys.argv[0]).name} "
              f"receipt {body['receipt']}")


def _print_receipt(body: dict) -> None:
    print(f"acknowledged = {body.get('acknowledged')}"
          f"  (由设备 {body.get('acknowledged_by', '-')}"
          f" / {body.get('acknowledged_by_device', '-')})"
          f"  于 {_fmt_ts(body.get('acknowledged_at'))}")
    print(f"expired      = {body.get('expired')}"
          f"  (到期时间 {_fmt_ts(body.get('expires_at'))})")
    print(f"called_back  = {body.get('called_back')}"
          f"  (最近回调尝试 {_fmt_ts(body.get('callback_attempt'))})")
    print(f"last_delivered_at = {_fmt_ts(body.get('last_delivered_at'))}")


# ---------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="po-send",
        description="Pushover 发送端（详见 --help 与 docs/SENDER.md）",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--token", help="应用 API Token（30 位），默认读环境/配置")
    common.add_argument("--user", help="用户或组 Key，默认读环境/配置")
    common.add_argument("--json", action="store_true", help="输出原始 JSON")

    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("send", parents=[common], help="发送一条消息")
    sp.add_argument("message", help=f"正文（<= {MAX_MESSAGE_LEN} 字符）")
    sp.add_argument("-t", "--title", help=f"标题（<= {MAX_TITLE_LEN} 字符）")
    sp.add_argument("-i", "--image", help="图片附件路径（bmp/gif/jpeg/png/tiff, <=5MB）")
    sp.add_argument("-p", "--priority", type=int, default=0,
                    help="-2..2；2 为强提醒（默认 retry=30, expire=3600）")
    sp.add_argument("--html", action="store_true",
                    help="启用有限 HTML：<b> <i> <u> <font color> <a>")
    sp.add_argument("--monospace", action="store_true", help="等宽字体（与 --html 互斥）")
    sp.add_argument("-d", "--device", help="定向设备名，逗号分隔多个；缺省广播全部设备")
    sp.add_argument("--url", help="辅助链接")
    sp.add_argument("--url-title", dest="url_title", help="辅助链接标题")
    sp.add_argument("--sound", help=f"音效名，可选: {' '.join(SOUNDS)}")
    sp.add_argument("--ttl", type=int, help="消息在设备上的存活秒数（priority=2 忽略）")
    sp.add_argument("--retry", type=int, help=f"priority=2 重试间隔秒（>= {MIN_RETRY}）")
    sp.add_argument("--expire", type=int, help=f"priority=2 确认窗口秒（<= {MAX_EXPIRE}）")
    sp.add_argument("--callback", help="确认后服务端回调的 URL")
    sp.add_argument("--timestamp", type=int, help="消息时间戳覆盖（Unix 秒）")
    sp.add_argument("--dry-run", action="store_true",
                    help="只校验并打印载荷，不真正发送（无需凭据）")

    vp = sub.add_parser("validate", parents=[common], help="校验凭据并列出设备")
    vp.add_argument("--device", help="校验某设备是否属于该账号")

    rp = sub.add_parser("receipt", parents=[common],
                        help=f"查询 priority=2 回执（仅需 --token）")
    rp.add_argument("receipt_id")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "send":
            token, user = resolve_credentials(args.token, args.user,
                                              need=not args.dry_run)
            body = send_message(
                token or "MISSING_TOKEN", user or "MISSING_USER",
                args.message,
                title=args.title, priority=args.priority, html=args.html,
                monospace=args.monospace, image=args.image, device=args.device,
                url=args.url, url_title=args.url_title, sound=args.sound,
                ttl=args.ttl, retry=args.retry, expire=args.expire,
                callback=args.callback, timestamp=args.timestamp,
                dry_run=args.dry_run,
            )
            if args.json:
                print(json.dumps(body, ensure_ascii=False, indent=2))
            elif args.dry_run:
                print("dry-run 载荷：")
                print(json.dumps(body, ensure_ascii=False, indent=2))
            else:
                _print_send_result(body)

        elif args.cmd == "validate":
            token, user = resolve_credentials(args.token, args.user)
            body = validate_credentials(token, user, device=args.device)
            if args.json:
                print(json.dumps(body, ensure_ascii=False, indent=2))
            else:
                print(f"OK 凭据有效，账号下设备: {', '.join(body.get('devices', [])) or '(无)'}")

        elif args.cmd == "receipt":
            token, _ = resolve_credentials(args.token, None, need=True,
                                           need_user=False)
            body = check_receipt(token, args.receipt_id)
            if args.json:
                print(json.dumps(body, ensure_ascii=False, indent=2))
            else:
                _print_receipt(body)

    except PushoverError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
