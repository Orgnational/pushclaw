# Open Client 合规核查清单

> **使用规则**：凡是登录/收信/发送/注册出现异常，**排查代码之前先逐条核对本表**
> （并重读 https://pushover.net/api/client 原文——规范可能更新）。
> 本表依据 2026-09-27 抓取的官方文档整理。

## 登录 / 注册流程

- [ ] 端点与参数：`POST /1/users/login.json`，`email`/`password`（均区分大小写）
- [ ] 412 → 两步验证：用**相同邮箱密码 + `twofa` 参数**重发（不要只发验证码）
- [ ] 成功响应字段：`id`（=user_key）、`secret`（会话密钥，每次登录唯一）
- [ ] secret 不跨设备复用；密码用后即弃；secret/user_key/device_id 安全存储
- [ ] 注册：`POST /1/devices.json`，`secret` + `name`（`[A-Za-z0-9_-]` ≤25 位）+ `os="O"`
- [ ] 顺序强制：先登录拿 secret，才能注册；注册后才能拉消息/连 ws
- [ ] 服务端 4xx 拒绝（如 name "has already been taken"）→ **直接呈现给用户，不自动重试**

## WebSocket

- [ ] 认证帧：`login:<device_id>:<secret>\n`（连接 wss://client.pushover.net/push 后发送）
- [ ] 帧：`#`心跳（无需回应）/ `!`新消息→触发拉取 / `R`重连 / `E`永久错误→提示重新登录，**不自动重连** / `A`他处接管→**不自动重连**
- [ ] 失败的 ws 登录：服务端会以错误帧关闭连接

## 消息处理

- [ ] 附件仅图片 ≤5MB（bmp/gif/jpeg/png/tiff），`POST` multipart
- [ ] 应用图标从 /icons/<name>.png 获取，**必须本地缓存**，图标名变化才重新获取
- [ ] 音效 mp3 同样必须缓存
- [ ] 无标题时显示发送应用名
- [ ] `html=1` 按 HTML 渲染，否则纯文本；尊重 `url`/`url_title`/`date`/`priority`/`sound`
- [ ] `umid` 用于跨设备消息识别（我们用于已读同步）
- [ ] 拉取后用 update_highest_message 删除服务端消息
- [ ] 启动时下载积压消息，但**抑制旧消息的通知**（避免启动刷屏）

## 紧急消息（priority=2）

- [ ] 按 retry/expire 重复提醒，直至用户**手动确认**（不能超时自动消失）
- [ ] 确认 = 用户主动动作后 POST acknowledge（带 secret）

## 分发红线（不可违反）

- [ ] 应用名不含 "Pushover"；不使用官方 Logo
- [ ] 界面明确声明非官方 Open Client、与官方无关
- [ ] 全部功能运行在用户自己的设备上（无服务器代收代发）
- [ ] 不得代多个用户操作同一账号（组/订阅除外）
- [ ] 每个 HTTP 请求带可识别 User-Agent（应用名+版本）
- [ ] 网络错误不无延迟重试；失败的 ws 登录等一段时间再重连

## 历史事故对照

| 事故 | 本表对应条目 |
|---|---|
| set-toast 元素丢失（设置页全灭） | （结构性）HTML↔JS id 一致性测试 |
| AppSettings 缺 email 字段（邮箱空白） | （结构性）序列化字段完整性测试 |
| 重试循环覆盖服务端 4xx 拒绝 | 本表"登录/注册流程"末条 |
