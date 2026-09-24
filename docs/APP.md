# Pushover Toolkit 桌面端（Tauri）

独立的跨平台桌面应用：**自己的窗口 + 托盘 + 原生系统通知（归属应用本体）**，macOS / Windows 单一安装包。

```
app/
├── package.json           # Tauri CLI 入口（npm run tauri）
├── icon_1024.png          # 图标源（tools/make_icon.py 1024 生成）
├── ui/                    # 前端：index.html + app.js + style.css（无框架，原生 JS）
└── src-tauri/
    ├── src/main.rs        # 应用壳：托盘、关窗隐藏、通知点击激活（Reopen）
    ├── src/pushover.rs    # 协议：login/register/fetch/ack + ws 实时通道
    ├── src/store.rs       # SQLite 历史库 + 会话持久化
    ├── src/commands.rs    # 前端 invoke 的命令层
    └── tauri.conf.json    # 打包与窗口配置
```

## 功能

- **登录视图**：邮箱+密码（支持两步验证），登录即注册本机为 Open Client 设备（`os=O`）
- **实时接收**：ws 常驻 `wss://client.pushover.net/push`，`!` 信号即拉取；**服务器发的是单字节 Binary 帧**（这是初版漏收的坑，Text/Binary 双兼容）
- **原生通知**：归属显示 "Pushover Toolkit"（应用本体，非脚本/借用进程）；点击通知/Dock 激活 → 窗口打开并定位最新消息
- **历史窗口**：深色卡片列表、搜索、富文本渲染、priority 标记；priority=2 消息带"确认（全设备静默）"按钮
- **托盘**：左键点击显示/隐藏窗口；菜单：显示主窗口 / 立即同步 / 退出；关窗即隐藏不退出
- **保活**：空闲 30s 发 `#`；180s 无帧重连；断线指数退避（3s→60s）；重新登录自动换会话

## 数据位置（与 CLI 版独立，可并存但设备名必须不同）

- 应用历史库：`~/Library/Application Support/pushover/history.db`
- 应用会话：`~/Library/Application Support/pushover/app.json`（0600）

## 从源码构建（macOS）

要求：Node ≥ 18、Rust（`curl https://sh.rustup.rs | sh -s -- -y --profile minimal`）、Xcode CLT。

```bash
cd app
npm install
npx tauri icon icon_1024.png      # 图标全套（已生成则跳过）
npx tauri build --bundles app     # 产出 .app
```

产物：`app/src-tauri/target/release/bundle/macos/Pushover Toolkit.app`（~8.6MB）

> DMG 打包（`--bundles dmg`）依赖 Finder AppleScript，终端环境下可能报 bundle_dmg.sh 失败；用 `.app` 直接分发（zip）或在本机 Finder 授权后重试。

## 从源码构建（Windows）

```powershell
# 依赖：Node LTS、MSVC Build Tools（VS Installer 勾选 C++ 桌面开发）、rustup
cd app
npm install
npx tauri icon icon_1024.png
npx tauri build --bundles msi     # 产出 .msi 安装包
```

无 Windows 机器时可用 CI 构建：仓库已带 `.github/workflows/build.yml`（push tag 同时产出 mac .app/.dmg 与 win .msi 的 Release 附件）。

## 与 CLI 版的关系

- CLI（`po-send`/`po-receive`）保留：发送端日常用 `po-send`；接收端适合 SSH/服务器场景
- 应用端与 CLI 接收端**各注册一台设备**（如 `mac-app` 与 `mac-air-desktop`），可同时在线
- 发送端定向：`po-send "..." -d mac-app` 只让应用所在的机器响
