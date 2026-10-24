//! 接收核心真路径测试：fetch_and_store（ws "!" 信号触发的完整接收管线，
//! 2026-10-19 整改——此前 20 命令+9 存储函数整改后，这是最后的核心盲区）。
//!
//! 对本地 mock 服务器真执行：拉取 → 分区（普通消息 vs 已读信令）→ 入库 →
//! 已读态应用 → 服务端队列清理(prune) → latest_new 设置。全链断言。

use pushclaw_core::{store, AppState};
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use tauri::Manager;

static LOCK: Mutex<()> = Mutex::new(());

fn spawn_mock(port: u16, hits: Arc<Mutex<Vec<String>>>) {
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
            hits.lock().unwrap().push(req.lines().next().unwrap_or("").to_string());
            let path = req.lines().next().unwrap_or("");
            let body = if path.contains("GET /1/messages.json") {
                // 一条普通消息 + 一条已读同步信令（标记 ru9 已读）
                r#"{"status":1,"messages":[
                    {"id":9001,"umid":"nu1","title":"新到","message":"正文甲","html":0,
                     "priority":0,"app":"AppA","date":1730000100,"acked":0,"receipt":"","icon":"ic1"},
                    {"id":9002,"umid":"nu2","message":"__PUSHCLAW_READ__:ru9","html":0,
                     "priority":0,"app":"","date":1730000200,"acked":0,"receipt":"","icon":""}
                ]}"#
            } else {
                r#"{"status":1}"#
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body);
            let _ = s.write_all(resp.as_bytes());
        }
    });
}

#[tokio::test]
async fn fetch_and_store_full_pipeline() {
    let _g = LOCK.lock().unwrap();
    let home = std::env::temp_dir().join("po_fetchstore");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("PUSHOVER_API_BASE", "http://127.0.0.1:18159/1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    spawn_mock(18159, hits.clone());

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(store::open(&store::db_path()).unwrap()),
        session: Mutex::new(Some(store::Session {
            email: "t@t".into(), user_key: "uk".into(), secret: "sk".into(),
            device_id: "dv".into(), device_name: "n".into(),
        })),
        session_tx: tokio::sync::watch::channel(0u64).0,
        latest_new: Mutex::new(None),
        connected: std::sync::atomic::AtomicBool::new(false),
        // toast=false：mock 运行时未注册通知插件，弹通知会 panic；
        // 通知显示属 OS 层，本测试覆盖的是入库/已读/清理管线
        settings: Mutex::new(store::Settings { toast: false, ..Default::default() }),
    });

    // 预置一条未读消息（模拟另一设备发来的，等待已读信令）
    {
        let st = app.state::<AppState>();
        let db = st.db.lock().unwrap();
        store::insert(&db, &[json!({
            "id": 8001, "umid": "ru9", "title": "待同步已读", "message": "m",
            "html": 0, "priority": 0, "app": "AppB", "date": 1730000001 })]);
        assert_eq!(store::unread_count(&db), 1);
    }

    // 真执行接收管线
    let n = pushclaw_core::pushover::fetch_and_store(app.handle().clone())
        .await.expect("fetch_and_store 应成功");
    assert_eq!(n, 1, "应新入库 1 条普通消息（信令不入库）");

    {
        let st = app.state::<AppState>();
        let db = st.db.lock().unwrap();
        // ① 普通消息入库且字段完整
        let m = store::get(&db, 9001).expect("9001 应已入库");
        assert_eq!((m.title.as_str(), m.app.as_str(), m.icon.as_str(), m.read),
                   ("新到", "AppA", "ic1", false));
        // ② 信令未入库
        assert!(store::get(&db, 9002).is_none(), "已读信令不得入历史库");
        // ③ 已读态按 umid 应用
        assert_eq!(store::unread_count(&db), 1, "ru9 应已被信令置读（仅剩 9001 未读）");
        // ④ 列表可见（历史事故回归点：查询列数）
        assert_eq!(store::query(&db, None, 200, None, false).len(), 2);
    }
    // ⑤ latest_new 指向新入库的最后一条
    assert_eq!(*app.state::<AppState>().latest_new.lock().unwrap(), Some(9001));
    // ⑥ 服务端队列已清理（prune 调用了 update_highest_message）
    assert!(hits.lock().unwrap().iter().any(|h| h.contains("update_highest_message")),
        "应 POST update_highest_message 清理服务端队列");
    assert!(hits.lock().unwrap().iter().any(|h| h.contains("GET /1/messages.json")));

    let _ = std::fs::remove_dir_all(&home);
}
