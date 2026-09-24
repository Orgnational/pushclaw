//! Pushover 协议层：REST API（登录/注册/拉取/确认）+ WebSocket 实时通道。

use crate::store::{self, Session};
use crate::AppState;
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

pub const WS_HOST: &str = "client.pushover.net";

/// DNS 解析：系统解析器优先，失败走 DoH（1.1.1.1/8.8.8.8，IP 字面量无需再解析）。
/// 返回全部地址且 IPv4 优先（本机无 IPv6 连通性，v6 在前会撞 Network unreachable）。
async fn resolve_host(host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>> {
    let h = host.to_string();
    let std_try = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let v: Vec<std::net::SocketAddr> = (h.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect())
            .unwrap_or_default();
        v
    }).await.unwrap_or_default();
    let mut addrs = std_try;
    addrs.sort_by_key(|a| !a.is_ipv4());
    if !addrs.is_empty() {
        return Ok(addrs);
    }
    eprintln!("[dns] 系统解析 {host} 失败，尝试 DoH");
    for server in ["1.1.1.1", "8.8.8.8"] {
        let url = format!("https://{server}/dns-query?name={host}&type=A");
        if let Ok(resp) = reqwest::Client::new()
            .get(&url)
            .header("accept", "application/dns-json")
            .timeout(Duration::from_secs(6))
            .send()
            .await
        {
            if let Ok(v) = resp.json::<Value>().await {
                let ips: Vec<std::net::SocketAddr> = v.get("Answer")
                    .and_then(|a| a.as_array()).map(|arr| arr.iter()
                        .filter(|x| x.get("type").and_then(|t| t.as_i64()) == Some(1))
                        .filter_map(|x| x.get("data").and_then(|d| d.as_str()))
                        .filter_map(|ip| format!("{ip}:{port}").parse().ok())
                        .collect()).unwrap_or_default();
                if !ips.is_empty() {
                    eprintln!("[dns] DoH({server}) 解析 {host} -> {ips:?}");
                    return Ok(ips);
                }
            }
        }
    }
    bail!("域名 {host} 解析失败（系统与 DoH 均失败）")
}

/// reqwest 自定义解析器：REST 层共用同样的 DoH 兜底。
#[derive(Clone)]
struct DoHResolver;

impl reqwest::dns::Resolve for DoHResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = resolve_host(&host, 443)
                .await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
            Ok(Box::new(addrs.into_iter())
                as Box<dyn Iterator<Item = std::net::SocketAddr> + Send>)
        })
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .dns_resolver(Arc::new(DoHResolver))
        .build()
        .expect("构建 HTTP 客户端失败")
}

/// ws 连接：自解析 IP 直连 + TLS SNI 用真域名 + 在 TLS 流上做 ws 握手。
async fn dial_ws() -> Result<tokio_tungstenite::WebSocketStream<
    tokio_rustls::client::TlsStream<tokio::net::TcpStream>>> {
    let addrs = resolve_host(WS_HOST, 443).await?;
    let mut tcp = None;
    for addr in &addrs {
        match tokio::net::TcpStream::connect(addr).await {
            Ok(t) => { tcp = Some(t); break; }
            Err(e) => eprintln!("[dial] {addr} 失败: {e}"),
        }
    }
    let tcp = tcp.ok_or_else(|| anyhow!("所有地址均无法连接"))?;
    tcp.set_nodelay(true).ok();
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let cfg = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let sni = rustls::pki_types::ServerName::try_from(WS_HOST.to_string())
        .map_err(|e| anyhow!("SNI 名称非法: {e}"))?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect(sni, tcp)
        .await?;
    let req = WS_URL.into_client_request()?;
    let (ws, _) = tokio_tungstenite::client_async(req, tls).await?;
    Ok(ws)
}

pub const API: &str = "https://api.pushover.net/1";
pub const WS_URL: &str = "wss://client.pushover.net/push";
pub const UA: &str = concat!("pushover-toolkit-app/", env!("CARGO_PKG_VERSION"), " (unofficial)");

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

/// 通知服务端删除本设备队列中 ≤ highest 的消息（本地库已是档案，队列只留未拉取的）。
pub async fn prune_server(secret: &str, device_id: &str, highest: i64) -> Result<()> {
    let r = client()
        .post(format!("{API}/devices/{device_id}/update_highest_message.json"))
        .form(&[("secret", secret), ("message", &highest.to_string())])
        .send()
        .await?;
    let body: Value = r.json().await?;
    if body.get("status").and_then(|s| s.as_i64()) == Some(1) {
        Ok(())
    } else {
        bail!("清理队列失败: {}", api_errors(&body))
    }
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
    // 入库后清理服务端队列：取本次最大 id，之后每次只增量传输
    let highest = msgs.iter().filter_map(|m| match m.get("id") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse::<i64>().ok(),
        _ => None,
    }).max();
    if let Some(h) = highest {
        if let Err(e) = prune_server(&sess.secret, &sess.device_id, h).await {
            eprintln!("[pushover] 队列清理失败（下次重试）: {e}");
        } else {
            eprintln!("[pushover] 服务端队列已清理至 id={h}");
        }
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
        // 官方指南：priority=2 须以醒目方式呈现直至用户手动确认 —— 自动弹出主窗口
        if m.priority == 2 && !m.acked {
            crate::show_main(&app);
        }
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

/// 同名重新注册设备并更新会话：E 帧冷却期的自愈手段（实测立即恢复）。
pub async fn re_register(app: &tauri::AppHandle) -> Result<()> {
    let st = app.state::<AppState>();
    let sess = {
        let guard = st.session.lock().unwrap();
        guard.clone()
    };
    let Some(sess) = sess else { return Ok(()) };
    let device_id = register(&sess.secret, &sess.device_name).await?;
    let new_sess = Session { device_id, ..sess };
    store::save_session(&new_sess)?;
    *st.session.lock().unwrap() = Some(new_sess);
    let _ = st.session_tx.send(*st.session_tx.borrow() + 1);
    eprintln!("[ws] 已同名重新注册设备，使用新 device_id 重连");
    Ok(())
}

/// 常驻循环：登录后维持 ws 连接；断线重连（指数退避）；重新登录即换会话重连。
pub async fn ws_loop(app: tauri::AppHandle) {
    let mut backoff: u64 = 3;
    let mut e_streak: u32 = 0;
    loop {
        let attempt_start = std::time::Instant::now();
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
            eprintln!("[ws] 断开: {msg}");
            let _ = app.emit("ws-error", msg.clone());
            // E/A 帧：非正常断开后的服务端冷却/接管，通常等一会儿就恢复。
            // E 连续 3 次仍被拒 → 同名重新注册自愈（避免积压通知长时间无法接收）
            if msg.contains("接管") {
                // 官方指南：A 帧（他处登录）不得自动重连 —— 等待用户重新登录触发会话变更
                let _ = app.emit("ws-error", "此设备已在别处登录，等待重新登录…".to_string());
                let st = app.state::<AppState>();
                let mut rx = st.session_tx.subscribe();
                let _ = rx.changed().await;
                continue;
            }
            if msg.contains("永久错误") {
                e_streak += 1;
                if e_streak >= 3 {
                    if let Err(e) = re_register(&app).await {
                        let _ = app.emit("ws-error",
                            format!("自动重注册失败（{e}），如持续异常请在应用内重新登录"));
                        tokio::time::sleep(Duration::from_secs(300)).await;
                    }
                    e_streak = 0;
                    continue;
                }
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }
        }
        if attempt_start.elapsed() > Duration::from_secs(120) {
            e_streak = 0;   // 稳定连过一段时间，重置 E 计数
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
    let ws = match dial_ws().await {
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
                                "!" => { eprintln!("[ws] 收到 ! 信号"); let _ = fetch_and_store(app.clone()).await; }
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
