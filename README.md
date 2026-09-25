# PushClaw 🐾

> 基于 [Pushover Open Client API](https://pushover.net/api/client) 的**非官方**桌面推送客户端 + CLI 收发工具箱。
> 应用名遵循官方命名规范（第三方客户端不得使用 "Pushover"）；本项目与 Pushover 官方无关，也未获其支持。

![release](https://img.shields.io/badge/release-v0.7.2-blue) ![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey) ![desktop deps](https://img.shields.io/badge/desktop%20deps-rust%20%2B%20系统WebView-success) ![cli deps](https://img.shields.io/badge/cli%20deps-零第三方-orange)

PushClaw 把 Pushover 变成一条**完全属于自己的通知通道**：桌面端常驻托盘实时收信，原生系统通知归属应用本体，历史消息落本地 SQLite 可搜索、可归档；CLI 发送端一条命令搞定富文本、图片附件和强提醒。

## ✨ 桌面端（PushClaw.app）

- **实时接收**：WebSocket 常驻 + 增量同步（服务端队列自动清理，不重复传输）；DNS 异常自动降级 DoH（1.1.1.1/8.8.8.8），实测启动到连接 ~1.2s
- **原生通知**：归属显示 PushClaw（应用本体）；点击通知/Dock 激活 → 窗口定位到该消息
- **紧急消息合规处理**：priority=2 到达时自动弹出窗口 + 页内常驻红色横幅，直至手动确认（官方指南要求）
- **历史管理**：消息/归档双标签页、优先级筛选、关键词搜索、多选批量删除/归档（两步确认防误删）、19 位大 id 全程字符串传递无精度丢失
- **便签式详情**：点击卡片弹出米黄便签——富文本全文、元信息、打开链接、紧急确认（全设备静默）
- **托盘常驻**：左键显示/隐藏，关窗不退出；E 帧（异常冷却）自动同名重注册自愈
- **官方合规**：非官方声明常驻页脚、`A` 帧不自动重连、启动不重放旧通知、拉取后清理服务端队列

## ⌨️ CLI（零第三方依赖，纯 Python 标准库）

| 命令 | 说明 |
|---|---|
| `po-send` | 发送：富文本（5 标签 HTML）、图片附件（≤5MB）、**强提醒**（priority=2，任意设备确认全设备静默）、定向设备、TTL、23 种音效 |
| `po-receive` | 接收端（SSH/无 GUI 场景）：实时收 + SQLite 历史 + 系统 toast |
| `po-send validate` | 校验凭据、列出账号下设备名 |
| `po-send receipt <id>` | 查询紧急消息确认状态（谁确认的、何时） |

## 📦 安装

**桌面端**（从 [Releases](https://github.com/Orgnational/pushclaw/releases) 下载）：

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS (Apple Silicon) | `PushClaw-x.y.z-macos-arm64.zip` | 解压拖入 /Applications；未公证，首次打开需右键 → 打开 |
| Windows | `PushClaw_x.y.z_x64_en-US.msi` | 双击安装；通知归属依赖安装器创建的快捷方式 |

**CLI**：

```bash
pip install pushover_toolkit-0.3.1-py3-none-any.whl   # 离线 wheel（dist/ 或 Release）
# 或从源码：pip install .
```

**首次使用**：

1. [pushover.net](https://pushover.net) 注册账号、[创建应用](https://pushover.net/apps/build)拿 API Token（接收端需桌面许可 $4.99，一次性）
2. 桌面端：打开 PushClaw → 登录视图填邮箱/密码（可选两步验证）→ 设备名填**这台机器独有的名字**
3. CLI：`cp config.example.json ~/.config/pushover/config.json` 填入 token/user → `po-send validate`
4. 测试：`po-send "hello" -d <你的设备名>`

## 🛠 从源码构建

```bash
# 依赖：Node ≥18、Rust（rustup）、macOS 需 Xcode CLT / Windows 需 MSVC Build Tools
cd app && npm install
npx tauri build --bundles app     # macOS → .app
npx tauri build --bundles msi     # Windows → .msi
```

## 🏷 版本发布（自动化）

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

GitHub Actions 自动完成：双平台构建 → 从 tag 同步版本号（单一事实来源）→ 创建 Release 并附上 mac zip + win msi。

## 📁 项目结构

```
pushclaw/
├── app/                      # 桌面端（Tauri 2：Rust 后端 + 原生 JS 前端）
│   ├── src-tauri/src/        #   pushover.rs(协议) store.rs(存储) commands.rs(命令) main.rs(壳)
│   └── ui/                   #   index.html + app.js + style.css（自写设计系统）
├── src/                      # CLI：pushover_sender.py / pushover_receiver.py（纯标准库）
├── docs/                     # APP.md / RECEIVER.md / SENDER.md 详解
├── tests/                    # E2E（模拟服务端 15 项）+ 前端逻辑回归（jsdom 13 项）
├── assets/  tools/           # 图标与生成脚本
└── .github/workflows/        # tag → 双平台构建 → Release
```

## ⚖️ 合规声明

本项目是**非官方** Pushover Open Client，按[官方分发指南](https://pushover.net/api/client)实现：应用名不含 "Pushover"、界面明确披露非官方身份、不使用官方 Logo、全部功能运行在用户自己的设备上。使用本工具需要有效的 Pushover 账号及桌面许可（$4.99，一次性）。

## License

MIT
