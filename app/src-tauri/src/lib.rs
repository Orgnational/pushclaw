//! PushClaw 核心库：GUI 与 CLI 共用的协议层与存储层。

pub mod commands;
pub mod pushover;
pub mod store;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub session: Mutex<Option<store::Session>>,
    /// 登录会话版本号：login 成功后 +1，ws 循环监听变化即重连
    pub session_tx: tokio::sync::watch::Sender<u64>,
    /// 最新一条新消息 id（通知点击后导航用）
    pub latest_new: Mutex<Option<i64>>,
    pub connected: AtomicBool,
    pub settings: Mutex<store::Settings>,
}

/// 显示并聚焦主窗口
pub fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
