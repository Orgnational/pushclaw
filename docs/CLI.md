# CLI（pushclaw）

`pushclaw` 是 Rust 版命令行（与桌面端共用协议层），适合脚本与自动化场景。

## 子命令

### send

```bash
pushclaw send "消息正文"                            # 广播到账号全部设备
pushclaw send "消息" -t 标题 -d mac-air-desktop     # 定向设备
pushclaw send "<b>加粗</b>" --html                  # 富文本（5 标签白名单）
pushclaw send "告警" -p 2 --retry 30 --expire 600   # 强提醒（任一设备确认全静默）
pushclaw send "报告" -i 图表.png                    # 图片附件（≤5MB）
pushclaw send "工单" --url "myapp://x/1" --url-title "打开"
pushclaw send "临时" --ttl 1800                     # 到期自动消失
pushclaw send ... --json                            # 机器可读输出
```

### validate

```bash
pushclaw validate          # 校验凭据，列出账号下设备名
pushclaw validate --device mac-air-desktop
```

### receipt

```bash
pushclaw receipt <send 返回的 receipt-id>   # 紧急消息确认状态（谁/何时）
```

## 凭据解析顺序

`PUSHOVER_TOKEN`/`PUSHOVER_USER` 环境变量 → `~/.config/pushover/config.json`（token/user）→ 桌面端会话 `app.json`（user_key 兜底）。回执查询仅需 token。

## 与桌面端的关系

同一协议层（app/src-tauri/src/pushover.rs）：CLI 负责脚本/自动化场景的发送与查询，桌面端负责交互式收发。设备名约束见 [APP.md](APP.md)（唯一、≤10 台/账号）。
