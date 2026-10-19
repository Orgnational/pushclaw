//! 真路径集成测试：直接调用真正的 commands::login 命令（非协议层、非 debug 通道）。
//!
//! 历史缺口（2026-10-19 补）：此前 token→settings.json 的验证走的是
//! PUSHOVER_DEBUG_LOGIN 诊断通道（setup 里手工复制的逻辑），真正的 Tauri
//! 命令包装层从未被测试执行过——用户在 Windows 实测"登录填的 token
//! 没出现在配置里、发送页凭据缺失"后补上的防线。
//!
//! 用 tauri::test mock 运行时构造真实 State，HOME 重定向到临时目录
//! （store::data_dir 跟随 HOME），对本地 mock 服务器跑完整命令：
//!   login(email, password, None, device, Some(token))
//!   → 断言 settings.json 的 send_token/send_user 与 app.json 会话五元组

use pushclaw_core::commands;
use pushclaw_core::{AppState, pushover};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use tauri::Manager;

static LOCK: Mutex<()> = Mutex::new(());

fn spawn_mock(port: u16) {
    std::thread::spawn(move || {
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        for stream in listener.incoming() {
            let mut s = match stream { Ok(s) => s, Err(_) => break };
            let mut buf = vec![0u8; 65536];
            s.set_read_timeout(Some(std::time::Duration::from_millis(300))).unwrap();
            let mut req = String::new();
            loop {
                match s.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => req.push_str(&String::from_utf8_lossy(&buf[..n])),
                    Err(_) => break,
                }
            }
            let path = req.lines().next().unwrap_or("").to_string();
            let body = if path.contains("users/login.json") {
                r#"{"status":1,"id":"ukey-real-path","secret":"sess-real-path"}"#
            } else if path.contains("devices.json") {
                r#"{"status":1,"id":"devid-real-path"}"#
            } else {
                r#"{"status":1,"messages":[]}"#
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body);
            let _ = s.write_all(resp.as_bytes());
        }
    });
}

#[tokio::test]
async fn real_login_command_saves_token_and_user_to_settings() {
    let _g = LOCK.lock().unwrap();
    let home = std::env::temp_dir().join("po_realpath_test");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    // api_base 是 OnceLock 缓存——测试进程内首次调用即固化，先于其它测试文件（独立进程）
    std::env::set_var("PUSHOVER_API_BASE", "http://127.0.0.1:18155/1");
    spawn_mock(18155);

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(pushclaw_core::store::open(&pushclaw_core::store::db_path()).unwrap()),
        session: Mutex::new(None),
        session_tx: tokio::sync::watch::channel(0u64).0,
        latest_new: Mutex::new(None),
        connected: std::sync::atomic::AtomicBool::new(false),
        settings: Mutex::new(pushclaw_core::store::load_settings()),
    });
    let state = app.state::<AppState>();

    // 真命令路径：带 token 登录
    commands::login(
        app.handle().clone(),
        state,
        "u@t.com".into(),
        "pw".into(),
        None,
        "win-test-dev".into(),
        Some("TOKENrpTOKENrpTOKENrpTOKENrpxy".into()),   // 30 位
    )
    .await
    .expect("真实 login 命令应成功");

    // 断言 1：settings.json —— token 与 user_key 都必须落盘（用户报告的核心链路）
    let raw = std::fs::read_to_string(home.join("Library/Application Support/pushover/settings.json"))
        .expect("settings.json 应已写入");
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["send_token"], "TOKENrpTOKENrpTOKENrpTOKENrpxy",
        "登录页填写的 token 必须出现在 settings.json");
    assert_eq!(v["send_user"], "ukey-real-path",
        "登录返回的 user_key 必须无条件入库");

    // 断言 2：app.json 会话五元组完整
    let sess: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        home.join("Library/Application Support/pushover/app.json")).unwrap()).unwrap();
    assert_eq!(sess["device_name"], "win-test-dev");
    assert_eq!(sess["device_id"], "devid-real-path");
    assert_eq!(sess["user_key"], "ukey-real-path");
    assert_eq!(sess["secret"], "sess-real-path");

    // 断言 3：get_settings（真命令）读回的凭据非空——发送页 list_devices/send 的数据源
    let st = commands::get_settings(app.state::<AppState>()).await.unwrap();
    assert_eq!(st.send_token, "TOKENrpTOKENrpTOKENrpTOKENrpxy");
    assert_eq!(st.send_user, "ukey-real-path");

    let _ = std::fs::remove_dir_all(&home);
}

#[tokio::test]
async fn real_login_without_token_preserves_existing_one() {
    let _g = LOCK.lock().unwrap();
    let home = std::env::temp_dir().join("po_realpath_test2");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    // 并行调度下本测试可能先执行——必须同样先设 API_BASE，
    // 否则 OnceLock 固化为默认生产地址，假凭据会打到真实服务器
    std::env::set_var("PUSHOVER_API_BASE", "http://127.0.0.1:18155/1");
    spawn_mock(18155);

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(pushclaw_core::store::open(&pushclaw_core::store::db_path()).unwrap()),
        session: Mutex::new(None),
        session_tx: tokio::sync::watch::channel(0u64).0,
        latest_new: Mutex::new(None),
        connected: std::sync::atomic::AtomicBool::new(false),
        settings: Mutex::new(pushclaw_core::store::Settings {
            send_token: "EXISTING_token_untouched_12345".into(),
            ..Default::default()
        }),
    });
    let state = app.state::<AppState>();

    commands::login(
        app.handle().clone(), state,
        "u@t.com".into(), "pw".into(), None,
        "dev2".into(), None,   // 不填 token
    ).await.expect("登录应成功");

    let st = commands::get_settings(app.state::<AppState>()).await.unwrap();
    assert_eq!(st.send_token, "EXISTING_token_untouched_12345",
        "不填 token 时必须保留已有 token（登录页 token 为可选覆盖）");
    assert_eq!(st.send_user, "ukey-real-path");

    let _ = std::fs::remove_dir_all(&home);
}
