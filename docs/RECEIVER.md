# Python 接收端（已退役）

> **本文档描述的 Python CLI 接收端已被桌面端 PushClaw.app 完全替代**（v0.8.0 起 Python 栈退役）。
> 保留本文作为 Open Client API 协议细节与踩坑记录的参考。现行接收端见 [APP.md](APP.md)。

基于 [Open Client API](https://pushover.net/api/client) 的自建桌面接收端，**非官方**，要求账号持有桌面许可（一次性 $4.99）。零第三方依赖（纯 Python 标准库 3.10+），单文件 `pushover_receiver.py`。

## 功能

- **实时接收**：websocket 常驻 `wss://client.pushover.net/push`，`!` 信号即拉取，秒级到达
- **历史记录**：每条消息落地本地 SQLite（服务端队列会被删除，本地库才是档案），支持搜索/过滤/JSON 输出
- **系统 Toast**：macOS 优先 terminal-notifier（可点击、分组），兜底 osascript；Windows 优先 windows-toasts，兜底 PowerShell
- **紧急确认**：`ack` 确认 priority=2 消息，全设备静默（服务器原生同步）
- **设备区分**：每台机器注册为独立 Pushover 设备，对接发送端 `pushover_sender.py -d <设备名>`

## 首次设置

```bash
# 1. 登录（两步验证开启时加 --twofa 验证码；只缓存会话 secret，不存密码）
po-receive login you@example.com '你的密码'

# 2. 把本机注册为接收设备（名字自取，多台机器各取各的）
po-receive register --name mac-desktop

# 3. 先手动验证一次链路（不用 websocket）
po-receive sync
po-receive history

# 4. 常驻运行
po-receive run
```

运行中发一条测试消息（发送端）：`python3 pushover_sender.py send "hello receiver" -p 1`，接收端日志应显示"收到 1 条，新入库 1 条"，macOS 弹系统通知。

## 子命令速查

| 命令 | 作用 |
|---|---|
| `login <email> <password> [--twofa 码]` | 登录，缓存会话 secret 到 `~/.config/pushover/receiver.json`（权限 600） |
| `register --name <设备名>` | 注册本机为 os=O 接收设备；名字 ≤25 位 `[A-Za-z0-9_-]` |
| `run [--auto-clean] [--no-toast]` | 常驻：ws 实时收 → 落库 → toast；断线自动重连（3s 起指数退避） |
| `sync` | 手动拉取一次新消息入库（调试用） |
| `history [--limit N] [--search 词] [--priority 2] [--json]` | 查询本地历史 |
| `ack <receipt>` | 确认紧急消息（本地标记 + 服务端全设备静默） |
| `prune` | 让服务端删除本设备已拉取的队列（本地库不受影响） |
| `status` | 查看登录/注册/历史库状态 |
| `selftest` | 本地回环自测 ws 编解码、ping/pong、历史库读写（无需账号） |

## 数据位置

- 配置：`~/.config/pushover/receiver.json`（含会话 secret，勿外传）
- 历史：`~/.local/share/pushover/history.db`（SQLite，可直接用其他工具查询）

## 行为要点与边界

- **真机链路已验证**（2026-09-25，macOS）：发送 → 实时信号 → 拉取 → 入库 → toast 全通
- **DNS 兜底**：个别网络环境（VPN/代理 DNS、加密 DNS 描述文件）会让系统解析器对 `client.pushover.net` 返回 NXDOMAIN（本机真实发生过），而 `dig` 直查正常。接收端会自动降级：getaddrinfo 失败 → 经 1.1.1.1/8.8.8.8 的 DoH 拿 A 记录 → 按 IP 连接、SNI 用原域名
- **服务端队列 vs 本地历史**：Open Client 的服务器消息是"按设备队列"，`update_highest_message` 后即永久删除。默认 `run` **不删**服务端副本（`--auto-clean` 才删），这样换机重装时可重新拉取；本地库永远先落库再谈清理
- **客户端保活**：空闲 30 秒主动发一帧 `#`（与旧版 PythonClient 行为一致），持续 180 秒收不到服务端任何帧才判定死链重连
- **Toast 只弹新入库的消息**：重连后服务端重推的旧消息静默入库，不重复打扰
- **设备互踢**：同一设备名两个会话同时在线，后连者接管（ws `A` 帧），接收端会报错退出——两台机器务必用不同 `--name` 注册
- **重连**：断线后指数退避（3s 起，上限 60s）；`E` 帧为永久错误（需重新 login）
- **紧急消息**：priority=2 的重试由服务端驱动，与本接收端是否在线无关；`ack` 后全设备静默。发送端的 `receipt` 子命令可查确认状态
- **Toast 归属与点击**（v0.3.0）：通知由 CLI 接收端自建的 `PushoverToolkit.app` 小程序发出（CLI 场景沿用；桌面端 PushClaw 的通知归属为应用本体），不再出现"脚本编辑器"），**点击通知**会打开消息自带链接，无链接则打开本地历史网页对应条目。小程序由接收端自动构建（osacompile，位于 `~/.local/share/pushover/`）；**首次通知若没弹出，去 系统设置→通知→PushoverToolkit 允许一次**。降级链：applet → terminal-notifier → osascript。Windows 侧 `pip install windows-toasts` 后走 WinRT
- **本地历史网页**：`run` 时自动在 `http://127.0.0.1:8899`（仅本机可访问）提供深色主题的历史页面，全文渲染（html 消息按原始 HTML 渲染）、紧急/高优标记、消息链接可点、点击 toast 定位到对应条目（`#msg-<id>` 高亮）。端口可用 `--http-port` 或 `PUSHOVER_HTTP_PORT` 改
- **合规**：Open Client API 要求界面注明非官方、不用 Pushover 品牌、请求带 UA、运行在用户自己设备上

## 回归测试

```bash
po-receive selftest      # ws 编解码/ping-pong/历史库（本地回环）
python3 -u test_receiver_e2e.py            # 模拟服务端全链路 15 项断言（无需账号）
```

改代码后两个都要跑。另外历史上有过 tornado 版实现（`/Users/orgnational/PycharmProjects/pushover`），其两个做法被证实可用并吸收：secret/device_id 也可放 URL 查询参数（当前实现用登录帧，官方文档风格）；客户端定期发 `#` 保活。

## Phase 2 待办

- [ ] 托盘图标（mac rumps / win pystray）：退出开关、未读计数
- [x] Toast 点击动作：打开消息 url / 本地历史网页锚点；紧急消息"确认"按钮待做
- [x] 历史网页视图（localhost 单页，深色主题，:target 定位高亮）；搜索框待加
- [ ] 开机自启（mac LaunchAgent / win 计划任务）
