# 参数数据流权威表

> v0.14.2 起，所有参数遵循本表。**新增/移动任何参数前先更新此表**——
> "什么参数、哪里填、存哪里、哪里用"必须有且只有一处权威答案。

## 数据源规则（只有三个文件，各司其职）

| 文件 | 内容 | 谁写 | 谁读 |
|---|---|---|---|
| `app.json`（data_dir） | 会话五元组：email / user_key / secret / device_id / device_name | 仅 `login` 成功时整体写入；`logout` 删除 | ws 线程、get_status、E 帧自愈 |
| `settings.json`（data_dir） | 发送凭据（send_token / send_user）+ 通知偏好 | `login`（user_key 无条件、token 可选）、设置页保存 | 发送命令、通知过滤、设置页 |
| `history.db`（data_dir） | 消息档案（含 app/icon/read 等派生列） | ws 拉取入库 | 列表/搜索/静音清单 |

**已废除**：`~/.config/pushover/config.json` 回落（v0.14.2）——Python 栈残留的第三数据源，
Windows 上不存在导致展示不一致；CLI 的 config.json 归 CLI 自用，与 GUI 互不读写。

## 参数四线表

### 会话参数（app.json，登录一次性产生）

| 参数 | 产生 | 设置页展示 | 使用点 |
|---|---|---|---|
| email | users/login.json 返回 | 「账户·邮箱」 | 仅展示 |
| user_key | users/login.json 返回 | （经 settings.send_user 展示） | 发送命令的 user |
| secret | users/login.json 返回 | 不展示（敏感） | ws 登录帧、register、ack、fetch、prune |
| device_id | devices.json 注册返回 | 不展示 | ws 登录帧、fetch、prune |
| device_name | 登录表单填写（required 校验） | 「账户·设备名」 | E 帧同名重注册 |

### 发送凭据（settings.json）

| 参数 | 填入途径 | 设置页展示 | 使用点 |
|---|---|---|---|
| send_user | **登录成功即无条件写入**（v0.14.2 起）；存量安装由 get_settings 从会话自愈补齐 | 「发送凭据·User Key」 | send_message / send_test / list_devices / broadcast_read_sync |
| send_token | 登录页可选字段（校验 30 位，在登录动作**之前**，失败零副作用）或设置页补填 | 「发送凭据·API Token」 | 同上 |

发送命令统一走 `resolve_send_creds`：**只读 settings.json**，缺任一项报错提示去设置页。

### 通知偏好（settings.json，全部有真实使用点）

| 参数 | 缺省 | 展示 | 使用点 |
|---|---|---|---|
| toast | true | 通知开关 | fetch_and_store 弹通知过滤 |
| quiet_enabled / start / end | 关 | 免打扰时段 | fetch_and_store（priority=2 豁免，跨午夜支持） |
| muted_apps | 空 | 按应用静音清单 | fetch_and_store 按应用过滤 |

**已移除**：notify_sound（v0.14.2）——曾是无任何使用点的假开关；系统通知声音由操作系统
通知设置控制，应用层无 API 可关。旧 settings.json 残留字段由 serde 忽略未知字段兼容。

### 只读展示（get_settings 现算，不落盘）

version（编译期 env!）/ device_name / email（从内存会话读）——由 tests/settings_fields.rs
防线保证序列化不缺字段（v0.9.1 漏 email 历史事故）。

## 生命周期

- **登录**：单步式 `login_and_register`（登录+注册一条命令）→ 全部成功才写 app.json
  → user_key 无条件写 settings.json → 通知 ws 线程。任一步失败 = 零副作用。
- **登出**：内存会话清空 + 删 app.json。settings.json（凭据与偏好）保留。
- **升级兼容**：settings.json 的旧/多余字段 serde 静默忽略；坏会话（device_id 空）
  被 get_status 判为未配置、被 ws_loop 拒连 → 用户重新登录即覆盖。

## 历史缺口（v0.14.2 审计修复，防复发）

1. user_key 曾仅在与 token 同填时才入库——不填 token 就丢弃已拿到的 user_key（登录链路绑定错误）
2. CLI config.json 第三数据源回落——Windows 上不存在，设置页展示不一致
3. notify_sound 假开关——设置页可切换但从未接入通知路径
4. token 校验曾放在 save_session 之后——校验失败报错但登录实际已成功（状态分裂）
