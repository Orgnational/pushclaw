//! 命令层批量真路径测试（2026-10-19 测试体系整改）：
//! 此前 20 个命令仅 3 个被真实执行——logout/save_settings/mark_read/
//! delete/archive/get_status/history/get_message/list_apps 全部 mock 裸奔。
//! mock 运行时 + 临时 HOME + 真 SQLite，直调真命令断言真实副作用。

use pushclaw_core::commands;
use pushclaw_core::{AppState, store};
use serde_json::json;
use std::sync::Mutex;
use tauri::{Manager, Runtime};

static LOCK: Mutex<()> = Mutex::new(());

macro_rules! setup {
    ($home:ident) => {{
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let $home = std::env::temp_dir().join(format!("po_cmdpath_{}", n));
        let _ = std::fs::remove_dir_all(&$home);
        std::fs::create_dir_all(&$home).unwrap();
        std::env::set_var("HOME", &$home);
        let app = tauri::test::mock_app();
        app.manage(AppState {
            db: Mutex::new(store::open(&store::db_path()).unwrap()),
            session: Mutex::new(store::load_session()),
            session_tx: tokio::sync::watch::channel(0u64).0,
            latest_new: Mutex::new(None),
            connected: std::sync::atomic::AtomicBool::new(false),
            settings: Mutex::new(store::load_settings()),
        });
        app
    }};
}

fn insert_msg(conn: &rusqlite::Connection, id: i64, umid: &str) {
    store::insert(conn, &[json!({
        "id": id, "umid": umid, "title": format!("t{id}"), "message": "m",
        "html": 0, "priority": 0, "app": "AppA", "date": 1730000000 + id
    })]);
}

#[tokio::test]
async fn logout_clears_session_and_file() {
    let _g = LOCK.lock().unwrap();
    let app = setup!(home);
    // 先造已登录态：app.json + 内存会话
    let sess = store::Session {
        email: "a@b".into(), user_key: "uk".into(), secret: "sk".into(),
        device_id: "dv".into(), device_name: "n".into(),
    };
    store::save_session(&sess).unwrap();
    *app.state::<AppState>().session.lock().unwrap() = Some(sess);
    assert!(std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/pushover/app.json").exists());

    commands::logout(app.state::<AppState>()).await.unwrap();

    assert!(!std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/pushover/app.json").exists(),
        "logout 必须删除 app.json");
    assert!(app.state::<AppState>().session.lock().unwrap().is_none(),
        "logout 必须清空内存会话");
    // settings.json 保留（凭据与偏好跨登录持久——设计语义）
    // （本例未写过 settings，仅验证不崩溃）
}

#[tokio::test]
async fn save_settings_roundtrip_via_command() {
    let _g = LOCK.lock().unwrap();
    let app = setup!(home);
    let payload = r#"{"send_token":"tok-roundtrip-30-chars-AAAAAAAAA","send_user":"usr","toast":false,"quiet_enabled":true,"quiet_start":"23:00","quiet_end":"07:00","muted_apps":["X"]}"#;
    let st: commands::AppSettings = serde_json::from_str(payload).unwrap();
    commands::save_settings(app.state::<AppState>(), st).await.unwrap();

    let disk = std::fs::read_to_string(std::path::PathBuf::from(std::env::var("HOME").unwrap())
        .join("Library/Application Support/pushover/settings.json")).unwrap();
    assert!(disk.contains("tok-roundtrip-30-chars-AAAAAAAAA"), "保存必须落盘");
    let back = commands::get_settings(app.state::<AppState>()).await.unwrap();
    assert_eq!(back.send_token, "tok-roundtrip-30-chars-AAAAAAAAA");
    assert!(back.quiet_enabled);
    assert_eq!(back.muted_apps, vec!["X".to_string()]);
}

#[tokio::test]
async fn message_lifecycle_via_commands() {
    let _g = LOCK.lock().unwrap();
    let app = setup!(_h);
    {
        let st = app.state::<AppState>();
        let db = st.db.lock().unwrap();
        insert_msg(&db, 100, "lu1");
        insert_msg(&db, 101, "lu2");
    }
    macro_rules! st { () => { app.state::<AppState>() } }

    // history / get_message / list_apps
    let list = commands::history(st!(), None, Some(200), None, Some(false)).await.unwrap();
    assert_eq!(list.len(), 2);
    let one = commands::get_message(st!(), "101".into()).await.unwrap().unwrap();
    assert_eq!(one.umid, "lu2");
    assert_eq!(commands::list_apps(st!()).await.unwrap(), vec!["AppA".to_string()]);

    // mark_read：本地置读（无发送凭据 → 广播自动跳过，不报错）
    commands::mark_read(app.handle().clone(), st!(), "lu1".into()).await.unwrap();
    assert_eq!(commands::get_status(st!()).await.unwrap().email, "");   // 未登录
    {
        let st = app.state::<AppState>();
        assert_eq!(store::unread_count(&st.db.lock().unwrap()), 1, "lu1 应已读");
    }

    // mark_all_read
    commands::mark_all_read(app.handle().clone(), st!()).await.unwrap();
    {
        let st = app.state::<AppState>();
        assert_eq!(store::unread_count(&st.db.lock().unwrap()), 0);
    }

    // archive / delete（字符串 id —— 大整数精度协议）
    commands::archive_messages(st!(), vec!["100".into()], true).await.unwrap();
    assert_eq!(commands::history(st!(), None, Some(200), None, Some(false)).await.unwrap().len(), 1);
    assert_eq!(commands::history(st!(), None, Some(200), None, Some(true)).await.unwrap().len(), 1);
    commands::delete_messages(st!(), vec!["100".into(), "101".into()]).await.unwrap();
    assert_eq!(commands::history(st!(), None, Some(200), None, Some(false)).await.unwrap().len(), 0);
}

#[tokio::test]
async fn get_status_reflects_session_state() {
    let _g = LOCK.lock().unwrap();
    let app = setup!(_h);
    macro_rules! st { () => { app.state::<AppState>() } }
    // 未登录
    let s0 = commands::get_status(st!()).await.unwrap();
    assert!(!s0.configured && !s0.device_registered);
    // 登录（含 device_id）
    *st!().session.lock().unwrap() = Some(store::Session {
        email: "z@z".into(), user_key: "k".into(), secret: "s".into(),
        device_id: "d1".into(), device_name: "dev-n".into(),
    });
    let s1 = commands::get_status(st!()).await.unwrap();
    assert!(s1.configured && s1.device_registered);
    assert_eq!(s1.email, "z@z");
    assert_eq!(s1.device_name, "dev-n");
    // 坏会话（device_id 空）必须判未配置——ws_loop 拒连的同一判定
    *st!().session.lock().unwrap() = Some(store::Session {
        email: "z@z".into(), user_key: "k".into(), secret: "s".into(),
        device_id: String::new(), device_name: "dev-n".into(),
    });
    let s2 = commands::get_status(st!()).await.unwrap();
    assert!(!s2.configured, "空 device_id 坏会话必须视为未登录");
}
