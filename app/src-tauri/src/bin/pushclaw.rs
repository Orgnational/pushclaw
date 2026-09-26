//! PushClaw CLI：发送/校验/回执（复用桌面端的协议层，替代原 Python po-send）。

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use pushclaw_core::pushover::{self, SendArgs};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "pushclaw", version, about = "PushClaw CLI（非官方 Pushover 工具）")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 发送一条消息
    Send {
        /// 正文（≤1024 字符；--html 时支持 <b> <i> <u> <font color> <a>）
        message: String,
        /// 标题（≤250 字符，缺省为应用名）
        #[arg(short, long)]
        title: Option<String>,
        /// 图片附件（bmp/gif/jpeg/png/tiff，≤5MB）
        #[arg(short, long)]
        image: Option<PathBuf>,
        /// 优先级 -2..2；2=强提醒（重复响铃直至任一设备确认）
        #[arg(short, long, default_value_t = 0)]
        priority: i32,
        /// 启用 HTML 富文本
        #[arg(long)]
        html: bool,
        /// 等宽字体（与 --html 互斥）
        #[arg(long)]
        monospace: bool,
        /// 定向设备名，逗号分隔；缺省广播全部设备
        #[arg(short, long)]
        device: Option<String>,
        /// 附加链接（支持 app scheme 深链）
        #[arg(long)]
        url: Option<String>,
        /// 附加链接标题
        #[arg(long = "url-title")]
        url_title: Option<String>,
        /// 音效名（pushover/siren/persistent/alien 等 23 种）
        #[arg(long)]
        sound: Option<String>,
        /// 消息在设备上的存活秒数（priority=2 忽略）
        #[arg(long)]
        ttl: Option<i64>,
        /// priority=2 重试间隔秒（≥30，默认 30）
        #[arg(long)]
        retry: Option<i64>,
        /// priority=2 确认窗口秒（≤10800，默认 3600）
        #[arg(long)]
        expire: Option<i64>,
        /// 确认后服务端回调 URL
        #[arg(long)]
        callback: Option<String>,
        /// 消息时间戳覆盖（Unix 秒）
        #[arg(long)]
        timestamp: Option<i64>,
        /// 输出原始 JSON
        #[arg(long)]
        json: bool,
    },
    /// 校验凭据并列出账号下设备
    Validate {
        /// 校验某设备是否属于该账号
        #[arg(long)]
        device: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// 查询 priority=2 回执的确认状态
    Receipt {
        receipt_id: String,
        #[arg(long)]
        json: bool,
    },
}

/// 发送方凭据：环境变量 > ~/.config/pushover/config.json > app.json(user_key)
fn load_credentials() -> Result<(String, String)> {
    let mut token = std::env::var("PUSHOVER_TOKEN").ok();
    let mut user = std::env::var("PUSHOVER_USER").ok();
    let cfg = std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
        .join(".config/pushover/config.json");
    if let Ok(raw) = std::fs::read_to_string(&cfg) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if token.is_none() { token = v["token"].as_str().map(String::from); }
            if user.is_none() { user = v["user"].as_str().map(String::from); }
        }
    }
    if user.is_none() {
        // 桌面端会话里存的 user_key 与账号一致，可兜底
        let app_cfg = pushclaw_core::store::data_dir().join("app.json");
        if let Ok(raw) = std::fs::read_to_string(&app_cfg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                user = v["user_key"].as_str().map(String::from);
            }
        }
    }
    match (token, user) {
        (Some(t), Some(u)) => Ok((t, u)),
        _ => bail!("缺少凭据：PUSHOVER_TOKEN/PUSHOVER_USER 环境变量，或 ~/.config/pushover/config.json"),
    }
}

/// 回执查询只需发送方 token。
fn load_token() -> Result<String> {
    if let Ok(t) = std::env::var("PUSHOVER_TOKEN") { return Ok(t); }
    let cfg = std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
        .join(".config/pushover/config.json");
    if let Ok(raw) = std::fs::read_to_string(&cfg) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(t) = v["token"].as_str() { return Ok(t.to_string()); }
        }
    }
    bail!("缺少 token：PUSHOVER_TOKEN 环境变量，或 ~/.config/pushover/config.json")
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli).await {
        eprintln!("错误: {e}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    match cli.cmd {
        Cmd::Send { message, title, image, priority, html, monospace, device,
                    url, url_title, sound, ttl, retry, expire, callback,
                    timestamp, json } => {
            // 管道输入：正文为 "-" 时读取 stdin
            let message = if message == "-" {
                use std::io::Read;
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf)
                    .map_err(|e| format!("读取 stdin 失败: {e}"))?;
                buf.trim_end().to_string()
            } else { message };
            let (token, user) = load_credentials()?;
            let args = SendArgs { title, priority, html, monospace, device, url,
                url_title, sound, ttl, retry, expire, callback, timestamp, image,
                image_bytes: None };
            let body = pushover::send_message(&token, &user, &message, &args).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&body)?);
            } else {
                println!("OK status={} request={}", body["status"], body["request"]);
                if let Some(rc) = body["receipt"].as_str() {
                    println!("priority=2 回执: {rc}");
                    println!("查询确认: pushclaw receipt {rc}");
                }
            }
        }
        Cmd::Validate { device, json } => {
            let (token, user) = load_credentials()?;
            let devices = pushover::validate(&token, &user, device.as_deref()).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&devices)?);
            } else {
                println!("OK 凭据有效，账号下设备: {}", if devices.is_empty() { "(无)".into() } else { devices.join(", ") });
            }
        }
        Cmd::Receipt { receipt_id, json } => {
            let token = load_token()?;
            let body = pushover::receipt(&token, &receipt_id).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&body)?);
            } else {
                println!("acknowledged = {} (by {} / {}) at {}",
                    body["acknowledged"], body["acknowledged_by"],
                    body["acknowledged_by_device"], body["acknowledged_at"]);
                println!("expired = {} (expires_at {})", body["expired"], body["expires_at"]);
                println!("called_back = {} (last attempt {})",
                    body["called_back"], body["last_delivered_at"]);
            }
        }
    }
    Ok(())
}
