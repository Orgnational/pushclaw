# PushClaw 🐾

> 基于 [Pushover Open Client API](https://pushover.net/api/client) 的**非官方**桌面推送客户端 + CLI 收发工具箱。
> 应用名遵循官方命名规范（第三方客户端不得使用 "Pushover"）；本项目与 Pushover 官方无关，也未获其支持。
>
> 🤖 **本项目 100% 由 AI 开发**——架构设计、编码、测试、CI/CD 与发布全流程由 AI agent（ZCode + GLM）完成，人类负责需求定义、方向决策与验收。

![release](https://img.shields.io/badge/release-v0.13.0-blue) ![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey) ![desktop deps](https://img.shields.io/badge/desktop%20deps-rust%20%2B%20系统WebView-success) ![cli](https://img.shields.io/badge/CLI-Rust%20%28clap%29-informational) ![tests](https://img.shields.io/badge/tests-5%20suites%20%2B%20guard-green)

PushClaw 把 Pushover 变成一条**完全属于自己的通知通道**：桌面端常驻托盘收发一体，原生系统通知归属应用本体，历史消息落本地 SQLite 可搜索、可归档、跨设备已读同步；Rust CLI 与桌面端共用协议层与凭据，一条命令搞定富文本、图片附件和强提醒。

## ✨ 桌面端（PushClaw.app）

**接收**
- **实时**：WebSocket 常驻 + 增量同步（服务端队列自动清理）；DNS 异常自动降级 DoH，实测启动到连接 ~1.2s
- **原生通知**：归属显示 PushClaw；点击通知/Dock 激活 → 窗口定位到该消息
- **紧急消息**：priority=2 到达自动弹窗 + 常驻红色横幅，直至手动确认（官方指南要求）
- **通知过滤**：按应用静音、免打扰时段（跨午夜，紧急消息豁免）

**已读同步（跨设备）**
- 未读红点 / 已读变灰；打开详情即已读
- 任一设备标记已读 → 其它设备自动同步（静默信令协议，官方无公开端点，详见 docs/APP.md）

**历史管理**
- 消息/归档双标签、优先级筛选、关键词搜索
- 多选批量删除/归档（两步确认防误删）、便签式详情（富文本全文/确认/归档/删除）
- 消息应用图标显示（官方图标端点 + 本地缓存）

**发送（GUI）**
- 发送视图：标题/正文（HTML 富文本）/优先级/图片附件/深链/设备下拉（自动列出账号设备）
- 登录视图可选填 API Token，一次登录完成收发配置

**设置**
- 账户信息（设备/邮箱/版本）、Toast/提示音开关、免打扰时段
- 按应用静音列表、发送凭据（自动带出 CLI 配置）+ 测试发送

**可靠性**
- 托盘常驻（图标按钮 + 悬停提示）；关窗不退出
- E 帧（异常冷却）自动同名重注册自愈；HTTP 全链路超时；锁中毒自恢复
- 官方合规：非官方声明、`A` 帧不自动重连、启动不重放旧通知、拉取后清理队列

## ⌨️ CLI（Rust，与桌面端共用协议层与凭据）

| 命令 | 说明 |
|---|---|
| `pushclaw send` | 发送：富文本、图片附件（≤5MB）、**强提醒**（priority=2，任意设备确认全设备静默）、定向设备、TTL、23 种音效；`send -` 读 stdin 管道 |
| `pushclaw validate` | 校验凭据、列出账号下设备名 |
| `pushclaw receipt <id>` | 查询紧急消息确认状态（谁确认的、何时） |

凭据链：环境变量 → `~/.config/pushover/config.json` → 桌面端设置页（settings.json）→ 会话兜底，装好即用。

## 📦 安装

**桌面端**（从 [Releases](https://github.com/Orgnational/pushclaw/releases) 下载）：

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS (Apple Silicon) | `PushClaw-x.y.z-macos-arm64.zip` | 解压拖入 /Applications；未公证，首次打开需右键 → 打开 |
| Windows | `PushClaw-x.y.z_x64-setup.exe` | NSIS 安装器；通知归属依赖安装器创建的快捷方式 |

**CLI**（同 Release 页，如 `pushclaw-cli-x.y.z-macos-arm64`，放进 PATH 即可）

**首次使用**：

1. [pushover.net](https://pushover.net) 注册账号、[创建应用](https://pushover.net/apps/build)拿 API Token（接收端需桌面许可 $4.99，一次性）
2. 桌面端：登录视图填邮箱/密码（可选两步验证 + API Token）→ 设备名填**这台机器独有的名字**
3. CLI 凭据与桌面端互通，配置过任一处即可：`pushclaw validate` 验证
4. 测试：`pushclaw send "hello" -d <你的设备名>`

## 🛠 从源码构建

```bash
# 依赖：Node ≥18、Rust（rustup）、macOS 需 Xcode CLT / Windows 需 MSVC Build Tools
cd app && npm install
npx tauri build --bundles app     # macOS → .app
npx tauri build --bundles nsis    # Windows → setup.exe
cargo build --release --bin pushclaw-cli   # CLI（app/src-tauri/ 下）
```

## ✅ 测试防线

| 防线 | 拦截的事故类型 |
|---|---|
| `tests/test_id_consistency.mjs` | HTML↔JS 元素、invoke↔命令注册不一致（首跑即捕获发送视图未注册事故） |
| `tests/settings_fields.rs` | 结构体漏字段（序列化方向） |
| `tests/save_settings_schema.rs` | serde 必填字段拒绝保存（反序列化方向） |
| `tests/login_flow.rs` / `send_flow.rs` | 协议层卡死、multipart 丢失（内嵌 mock） |
| `tests/test_ui_logic.mjs` | 前端交互逻辑回归（jsdom 13 项） |

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)：分支 → 四阶段验证 → 合并 → tag 发布。

## 🏷 版本发布（自动化）

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

GitHub Actions 自动：双平台构建 → 从 tag 同步版本号 → Release 附 macOS zip + 双平台 CLI + Windows 安装器。

## 📁 项目结构

```
pushclaw/
├── app/                      # Tauri 2：桌面端 + CLI 双二进制，共用 pushclaw_core 库
│   ├── src-tauri/src/        #   pushover.rs(协议) store.rs(存储) commands.rs(命令) main.rs(GUI) bin/pushclaw.rs(CLI)
│   ├── src-tauri/tests/      #   Rust 集成测试（4 个防线文件）
│   └── ui/                   #   index.html + app.js + style.css（自写设计系统，无框架）
├── tests/                    # jsdom 交互测试 + id/命令一致性扫描
├── docs/                     # APP.md(桌面端) / CLI.md(命令行)
├── tools/make_icon.py        # 图标生成
└── .github/workflows/        # tag → 双平台构建 → Release
```

## ⚖️ 合规声明

本项目是**非官方** Pushover Open Client，按[官方分发指南](https://pushover.net/api/client)实现：应用名不含 "Pushover"、界面明确披露非官方身份、不使用官方 Logo、全部功能运行在用户自己的设备上。使用本工具需要有效的 Pushover 账号及桌面许可（$4.99，一次性）。

## License

MIT
