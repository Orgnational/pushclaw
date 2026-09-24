//! 本地存储：SQLite 历史库 + 会话配置（与 CLI 版字段兼容但独立存放，避免设备会话互踢）。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    umid        TEXT,
    title       TEXT,
    message     TEXT,
    html        INTEGER DEFAULT 0,
    priority    INTEGER,
    sound       TEXT,
    url         TEXT,
    url_title   TEXT,
    app         TEXT,
    aid         TEXT,
    date        INTEGER,
    received_at INTEGER,
    acked       INTEGER DEFAULT 0,
    receipt     TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
"#;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub email: String,
    pub user_key: String,
    pub secret: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Clone, Serialize)]
pub struct Msg {
    pub id: i64,
    pub umid: String,
    pub title: String,
    pub message: String,
    pub html: bool,
    pub priority: i64,
    pub url: String,
    pub url_title: String,
    pub app: String,
    pub date: i64,
    pub acked: bool,
    pub receipt: String,
}

pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .expect("无法定位用户数据目录")
        .join("pushover")
}

pub fn db_path() -> PathBuf {
    data_dir().join("history.db")
}

pub fn open(path: &PathBuf) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

pub fn load_session() -> Option<Session> {
    let path = data_dir().join("app.json");
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_session(sess: &Session) -> anyhow::Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("app.json");
    std::fs::write(path, serde_json::to_string_pretty(sess)?)?;
    Ok(())
}

/// API 返回的字段宽松提取（umid 可能是数字或字符串，html 可能是 1 或 "1"）。
fn vstr(v: &serde_json::Value, key: &str) -> String {
    match v.get(key) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn vint(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}

fn vbool1(v: &serde_json::Value, key: &str) -> bool {
    match v.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) == 1,
        Some(serde_json::Value::String(s)) => s == "1",
        _ => false,
    }
}

/// 落库一批消息，返回新入库的（按设备内消息 id 去重）。
pub fn insert(conn: &Connection, msgs: &[serde_json::Value]) -> Vec<Msg> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut new_msgs = Vec::new();
    for m in msgs {
        let id = vint(m, "id");
        if id == 0 {
            continue;
        }
        let rows = conn
            .execute(
                "INSERT OR IGNORE INTO messages
                 (id, umid, title, message, html, priority, sound, url,
                  url_title, app, aid, date, received_at, acked, receipt)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                rusqlite::params![
                    id,
                    vstr(m, "umid"),
                    vstr(m, "title"),
                    vstr(m, "message"),
                    vbool1(m, "html") as i64,
                    vint(m, "priority"),
                    vstr(m, "sound"),
                    vstr(m, "url"),
                    vstr(m, "url_title"),
                    vstr(m, "app"),
                    vstr(m, "aid"),
                    vint(m, "date"),
                    now,
                    vbool1(m, "acked") as i64,
                    vstr(m, "receipt"),
                ],
            )
            .unwrap_or(0);
        if rows > 0 {
            new_msgs.push(Msg {
                id,
                umid: vstr(m, "umid"),
                title: vstr(m, "title"),
                message: vstr(m, "message"),
                html: vbool1(m, "html"),
                priority: vint(m, "priority"),
                url: vstr(m, "url"),
                url_title: vstr(m, "url_title"),
                app: vstr(m, "app"),
                date: vint(m, "date"),
                acked: vbool1(m, "acked"),
                receipt: vstr(m, "receipt"),
            });
        }
    }
    new_msgs
}

pub fn query(conn: &Connection, search: Option<&str>, limit: i64) -> Vec<Msg> {
    let sql = match search {
        Some(_) => {
            "SELECT id, umid, title, message, html, priority, url, url_title,
                    app, date, acked, receipt
             FROM messages
             WHERE title LIKE ?1 OR message LIKE ?1 OR app LIKE ?1
             ORDER BY date DESC, id DESC LIMIT ?2"
        }
        None => {
            "SELECT id, umid, title, message, html, priority, url, url_title,
                    app, date, acked, receipt
             FROM messages
             ORDER BY date DESC, id DESC LIMIT ?2"
        }
    };
    let like = format!("%{}%", search.unwrap_or(""));
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(
        rusqlite::params![like, limit],
        |r| {
            Ok(Msg {
                id: r.get(0)?,
                umid: r.get(1)?,
                title: r.get(2)?,
                message: r.get(3)?,
                html: r.get::<_, i64>(4)? == 1,
                priority: r.get(5)?,
                url: r.get(6)?,
                url_title: r.get(7)?,
                app: r.get(8)?,
                date: r.get(9)?,
                acked: r.get::<_, i64>(10)? == 1,
                receipt: r.get(11)?,
            })
        },
    );
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}
