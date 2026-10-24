# 测试体系规则（2026-10-19 整改后）

> 起因：一天之内连抓三个存活数周的 bug——消息列表永远空（v0.12.0 起，
> SQL 列数漂移）、发送按钮死按钮（v0.11.0 起，事件从未绑定）、登录/设置
> 死锁（v0.14.x）。每一个都活在测试盲区。病根：**所有测试都在验"零件"
> （各自 mock 输入输出），没有任何环节强制"真实组装链"被执行**。

## 铁律（违反即不予合并/发布）

1. **mock-only ≠ 验收**。任何"测试通过"必须包含真实执行链证据。
2. **新命令必须真路径测试**：tauri::test mock 运行时直调 `commands::*`
   （参照 tests/login_real_path.rs / commands_real_path.rs），断言真实副作用
   （落盘文件/内存态），而不是 mock invoke 的返回值。
3. **新按钮必须点击链测试**：jsdom dispatch click → 断言 invoke 被携带
   正确参数调用（tests/test_send_button.mjs 模式）。test_id_consistency.mjs
   的死按钮扫描是静态兜底，不替代点击测试。
4. **存储函数必须真 SQLite 测试**（tests/store_full.rs 模式）；列清单
   变更必须同步 row_to_msg 与全部查询 SQL——store_query.rs 的列数断言
   会在漂移时立刻红。
5. **发版前 `sh tests/run_all.sh` 全绿**；真机验收项（登录跳转/设置页
   凭据显示/发送到达）由验收人执行，自动化不豁免。

## 覆盖矩阵（2026-10-19 现状）

### 命令层（20 个注册）
| 覆盖 | 命令 |
|---|---|
| 真路径 | login, get_settings, save_settings, logout, send_message, list_devices, mark_read, mark_all_read, history, get_message, delete_messages, archive_messages, list_apps, get_status |
| 协议层/其它 | ack（网络+库写，未直测）、register_device（NAME_TAKEN 分支协议层有测）、sync_now（=fetch_and_store ✓）、send_test（=send_message ✓）、get_icon（磁盘缓存+HTTP）、open_url（OS 壳） |

### 存储层（9 函数）
全部真 SQLite 覆盖（tests/store_full.rs + store_query.rs）：
insert 去重 / query 列数 / get / mark_read_by_umids 幂等 / unread_umids /
unread_count / delete_ids / set_archived / distinct_apps / 老库迁移。

### 接收核心
fetch_and_store 全管线真执行（tests/fetch_store_real.rs）：拉取→分区
（普通 vs 已读信令）→入库→已读应用→prune→latest_new。
ws_loop 重连逻辑为长时行为，由真机验收覆盖。

### 点击链（jsdom ×6 文件）
登录表单/跳转、设置加载与保存、发送按钮、退出两步确认、
选择/归档/删除/筛选流、紧急横幅 ack。

### 静态防线
- tests/test_lock_discipline.py：同语句多重锁 / borrow 实参 / 跨 await 持锁
- tests/test_id_consistency.mjs：id 对齐 / 命令注册 / 死按钮扫描

## 已知边界（如实记录，不装作覆盖）
- ws_loop 的网络级重连/E 帧/A 帧时序：集成测试无法稳定模拟服务端行为，
  依赖真机验收 + stderr 观测日志
- 通知弹出（OS 层）：mock 运行时无插件，管线测试关闭 toast
- Windows 特有路径：CI 构建后人工验收
