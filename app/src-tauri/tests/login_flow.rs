//! 登录流程集成测试：对内嵌 mock 服务器跑 login_and_register 全流程，
//! 5 秒超时判定——任何一步卡死（如注册响应丢失后的悬挂）都会 FAIL。
//!
//! 运行：cargo test --test login_flow

use std::io::{Read, Write};
use std::net::TcpListener;

/// 极简 HTTP mock：login.json / devices.json / messages.json
fn spawn_mock(port: u16) {
    std::thread::spawn(move || {
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        for stream in listener.incoming() {
            let mut s = match stream {
                Ok(s) => s,
                Err(_) => break,
            };
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = if req.contains("/1/users/login.json") {
                r#"{"status":1,"id":"ukey-mock","secret":"sess-mock"}"#
            } else if req.contains("/1/devices.json") {
                r#"{"status":1,"id":"devid-mock-1"}"#
            } else {
                r#"{"status":1,"messages":[]}"#
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = s.write_all(resp.as_bytes());
            // Connection: close → 客户端读 EOF 即完成
        }
    });
}

#[tokio::test]
async fn login_and_register_completes() {
    // API 基址是 OnceLock：必须在首次调用前设置
    std::env::set_var("PUSHOVER_API_BASE", "http://127.0.0.1:18100/1");
    spawn_mock(18100);

    let fut = pushclaw_core::pushover::login_and_register(
        "tester@example.com",
        "pw",
        None,
        "test-dev",
    );
    let sess = tokio::time::timeout(std::time::Duration::from_secs(5), fut)
        .await
        .expect("login_and_register 卡死（>5s）——复现了登录悬挂！")
        .expect("登录流程失败");

    assert_eq!(sess.user_key, "ukey-mock");
    assert_eq!(sess.secret, "sess-mock");
    assert_eq!(sess.device_id, "devid-mock-1");
    assert_eq!(sess.device_name, "test-dev");
}
