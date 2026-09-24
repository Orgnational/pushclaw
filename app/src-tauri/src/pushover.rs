//! Pushover 协议层：REST API（登录/注册/拉取/确认）+ WebSocket 实时通道。

use crate::store::{self, Session};
use crate::AppState;
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

pub const API: &str = "https://api.pushover.net/1";
pub const WS_URL: &str = "wss://client.pushover.net/push";
pub const UA: &str = concat!("pushover-toolkit-app/", env!("CARGO_PKG_VERSION"), " (unofficial)");

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .expect("构建 HTTP 客户端失败")
}

/// 错误消息里提取服务端 errors 数组。
fn api_errors(body: &Value) -> String {
    body.get("errors")
        .and_then(|e| e.as_array())
        .map(|a| {
            a.iter()
                .map(|x| match x {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_else(|| body.to_string())
}

/// 登录，返回 (user_key, secret)。服务端 412 表示需要两步验证。
pub async fn login(email: &str, password: &str, twofa: Option<&str>) -> Result<(String, String)> {
    let mut form = vec![("email", email.to_string()), ("password", password.to_string())];
    if let Some(t) = twofa {
        form.push(("twofa", t.to_string()));
    }
    let r = client()
        .post(format!("{API}/users/login.json"))
        .form(&form)
        .send()
        .await?;
    let code = r.status().as_u16();
    let body: Value = r.json().await?;
    if body.get("status").and_then(|s| s.as_i64()) == Some(1) {
        Ok((
            body["id"].as_str().unwrap_or_default().to_string(),
            body["secret"].as_str().unwrap_or_default().to_string(),
        ))
    } else if code == 412 {
        bail!("2fa_required")
    } else {
        bail!("登录失败: {}", api_errors(&body))
    }
}

/// 注册本机为 Open Client 设备（os=O），返回 device_id。
pub async fn register(secret: &str, name: &str) -> Result<String> {
    let r = client()
        .post(format!("{API}/devices.json"))
        .form(&[
            ("secret", secret),
            ("name", name),
            ("os", "O"),
        ])
        .send()
        .await?;
    let body: Value = r.json().await?;
    if body.get("status").and_then(|s| s.as_i64()) == Some(1) {
        Ok(body["id"].as_str().unwrap_or_default().to_string())
    } else {
        bail!("注册失败: {}", api_errors(&body))
    }
}

pub async fn fetch_messages(secret: &str, device_id: &str) -> Result<Vec<Value>> {
    let r = client()
        .get(format!("{API}/messages.json"))
        .query(&[("secret", secret), ("device_id", device_id)])
        .send()
        .await?;
    let body: Value = r.json().await?;
    Ok(body
        .get("messages")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default())
}

pub async fn acknowledge(secret: &str, receipt: &str) -> Result<()> {
    let r = client()
        .post(format!("{API}/receipts/{receipt}/acknowledge.json"))
        .form(&[("secret", secret)])
        .send()
        .await?;
    let body: Value = r.json().await?;
    if body.get("status").and_then(|s| s.as_i64()) == Some(1) {
        Ok(())
    } else {
        bail!("确认失败: {}", api_errors(&body))
    }
}

/// 通知正文里剥掉 HTML 标签（系统通知不支持富文本）。
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// 拉取一次消息并入库；对新消息发窗口事件 + 系统通知。返回新入库条数。
pub async fn fetch_and_store(app: tauri::AppHandle) -> Result<usize> {
    let sess = {
        let st = app.state::<AppState>();
        let guard = st.session.lock().unwrap();
        guard.clone()
    };
    let Some(sess) = sess else { return Ok(0) };
    eprintln!("[pushover] 收到信号，开始拉取...");
    let msgs = match fetch_messages(&sess.secret, &sess.device_id).await {
        Ok(m) => m,
        Err(e) => { eprintln!("[pushover] 拉取失败: {e}"); return Err(e); }
    };
    eprintln!("[pushover] 拉取到 {} 条", msgs.len());
    if msgs.is_empty() {
        return Ok(0);
    }
    let new_msgs = {
        let st = app.state::<AppState>();
        let db = st.db.lock().unwrap();
        let n = store::insert(&db, &msgs);
        eprintln!("[pushover] 新入库 {} 条", n.len());
        n
    };
    let n = new_msgs.len();
    if let Some(last) = new_msgs.last() {
        let st = app.state::<AppState>();
        *st.latest_new.lock().unwrap() = Some(last.id);
    }
    for m in &new_msgs {
        let _ = app.emit("new-message", m);
    }
    // 系统通知：只弹新消息，一次最多 3 条防刷屏
    for m in new_msgs.iter().rev().take(3).rev() {
        let title = if m.title.is_empty() {
            if m.app.is_empty() { "Pushover".to_string() } else { m.app.clone() }
        } else {
            m.title.clone()
        };
        let body = strip_html(&m.message);
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }
    Ok(n)
}

/// 常驻循环：登录后维持 ws 连接；断线重连（指数退避）；重新登录即换会话重连。
pub async fn ws_loop(app: tauri::AppHandle) {
    let mut backoff: u64 = 3;
    loop {
        let sess = {
            let st = app.state::<AppState>();
            let guard = st.session.lock().unwrap();
            guard.clone()
        };
        let Some(sess) = sess else {
            // 未登录：等 login 触发信号
            let st = app.state::<AppState>();
            let mut rx = st.session_tx.subscribe();
            let _ = rx.changed().await;
            continue;
        };
        set_connected(&app, true);
        let _ = app.emit("ws-status", "connected");
        let outcome = run_connection(&app, &sess).await;
        set_connected(&app, false);
        let _ = app.emit("ws-status", "reconnecting");
        if let Err(e) = outcome {
            let msg = e.to_string();
            let _ = app.emit("ws-error", msg.clone());
            if msg.contains("接管") || msg.contains("永久错误") {
                // 设备被接管 / 服务端要求重新登录：不再自动重连，等用户操作
                let mut back = backoff.min(60);
                let _ = &mut back;
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

fn set_connected(app: &tauri::AppHandle, on: bool) {
    let st = app.state::<AppState>();
    st.connected.store(on, std::sync::atomic::Ordering::Relaxed);
}

async fn run_connection(app: &tauri::AppHandle, sess: &Session) -> Result<()> {
    let request = WS_URL.into_client_request()?;
    let (ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(x) => { eprintln!("[ws] 已连接"); x }
        Err(e) => { eprintln!("[ws] 连接失败: {e}"); return Err(e.into()); }
    };
    let (mut write, mut read) = ws.split();
    write
        .send(Message::Text(format!(
            "login:{}:{}\n",
            sess.device_id, sess.secret
        )))
        .await?;

    let st = app.state::<AppState>();
    let mut rx = st.session_tx.subscribe();
    let mut ka = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    let mut last_rx = tokio::time::Instant::now();

    let outcome: Result<()> = loop {
        tokio::select! {
            _ = ka.tick() => {
                if last_rx.elapsed() > Duration::from_secs(180) {
                    break Err(anyhow!("180s 未收到服务端帧"));
                }
                let _ = write.send(Message::Text("#".into())).await;
            }
            _ = rx.changed() => {
                break Err(anyhow!("会话已更新，重连"));
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(msg)) => {
                        // 服务器实际发的是单字节 Binary 帧（opcode=2），Text 兼容
                        last_rx = tokio::time::Instant::now();
                        let payload: Option<String> = match msg {
                            Message::Text(t) => Some(t.as_str().to_string()),
                            Message::Binary(b) => String::from_utf8(b).ok(),
                            Message::Ping(p) => {
                                let _ = write.send(Message::Pong(p)).await;
                                None
                            }
                            Message::Close(_) => {
                                break Err(anyhow!("连接被服务端关闭"))
                            }
                            _ => None,
                        };
                        if let Some(t) = payload {
                            match t.as_str() {
                                "#" => {}
                                "!" => { let _ = fetch_and_store(app.clone()).await; }
                                "R" => break Err(anyhow!("服务端要求重连(R)")),
                                "E" => break Err(anyhow!("永久错误(E)，需要重新登录")),
                                "A" => break Err(anyhow!("设备被另一会话接管(A)，请更换设备名")),
                                other => { let _ = app.emit("ws-log", other.to_string()); }
                            }
                        }
                    }
                    None => break Err(anyhow!("连接被服务端关闭")),
                    Some(Err(e)) => break Err(e.into()),
                }
            }
        }
    };
    let _ = write.send(Message::Close(None)).await;
    outcome
}
