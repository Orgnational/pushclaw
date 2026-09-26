//! Tauri 命令层：前端 invoke 的入口。

use crate::pushover;
use crate::store::{self, Msg, Session};
use crate::AppState;
use serde::Serialize;
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
pub fn get_status(state: tauri::State<'_, AppState>) -> Status {
    let sess = state.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    Status {
        configured: sess.is_some(),
        email: sess.as_ref().map(|s| s.email.clone()).unwrap_or_default(),
        device_name: sess.as_ref().map(|s| s.device_name.clone()).unwrap_or_default(),
        connected: state.connected.load(Ordering::Relaxed),
        db_path: store::db_path().display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
pub async fn login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    email: String,
    password: String,
    twofa: Option<String>,
    device_name: String,
) -> Result<(), String> {
    let sess = crate::pushover::login_and_register(
        &email, &password, twofa.as_deref(), &device_name,
    )
    .await
    .map_err(|e| e.to_string())?;
    eprintln!("[login] ③ 保存会话...");
    store::save_session(&sess).map_err(|e| e.to_string())?;
    *state.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sess);
    eprintln!("[login] ④ 通知 ws 线程...");
    let _ = state.session_tx.send(*state.session_tx.borrow() + 1);
    eprintln!("[login] ⑤ 完成，返回前端");
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = pushover::fetch_and_store(h).await;
    });
    eprintln!("[login] ⑤ 完成，返回前端");
    Ok(())
}

#[tauri::command]
pub fn history(
    state: tauri::State<'_, AppState>,
    query: Option<String>,
    limit: Option<i64>,
    priority: Option<i64>,
    archived: Option<bool>,
) -> Vec<Msg> {
    let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    store::query(
        &db,
        query.as_deref(),
        limit.unwrap_or(200),
        priority,
        archived.unwrap_or(false),
    )
}

#[tauri::command]
pub fn get_message(state: tauri::State<'_, AppState>, id: String) -> Option<Msg> {
    let id = id.parse::<i64>().ok()?;
    let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    store::get(&db, id)
}

#[tauri::command]
pub fn delete_messages(
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
pub fn archive_messages(
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
    pub send_token: String,
    pub send_user: String,
    pub toast: bool,
    pub notify_sound: bool,
    pub quiet_enabled: bool,
    pub quiet_start: String,
    pub quiet_end: String,
    pub muted_apps: Vec<String>,
    pub version: String,
    pub device_name: String,
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> AppSettings {
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
    AppSettings {
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
    }
}

#[tauri::command]
pub fn save_settings(
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

#[tauri::command]
pub fn list_apps(state: tauri::State<'_, AppState>) -> Vec<String> {
    let db = state.db.lock().unwrap_or_else(|p| p.into_inner());
    store::distinct_apps(&db)
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
