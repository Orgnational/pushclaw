//! Tauri 命令层：前端 invoke 的入口。

use crate::pushover;
use crate::store::{self, Msg, Session};
use crate::AppState;
use serde::Serialize;
use tauri::Emitter;
use std::sync::atomic::Ordering;

#[derive(Serialize)]
pub struct Status {
    pub configured: bool,
    pub email: String,
    pub device_name: String,
    pub connected: bool,
    pub db_path: String,
    pub version: String,
    pub device_registered: bool,
}

#[tauri::command]
pub async fn get_status(state: tauri::State<'_, AppState>) -> Result<Status, String> {
    let sess = state.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    // device_id 为空的会话视为未配置（两步式残留的坏会话），要求重新登录
    let configured = sess.as_ref()
        .map(|s| !s.device_id.is_empty())
        .unwrap_or(false);
    let device_registered = configured;
    Ok(Status {
        configured,
        email: sess.as_ref().map(|s| s.email.clone()).unwrap_or_default(),
        device_name: sess.as_ref().map(|s| s.device_name.clone()).unwrap_or_default(),
        connected: state.connected.load(Ordering::Relaxed),
        db_path: store::db_path().display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        device_registered,
    })
}

#[tauri::command]
pub async fn login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    email: String,
    password: String,
    twofa: Option<String>,
    device_name: String,
    send_token: Option<String>,
) -> Result<(), String> {
    // 可选发送凭据：先校验再登录（校验失败不产生任何副作用——
    // 此前放在 save_session 之后，报错时登录实际已成功，状态分裂）
    let send_token = send_token.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if let Some(tk) = send_token {
        if tk.chars().count() != 30 {
            return Err("API Token 应为 30 位字符，请检查后重试".into());
        }
    }
    // 单步式（回滚）：登录 + 注册设备一次完成——这是实测能注册成功的形态。
    // 网络层修复保留在 login_and_register 内部（退避重试 / NAME_TAKEN 备用名 /
    // 连接池加固 / 错误分类）。
    let sess = crate::pushover::login_and_register(
        &email, &password, twofa.as_deref(), &device_name,
    )
    .await
    .map_err(|e| e.to_string())?;
    eprintln!("[login] ③ 保存会话...");
    store::save_session(&sess).map_err(|e| e.to_string())?;
    // 发送凭据：user_key 登录即得，无条件入库（设置页 User Key 永不为空）；
    // token 可选，填了才具备发送身份
    {
        let mut st = state.settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
        st.send_user = sess.user_key.clone();
        if let Some(tk) = send_token {
            st.send_token = tk.to_string();
        }
        store::save_settings(&st).map_err(|e| e.to_string())?;
        *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = st;
        eprintln!("[login] 发送凭据已保存（user 无条件 / token 可选）");
    }
    let device_name_for_event = sess.device_name.clone();
    *state.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sess);
    eprintln!("[login] ④ 通知 ws 线程...");
    // 拆开求值顺序：写成 send(*borrow() + 1) 时 borrow 的读锁守卫存活到语句末，
    // send 内部取写锁 → 同线程读/写锁自死锁（登录回执永不返回的根因）
    let ver = *state.session_tx.borrow() + 1;
    let _ = state.session_tx.send(ver);
    eprintln!("[login] ⑤ 完成，返回前端");
    // 双保险：invoke 返回链路异常时，事件仍能驱动前端切换视图
    let _ = app.emit("login-success", device_name_for_event);
    Ok(())
}

#[tauri::command]
pub async fn history(
    state: tauri::State<'_, AppState>,
    query: Option<String>,
    limit: Option<i64>,
    priority: Option<i64>,
    archived: Option<bool>,
) -> Result<Vec<Msg>, String> {
    let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(store::query(
        &db,
        query.as_deref(),
        limit.unwrap_or(200),
        priority,
        archived.unwrap_or(false),
    ))
}

#[tauri::command]
pub async fn get_message(state: tauri::State<'_, AppState>, id: String) -> Result<Option<Msg>, String> {
    let Ok(id) = id.parse::<i64>() else {
        return Err("非法消息 id".into());
    };
    let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(store::get(&db, id))
}

#[tauri::command]
pub async fn delete_messages(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let ids = ids
        .iter()
        .map(|s| s.parse::<i64>().map_err(|e| format!("非法 id: {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(store::delete_ids(&db, &ids))
}

#[tauri::command]
pub async fn archive_messages(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    archived: bool,
) -> Result<usize, String> {
    let ids = ids
        .iter()
        .map(|s| s.parse::<i64>().map_err(|e| format!("非法 id: {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(store::set_archived(&db, &ids, archived))
}

#[tauri::command]
pub async fn ack(
    state: tauri::State<'_, AppState>,
    receipt: String,
) -> Result<(), String> {
    let secret = {
        let sess = state.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        sess.map(|s| s.secret)
            .ok_or_else(|| "尚未登录".to_string())?
    };
    pushover::acknowledge(&secret, &receipt)
        .await
        .map_err(|e| e.to_string())?;
    {
        let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = db.execute(
            "UPDATE messages SET acked=1 WHERE receipt=?1",
            rusqlite::params![receipt],
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn logout(state: tauri::State<'_, AppState>) -> Result<(), String> {
    // 异步命令：避免同步命令占用主线程与 webview IPC 交互导致的冻结
    eprintln!("[logout] 开始");
    {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }
    let path = store::data_dir().join("app.json");
    match std::fs::remove_file(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    // 同 login：borrow 守卫必须先释放再 send，否则同线程读写锁自死锁
    let ver = { *state.session_tx.borrow() + 1 };
    let _ = state.session_tx.send(ver);
    eprintln!("[logout] 完成（会话版本 {ver}）");
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub send_token: String,
    #[serde(default)]
    pub send_user: String,
    #[serde(default)]
    pub toast: bool,
    // notify_sound 已移除（v0.14.2）：曾是无任何使用点的假开关——
    // 系统通知声音由操作系统通知设置控制，应用层无 API 可关
    #[serde(default)]
    pub quiet_enabled: bool,
    #[serde(default)]
    pub quiet_start: String,
    #[serde(default)]
    pub quiet_end: String,
    #[serde(default)]
    pub muted_apps: Vec<String>,
    /// 只读展示字段：前端保存时不回传，反序列化给缺省
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub email: String,
}

#[tauri::command]
pub async fn get_settings(state: tauri::State<'_, AppState>) -> Result<AppSettings, String> {
    let mut st = state.settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
    // User Key 自愈：v0.14.1 前登录未无条件入库，存量安装的 settings.json 里
    // send_user 可能为空——用当前会话的 user_key 补齐并持久化。
    // 凭据单一来源 settings.json，不再回落 Python 栈残留的 CLI config.json
    if st.send_user.is_empty() {
        let uk = state.session.lock().unwrap_or_else(|p| p.into_inner())
            .as_ref().map(|s| s.user_key.clone()).unwrap_or_default();
        if !uk.is_empty() {
            st.send_user = uk;
            store::save_settings(&st).map_err(|e| e.to_string())?;
            *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = st.clone();
            eprintln!("[settings] send_user 已从会话自愈入库");
        }
    }
    Ok(AppSettings {
        send_token: st.send_token.clone(),
        send_user: st.send_user.clone(),
        toast: st.toast,
        quiet_enabled: st.quiet_enabled,
        quiet_start: st.quiet_start.clone(),
        quiet_end: st.quiet_end.clone(),
        muted_apps: st.muted_apps.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        device_name: state.session.lock().unwrap_or_else(|p| p.into_inner())
            .as_ref().map(|s| s.device_name.clone()).unwrap_or_default(),
        email: state.session.lock().unwrap_or_else(|p| p.into_inner())
            .as_ref().map(|s| s.email.clone()).unwrap_or_default(),
    })
    .map(|mut v| {
        let t = if v.send_token.is_empty() { "<空>".to_string() }
                else { format!("尾4 {}", &v.send_token[v.send_token.len()-4..]) };
        let u = if v.send_user.is_empty() { "<空>".to_string() }
                else { format!("尾4 {}", &v.send_user[v.send_user.len()-4..]) };
        eprintln!("[settings] get_settings 返回 token={t} user={u}");
        v
    })
}

#[tauri::command]
pub async fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    let st = store::Settings {
        send_token: settings.send_token,
        send_user: settings.send_user,
        toast: settings.toast,
        quiet_enabled: settings.quiet_enabled,
        quiet_start: settings.quiet_start,
        quiet_end: settings.quiet_end,
        muted_apps: settings.muted_apps,
    };
    store::save_settings(&st).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = st;
    Ok(())
}

#[tauri::command]
pub async fn send_test(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let (token, user) = {
        let st = state.settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
        (st.send_token, st.send_user)
    };
    if token.is_empty() || user.is_empty() {
        return Err("请先填写发送凭据（token 与 user key）".into());
    }
    let args = crate::pushover::SendArgs {
        title: Some("PushClaw 测试".into()),
        ..Default::default()
    };
    let body = crate::pushover::send_message(
        &token, &user,
        &format!("PushClaw 设置页测试消息 {}", chrono_now()),
        &args,
    ).await.map_err(|e| e.to_string())?;
    Ok(body["request"].as_str().unwrap_or("ok").to_string())
}

fn chrono_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("(unix {})", d.as_secs()))
        .unwrap_or_default()
}

/// 标记单条已读（本地 + 广播其它设备）
#[tauri::command]
pub async fn mark_read(app: tauri::AppHandle, state: tauri::State<'_, AppState>, umid: String) -> Result<(), String> {
    {
        let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
        store::mark_read_by_umids(&db, &[umid.clone()]);
    }
    crate::pushover::broadcast_read_sync(&app, &[umid])
        .await
        .map_err(|e| e.to_string())
}

/// 全部已读（本地 + 广播其它设备）
#[tauri::command]
pub async fn mark_all_read(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let umids = {
        let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db.execute("UPDATE messages SET read=1 WHERE archived=0 AND read=0", [])
            .map_err(|e| e.to_string())?;
        let _ = app.emit("read-sync", Vec::<String>::new());
        store::unread_umids(&db)
    };
    crate::pushover::broadcast_read_sync(&app, &umids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_apps(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
    Ok(store::distinct_apps(&db))
}

/// 应用图标 → data URL（Rust 侧磁盘缓存，官方指南要求缓存图标）
#[tauri::command]
pub async fn get_icon(name: String) -> Option<String> {
    let safe = name.replace('/', "_").replace('\\', "_");
    let dir = store::data_dir().join("icons");
    let path = dir.join(format!("{safe}.png"));
    if !path.exists() {
        let bytes = crate::pushover::client()
            .get(&format!("https://api.pushover.net/icons/{safe}.png"))
            .send()
            .await
            .ok()?
            .bytes()
            .await
            .ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, &bytes).ok()?;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(format!("data:image/png;base64,{}", base64_encode(&bytes)))
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for ch in data.chunks(3) {
        let b = [ch[0], *ch.get(1).unwrap_or(&0), *ch.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if ch.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if ch.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 发送凭据：单一来源 settings.json（user_key 登录自动填 / token 设置页补填）
fn resolve_send_creds(state: &tauri::State<'_, AppState>) -> Result<(String, String), String> {
    let st = state.settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let (token, user) = (st.send_token, st.send_user);
    if token.is_empty() || user.is_empty() {
        return Err("请先在设置页填写发送凭据（Token 30 位；User Key 已由登录自动填入）".into());
    }
    Ok((token, user))
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{:05x}", n & 0xfffff)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u32> = s.bytes()
        .filter(|c| *c != b'=')
        .map(|c| T.iter().position(|t| *t == c)
            .map(|i| i as u32)
            .ok_or_else(|| format!("非法 base64 字符: {c}")))
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4 + 3);
    for ch in bytes.chunks(4) {
        let n = ch.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (b << (18 - 6 * i)));
        out.push((n >> 16) as u8);
        if ch.len() > 2 { out.push((n >> 8) as u8); }
        if ch.len() > 3 { out.push(n as u8); }
    }
    Ok(out)
}

#[tauri::command]
pub async fn send_message(
    state: tauri::State<'_, AppState>,
    message: String,
    title: Option<String>,
    html: Option<bool>,
    priority: Option<i32>,
    device: Option<String>,
    url: Option<String>,
    image_b64: Option<String>,
    image_name: Option<String>,
) -> Result<String, String> {
    let (token, user) = resolve_send_creds(&state)?;
    let image_bytes = match (image_b64, image_name) {
        (Some(b64), Some(name)) => Some((b64_decode(&b64)?, name)),
        _ => None,
    };
    let args = crate::pushover::SendArgs {
        title,
        priority: priority.unwrap_or(0),
        html: html.unwrap_or(false),
        device,
        url,
        image_bytes,
        ..Default::default()
    };
    let body = crate::pushover::send_message(&token, &user, &message, &args)
        .await
        .map_err(|e| e.to_string())?;
    Ok(body["request"].as_str().unwrap_or("ok").to_string())
}

#[tauri::command]
pub async fn list_devices(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let (token, user) = resolve_send_creds(&state)?;
    crate::pushover::validate(&token, &user, None)
        .await
        .map_err(|e| e.to_string())
}

/// 注册设备（登录后的第二步；可独立重试，不影响登录态）
#[tauri::command]
pub async fn register_device(
    state: tauri::State<'_, AppState>,
    device_name: String,
) -> Result<(), String> {
    let secret = {
        let sess = state.session.lock().unwrap_or_else(|p| p.into_inner()).clone();
        sess.map(|s| s.secret).ok_or("请先登录")?
    };
    // 注册；若服务端返回"同名已占用"——说明此前响应丢失但注册实际成功，
    // 换确定性备用名重试一次（避免用户卡死在注册步骤）
    let device_id = match crate::pushover::register(&secret, &device_name).await {
        Ok(id) => id,
        Err(e) => {
            let msg = e.to_string();
            if !msg.starts_with("NAME_TAKEN:") {
                return Err(msg.trim_start_matches("REJECTED: ")
                    .trim_start_matches("RETRYABLE: ")
                    .trim_start_matches("NAME_TAKEN: ").to_string());
            }
            // 同名已存在：服务端已有该设备，生成备用名重试
            let retry_name = format!("{}-{}", device_name, rand_suffix());
            eprintln!("[register] 同名已存在，改用备用名 {retry_name}");
            crate::pushover::register(&secret, &retry_name).await
                .map_err(|e| format!("备用名注册也失败: {e}"))?
        }
    };
    {
        let mut guard = state.session.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(sess) = guard.as_mut() {
            sess.device_id = device_id.clone();
            sess.device_name = device_name.clone();
        }
    }
    // 重新持久化完整会话
    let sess = state.session.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(sess) = sess {
        store::save_session(&sess).map_err(|e| e.to_string())?;
    }
    eprintln!("[register] 设备已注册: {device_name} ({device_id})");
    Ok(())
}

#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle) -> Result<usize, String> {
    pushover::fetch_and_store(app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(url: String) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    /// 回归：前端 save_settings 载荷（不含 version/device_name）必须可反序列化。
    /// v0.11.x 曾因这两个字段必填导致保存被 serde 拒绝（UI 显示保存无效）。
    /// 载荷特意保留已废弃的 notify_sound：serde 忽略未知字段，
    /// 旧版前端的载荷也必须永远可被新版后端接受（前后端独立升级兼容）。
    #[test]
    fn frontend_payload_deserializes() {
        let payload = r#"{
            "send_token": "token-x",
            "send_user": "user-x",
            "toast": true,
            "notify_sound": false,
            "quiet_enabled": true,
            "quiet_start": "23:00",
            "quiet_end": "08:00",
            "muted_apps": ["AppA", "AppB"]
        }"#;
        let st: AppSettings =
            serde_json::from_str(payload).expect("前端载荷应可反序列化（含废弃字段）");
        assert_eq!(st.send_token, "token-x");
        assert!(st.quiet_enabled);
        assert_eq!(st.muted_apps.len(), 2);
    }
}
