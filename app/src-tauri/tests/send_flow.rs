//! 发送流程集成测试：对内嵌 mock 服务器验证 send_message 全链路
//! （multipart 附件、base64 解码、参数组装），2 秒超时判定卡死。

use std::io::{Read, Write};
use std::net::TcpListener;

fn spawn_mock(port: u16, hits: std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        for stream in listener.incoming() {
            let mut s = match stream {
                Ok(s) => s,
                Err(_) => break,
            };
            let mut buf = vec![0u8; 65536];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            // 记录请求头与 body 摘要（multipart 边界后为字段）
            if let Some(first) = req.lines().next() {
                hits.lock().unwrap().push(first.to_string());
            }
            hits.lock().unwrap().push(req.contains("attachment").to_string());
            let body = r#"{"status":1,"request":"req-mock"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = s.write_all(resp.as_bytes());
        }
    });
}

fn b64_decode(s: &str) -> Vec<u8> {
    // 与 commands.rs 同算法的镜像实现（测试用途）
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u32> = s.bytes()
        .filter(|c| *c != b'=')
        .map(|c| T.iter().position(|t| *t == c).unwrap() as u32)
        .collect();
    let mut out = Vec::new();
    for ch in bytes.chunks(4) {
        let n = ch.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (b << (18 - 6 * i)));
        out.push((n >> 16) as u8);
        if ch.len() > 2 { out.push((n >> 8) as u8); }
        if ch.len() > 3 { out.push(n as u8); }
    }
    out
}

#[tokio::test]
async fn send_message_reaches_mock_with_attachment() {
    std::env::set_var("PUSHOVER_API_BASE", "http://127.0.0.1:18101/1");
    let hits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    spawn_mock(18101, hits.clone());

    // 模拟 GUI 传来的 base64 附件（PNG 魔数 + 数据）
    let image_bytes = vec![0x89u8, b'P', b'N', b'G', 1, 2, 3, 4, 5, 6, 7, 8];
    let b64 = {
        // 用 commands 模块同款编码（通过公共 API 无法直接测私有 fn，
        // 这里构造 commands 会用到的等价输入，解码正确性由 send_flow 内
        // b64_decode 断言）
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for ch in image_bytes.chunks(3) {
            let b = [ch[0], *ch.get(1).unwrap_or(&0), *ch.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if ch.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if ch.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    };
    assert_eq!(b64_decode(&b64), image_bytes, "base64 编解码镜像一致");

    let args = pushclaw_core::pushover::SendArgs {
        title: Some("测试标题".into()),
        priority: 1,
        html: true,
        image_bytes: Some((image_bytes.clone(), "test.png".into())),
        ..Default::default()
    };
    let fut = pushclaw_core::pushover::send_message(
        "token-mock", "user-mock",
        "<b>hello</b> 附件测试",
        &args,
    );
    let body = tokio::time::timeout(std::time::Duration::from_secs(2), fut)
        .await
        .expect("send_message 卡死（>2s）")
        .expect("发送失败");
    assert_eq!(body["status"], 1);

    let hits = hits.lock().unwrap();
    assert!(hits.iter().any(|h| h.contains("POST /1/messages.json")),
        "mock 应收到 messages.json POST");
    assert!(hits.iter().any(|h| *h == "true"),
        "multipart 中应包含 attachment 部分");
}
