//! 真路径集成测试：直接调用真正的 commands::send_message / list_devices。
//!
//! 与 login_real_path.rs 同理（2026-10-19 补的验证缺口）：
//! send_flow.rs 只测协议层 pushover::send_message，命令包装层
//! （b64 解码 / resolve_send_creds / SendArgs 组装）从未被真实执行。
//! 用户问"发送页面真的能发送对应内容吗？设备列表能获取到所有设备吗"——
//! 本测试对本地 mock 执行真命令并断言线上的 multipart 内容逐字段正确。

use pushclaw_core::commands;
use pushclaw_core::AppState;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use tauri::Manager;

static LOCK: Mutex<()> = Mutex::new(());

static HITS: std::sync::OnceLock<Arc<Mutex<Vec<String>>>> = std::sync::OnceLock::new();
const PORT: u16 = 18157;

fn spawn_mock_once() -> Arc<Mutex<Vec<String>>> {
    let hits = HITS.get_or_init(|| {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let h = hits.clone();
        std::thread::spawn(move || serve(h));
        hits
    });
    hits.clone()
}

fn serve(hits: Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind(("127.0.0.1", PORT)).unwrap();
    for stream in listener.incoming() {
        let mut s = match stream { Ok(s) => s, Err(_) => break };
        let hits = hits.clone();
        let mut buf = vec![0u8; 262144];
        s.set_read_timeout(Some(std::time::Duration::from_millis(400))).unwrap();
        let mut req = String::new();
        loop {
            match s.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => req.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
        }
        let path = req.lines().next().unwrap_or("").to_string();
        hits.lock().unwrap().push(req);
        let body = if path.contains("users/validate.json") {
            r#"{"status":1,"devices":["dev-a","dev-b","dev-c"]}"#
        } else if path.contains("messages.json") {
            r#"{"status":1,"request":"req-real-send"}"#
        } else {
            r#"{"status":1}"#
        };
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body);
        let _ = s.write_all(resp.as_bytes());
    }
}

fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
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

fn mock_app_with_creds() -> impl tauri::Manager<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(pushclaw_core::store::open(
            &std::env::temp_dir().join("po_sendpath.db")).unwrap()),
        session: Mutex::new(None),
        session_tx: tokio::sync::watch::channel(0u64).0,
        latest_new: Mutex::new(None),
        connected: std::sync::atomic::AtomicBool::new(false),
        settings: Mutex::new(pushclaw_core::store::Settings {
            send_token: "RealPathToken1234567890abcdef".into(),
            send_user: "RealPathUser1234567890abcdefg".into(),
            ..Default::default()
        }),
    });
    app
}

#[tokio::test]
async fn real_send_message_puts_full_content_on_wire() {
    let _g = LOCK.lock().unwrap();
    std::env::set_var("PUSHOVER_API_BASE", format!("http://127.0.0.1:{PORT}/1"));
    let hits = spawn_mock_once();
    let app = mock_app_with_creds();
    let state = app.state::<AppState>();

    let png = [0x89u8, b'P', b'N', b'G', 1, 2, 3, 4, 5, 6, 7, 8];
    let req_id = commands::send_message(
        state,
        "正文内容-端到端".into(),
        Some("标题-真路径".into()),
        Some(true),
        Some(2),
        Some("dev-b".into()),
        None,
        Some(b64(&png)),
        Some("t.png".into()),
    )
    .await
    .expect("真 send_message 命令应成功");
    assert_eq!(req_id, "req-real-send");

    // 线上断言：定位 messages.json 的请求块，逐字段核对
    let blocks = hits.lock().unwrap().clone();
    let wire = blocks.iter().find(|b| b.contains("POST /1/messages.json"))
        .expect("应 POST messages.json").clone();
    assert!(wire.contains("RealPathToken1234567890abcdef"), "token 必须来自 settings");
    assert!(wire.contains("RealPathUser1234567890abcdefg"), "user 必须来自 settings");
    assert!(wire.contains("正文内容-端到端"), "正文必须上 wire");
    assert!(wire.contains("标题-真路径"), "标题必须上 wire");
    assert!(wire.contains("dev-b"), "定向设备必须上 wire");
    assert!(wire.contains("attachment"), "附件 part 必须存在");
    assert!(wire.contains("t.png"), "附件文件名必须上 wire");
}

#[tokio::test]
async fn real_list_devices_returns_all_from_service() {
    let _g = LOCK.lock().unwrap();
    std::env::set_var("PUSHOVER_API_BASE", format!("http://127.0.0.1:{PORT}/1"));
    let hits = spawn_mock_once();
    let app = mock_app_with_creds();

    let devs = commands::list_devices(app.state::<AppState>())
        .await
        .expect("真 list_devices 命令应成功");
    assert_eq!(devs, vec!["dev-a".to_string(), "dev-b".to_string(), "dev-c".to_string()],
        "必须完整返回服务端设备列表");
    assert!(hits.lock().unwrap().iter().any(|b| b.contains("POST /1/users/validate.json")),
        "应 POST validate.json");
}
