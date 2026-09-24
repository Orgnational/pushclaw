# PushClaw

> 应用名与 GitHub 仓库均为 PushClaw/pushclaw（遵循 Pushover Open Client 命名规范：第三方客户端名称不得含 "Pushover"）；本地工作目录名保留 pushover-toolkit 不影响任何使用。

Pushover 收发命令行工具箱：**强提醒发送端 + 桌面接收端**，纯 Python 标准库（零第三方依赖），macOS / Windows 通用。

> 接收端基于 Pushover [Open Client API](https://pushover.net/api/client)，**非官方**实现，需账号持有桌面许可（一次性 $4.99）。

## 项目结构

```
pushover-toolkit/
├── pyproject.toml            # 打包元数据与入口（po-send / po-receive）
├── config.example.json       # 发送端凭据模板
├── src/
│   ├── pushover_sender.py    # 发送端：send / validate / receipt
│   └── pushover_receiver.py  # 接收端：login / register / run / history / ack / selftest
├── app/                      # 桌面端（Tauri）：窗口/托盘/原生通知
├── docs/
│   ├── SENDER.md             # 发送端详解（用例、参数速查、JS/curl 等价实现）
│   ├── RECEIVER.md           # 接收端详解（协议、DNS 兜底、行为边界、回归测试）
│   └── APP.md                # 桌面端详解（构建、Windows/CI、与 CLI 的关系）
├── tests/
│   └── test_receiver_e2e.py  # 端到端集成测试（模拟服务端，无需账号）
├── assets/                   # 图标与测试图片
└── tools/make_icon.py        # 图标生成脚本
```

## 安装

要求 Python ≥ 3.10（Windows: `winget install Python.Python.3.12`）。零依赖，装完即用：

```bash
# 方式一：从源码目录安装（推荐，得到全局命令 po-send / po-receive）
cd pushover-toolkit
pip install .

# 方式二：离线安装（把 dist/ 里的 wheel 拷到目标机器）
pip install dist/pushover_toolkit-*.whl

# 方式三：不安装直接跑
python3 src/pushover_sender.py --help
python3 src/pushover_receiver.py --help
```

## 快速上手

发送端（凭据配置见 `docs/SENDER.md`，三选一：命令行 / 环境变量 / `~/.config/pushover/config.json`）：

```bash
po-send validate                       # 校验凭据，列出账号下设备名
po-send "备份完成" -t "运维"            # 普通通知
po-send "prod-01 CPU 95%" -p 2         # 强提醒：所有设备响铃直到任意设备确认
po-send "报告" -i assets/test_chart.png --html   # 图片 + 富文本
```

接收端（把本机注册为一个 Pushover 设备，历史落地本地 SQLite，实时弹系统 toast）：

```bash
po-receive login you@example.com '密码'      # 开两步验证时按提示加 --twofa
po-receive register --name mac-air-desktop   # 每台机器用不同设备名
po-receive run                               # 常驻：实时收 → 入库 → toast
po-receive history --search 关键词            # 查历史（浏览器开 http://127.0.0.1:8899 看网页版全文）
```

发送端 `-d <设备名>` 与接收端设备名对应，实现定向推送；任意设备确认（ack）后全设备静默是服务器原生行为。

## 回归测试

```bash
po-receive selftest                        # ws 编解码 / ping-pong / 历史库（本地回环）
python3 -u tests/test_receiver_e2e.py      # 模拟服务端全链路 15 项断言（无需账号）
```

## 打包分发

```bash
# 本机构建产物（wheel + 源码包）
python3 -m pip install --quiet build && python3 -m build
# 产物在 dist/：pushover_toolkit-<版本>-py3-none-any.whl 与 .tar.gz
```

分发到新设备的步骤：

1. 目标机装好 Python ≥ 3.10
2. 拷贝 `dist/pushover_toolkit-*.whl`（或整个目录）
3. `pip install pushover_toolkit-*.whl`
4. 发送端：配凭据（`cp config.example.json ~/.config/pushover/config.json`）→ `po-send validate`
5. 接收端：`po-receive login ...` → `po-receive register --name <该机器的名字>` → `po-receive run`

> Windows 常驻建议：`start /b po-receive run`，或注册为计划任务开机自启；macOS 可用 LaunchAgent（Phase 2 计划内置）。

## 桌面端（独立应用）

不想跑命令行？桌面端（PushClaw）是独立应用：登录一次，托盘常驻，通知归属 "PushClaw"，点击通知直达历史窗口。见 [docs/APP.md](docs/APP.md)。

## 文档

- 发送端详解与参数速查：[docs/SENDER.md](docs/SENDER.md)
- 接收端协议细节、DNS 兜底、行为边界：[docs/RECEIVER.md](docs/RECEIVER.md)
