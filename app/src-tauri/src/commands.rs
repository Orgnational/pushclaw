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
}

#[tauri::command]
pub fn get_status(state: tauri::State<'_, AppState>) -> Status {
    let sess = state.session.lock().unwrap().clone();
    Status {
        configured: sess.is_some(),
        email: sess.as_ref().map(|s| s.email.clone()).unwrap_or_default(),
        device_name: sess.as_ref().map(|s| s.device_name.clone()).unwrap_or_default(),
        connected: state.connected.load(Ordering::Relaxed),
        db_path: store::db_path().display().to_string(),
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
    let (user_key, secret) = pushover::login(&email, &password, twofa.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let device_id = pushover::register(&secret, &device_name)
        .await
        .map_err(|e| e.to_string())?;
    let sess = Session {
        email,
        user_key,
        secret,
        device_id,
        device_name,
    };
    store::save_session(&sess).map_err(|e| e.to_string())?;
    *state.session.lock().unwrap() = Some(sess);
    let _ = state.session_tx.send(*state.session_tx.borrow() + 1);
    // 登录成功先立即拉一次队列
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = pushover::fetch_and_store(h).await;
    });
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
    let db = state.db.lock().unwrap();
    store::query(
        &db,
        query.as_deref(),
        limit.unwrap_or(200),
        priority,
        archived.unwrap_or(false),
    )
}

#[tauri::command]
pub fn get_message(state: tauri::State<'_, AppState>, id: i64) -> Option<Msg> {
    let db = state.db.lock().unwrap();
    store::get(&db, id)
}

#[tauri::command]
pub fn delete_messages(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    let db = state.db.lock().unwrap();
    Ok(store::delete_ids(&db, &ids))
}

#[tauri::command]
pub fn archive_messages(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
    archived: bool,
) -> Result<usize, String> {
    let db = state.db.lock().unwrap();
    Ok(store::set_archived(&db, &ids, archived))
}

#[tauri::command]
pub async fn ack(
    state: tauri::State<'_, AppState>,
    receipt: String,
) -> Result<(), String> {
    let secret = {
        let sess = state.session.lock().unwrap().clone();
        sess.map(|s| s.secret)
            .ok_or_else(|| "尚未登录".to_string())?
    };
    pushover::acknowledge(&secret, &receipt)
        .await
        .map_err(|e| e.to_string())?;
    {
        let db = state.db.lock().unwrap();
        let _ = db.execute(
            "UPDATE messages SET acked=1 WHERE receipt=?1",
            rusqlite::params![receipt],
        );
    }
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
