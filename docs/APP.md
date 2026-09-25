# PushClaw 桌面端（Tauri）

> 应用名 PushClaw 遵循官方命名规范；本页所述 Tauri 桌面端即 tray/Dock 里的 PushClaw.app

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
- **原生通知**：归属显示 "PushClaw"（应用本体，非脚本/借用进程）；点击通知/Dock 激活 → 窗口打开并定位最新消息
- **历史管理**（v0.5.0）：消息/归档双标签页；优先级筛选（全部/!紧急/↑高优）与搜索叠加；**选择模式**支持多选 + 全选 + 批量归档/恢复/删除（删除两步确认）；点击卡片弹出**便签式详情**（米黄便签卡：富文本全文、元信息、打开链接、确认 ack、归档/恢复、删除）
- **托盘**：专用白色爪痕图标（模板模式，自适应深浅色菜单栏）；左键显示/隐藏窗口；菜单：显示主窗口 / 立即同步 / 退出；关窗即隐藏不退出
- **保活**：空闲 30s 发 `#`；180s 无帧重连；断线指数退避（3s→60s）；重新登录自动换会话
- **E/A 帧自愈**：进程被强杀后重连，服务端会对该设备短暂返回 `E`（REST 不受影响）；应用按 60s 退避重试即可恢复。若持续 'E'，在 pushover.net 设备页删除该设备后在应用里用同名重新登录
- **设备名不唯一**：同名重新注册会生成新 device_id，旧条目需在官网设备页手动清理（账户上限 10 台）

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

产物：`app/src-tauri/target/release/bundle/macos/PushClaw.app`（~8.6MB）

> DMG 打包（`--bundles dmg`）依赖 Finder AppleScript，终端环境下可能报 bundle_dmg.sh 失败；用 `.app` 直接分发（zip）或在本机 Finder 授权后重试。

## 从源码构建（Windows）

```powershell
# 依赖：Node LTS、MSVC Build Tools（VS Installer 勾选 C++ 桌面开发）、rustup
cd app
npm install
npx tauri icon icon_1024.png
npx tauri build --bundles msi     # 产出 .msi 安装包
```

无 Windows 机器时可用 CI 构建：仓库已带 `.github/workflows/build.yml`（push tag 自动产出 macOS .app zip + CLI 二进制、Windows .msi 的 Release 附件）。

## 与 CLI 的关系

- `pushclaw` CLI（Rust，同仓库同协议层）负责脚本/自动化发送与回执查询，用法见 [CLI.md](CLI.md)
- 桌面端与 CLI 凭据互通：CLI 直接读取桌面端会话配置，零重复配置
- 发送定向：`pushclaw send ... -d mac-air-desktop` 照常使用（设备名唯一、≤10 台/账号）
