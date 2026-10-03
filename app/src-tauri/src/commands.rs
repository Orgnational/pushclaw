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
}

#[tauri::command]
pub async fn get_status(state: tauri::State<'_, AppState>) -> Result<Status, String> {
    let sess = state.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    Ok(Status {
        configured: sess.is_some(),
        email: sess.as_ref().map(|s| s.email.clone()).unwrap_or_default(),
        device_name: sess.as_ref().map(|s| s.device_name.clone()).unwrap_or_default(),
        connected: state.connected.load(Ordering::Relaxed),
        db_path: store::db_path().display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
pub async fn login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    email: String,
    password: String,
    twofa: Option<String>,
    device_name: Option<String>,
    send_token: Option<String>,
) -> Result<(), String> {
    // 登录与设备注册拆分（v0.14 前端两步流程）：
    // 本命令只验证账号并保存会话（device_id 留空）；
    // 设备注册由前端随后调用 register_device 完成
    let (user_key, secret) = crate::pushover::login(&email, &password, twofa.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    eprintln!("[login] ③ 保存会话...");
    let sess = store::Session {
        email: email.clone(),
        user_key,
        secret,
        device_id: String::new(),
        device_name: device_name.unwrap_or_default(),
    };
    store::save_session(&sess).map_err(|e| e.to_string())?;
    // 可选发送凭据：填了 Token 就把"发送身份"一并配置好（User Key 用登录返回的）
    if let Some(tk) = send_token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        if tk.chars().count() != 30 {
            return Err("API Token 应为 30 位字符，请检查后重试".into());
        }
        let mut st = state.settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
        st.send_token = tk.to_string();
        st.send_user = sess.user_key.clone();
        store::save_settings(&st).map_err(|e| e.to_string())?;
        *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = st;
        eprintln!("[login] 发送凭据已保存");
    }
    *state.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sess);
    eprintln!("[login] ④ 通知 ws 线程...");
    let _ = state.session_tx.send(*state.session_tx.borrow() + 1);
    eprintln!("[login] ⑤ 完成，返回前端");
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
    #[serde(default)]
    pub notify_sound: bool,
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
    let st = state.settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
    // 发送凭据缺省时，尝试从 CLI 配置文件带出（用户已在 CLI 配置过则零输入）
    let (mut token, mut user) = (st.send_token.clone(), st.send_user.clone());
    if token.is_empty() || user.is_empty() {
        let cfg = std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
            .join(".config/pushover/config.json");
        if let Ok(raw) = std::fs::read_to_string(&cfg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if token.is_empty() { token = v["token"].as_str().unwrap_or("").into(); }
                if user.is_empty() { user = v["user"].as_str().unwrap_or("").into(); }
            }
        }
    }
    Ok(AppSettings {
        send_token: token,
        send_user: user,
        toast: st.toast,
        notify_sound: st.notify_sound,
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
        notify_sound: settings.notify_sound,
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

/// 发送凭据：设置页保存的优先，缺省回落 CLI config.json
fn resolve_send_creds(state: &tauri::State<'_, AppState>) -> Result<(String, String), String> {
    let st = state.settings.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let (mut token, mut user) = (st.send_token.clone(), st.send_user.clone());
    if token.is_empty() || user.is_empty() {
        let cfg = std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
            .join(".config/pushover/config.json");
        if let Ok(raw) = std::fs::read_to_string(&cfg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if token.is_empty() { token = v["token"].as_str().unwrap_or("").into(); }
                if user.is_empty() { user = v["user"].as_str().unwrap_or("").into(); }
            }
        }
    }
    if token.is_empty() || user.is_empty() {
        return Err("请先在设置页填写发送凭据".into());
    }
    Ok((token, user))
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
    let device_id = crate::pushover::register(&secret, &device_name)
        .await
        .map_err(|e| e.to_string())?;
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
            serde_json::from_str(payload).expect("前端载荷应可反序列化");
        assert_eq!(st.send_token, "token-x");
        assert!(st.quiet_enabled);
        assert_eq!(st.muted_apps.len(), 2);
    }
}
