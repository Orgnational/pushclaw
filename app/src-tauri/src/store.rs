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
    receipt     TEXT,
    archived    INTEGER DEFAULT 0,
    icon        TEXT,
    read        INTEGER DEFAULT 1
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

/// i64 序列化为 JSON 字符串：消息 id 超出 JS Number 安全范围（2^53），
/// 直接序列化数字会被 JS 静默舍入导致按 id 操作全部失配。
fn id_as_string<S: serde::Serializer>(v: &i64, ser: S) -> Result<S::Ok, S::Error> {
    ser.serialize_str(&v.to_string())
}

#[derive(Clone, Serialize)]
pub struct Msg {
    #[serde(serialize_with = "id_as_string")]
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
    pub archived: bool,
    pub icon: String,
    pub read: bool,
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub send_token: String,
    #[serde(default)]
    pub send_user: String,
    #[serde(default = "default_true")]
    pub toast: bool,
    #[serde(default)]
    pub notify_sound: bool,
    /// 免打扰时段（HH:MM）；紧急消息(priority=2)不受限
    #[serde(default)]
    pub quiet_enabled: bool,
    #[serde(default)]
    pub quiet_start: String,
    #[serde(default)]
    pub quiet_end: String,
    /// 静音的应用名列表（按应用通知设置）
    #[serde(default)]
    pub muted_apps: Vec<String>,
}
fn default_true() -> bool { true }
impl Default for Settings {
    fn default() -> Self {
        Settings {
            send_token: String::new(),
            send_user: String::new(),
            toast: true,
            notify_sound: false,
            quiet_enabled: false,
            quiet_start: String::new(),
            quiet_end: String::new(),
            muted_apps: Vec::new(),
        }
    }
}

pub fn settings_path() -> PathBuf { data_dir().join("settings.json") }

pub fn load_settings() -> Settings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_settings(st: &Settings) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_dir())?;
    std::fs::write(settings_path(), serde_json::to_string_pretty(st)?)?;
    Ok(())
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
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    conn.execute_batch(SCHEMA)?;
    // 老库迁移：补 archived 列
    let has_archived: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name='archived'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_archived == 0 {
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN archived INTEGER DEFAULT 0",
        )?;
    }
    let has_icon: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name='icon'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_icon == 0 {
        conn.execute_batch("ALTER TABLE messages ADD COLUMN icon TEXT")?;
    }
    let has_read: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name='read'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_read == 0 {
        // 存量消息默认已读：只对新到消息做未读提醒
        conn.execute_batch("ALTER TABLE messages ADD COLUMN read INTEGER DEFAULT 1")?;
    }
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
                  url_title, app, aid, date, received_at, acked, receipt, icon, read)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
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
                    vstr(m, "icon"),
                    0i64,
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
                icon: vstr(m, "icon"),
                read: false,
                archived: false,
            });
        }
    }
    new_msgs
}

const MSG_COLS: &str = "id, umid, title, message, html, priority, url, url_title, app, date, acked, receipt, archived, icon, read";

fn row_to_msg(r: &rusqlite::Row) -> rusqlite::Result<Msg> {
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
        archived: r.get::<_, i64>(12)? == 1,
        icon: r.get::<_, String>(13).unwrap_or_default(),
        read: r.get::<_, i64>(14)? == 1,
    })
}

/// 历史查询：归档过滤 + 可选优先级/关键词过滤。
pub fn query(
    conn: &Connection,
    search: Option<&str>,
    limit: i64,
    priority: Option<i64>,
    archived: bool,
) -> Vec<Msg> {
    let like = search.map(|q| format!("%{q}%"));
    let sql = "SELECT id, umid, title, message, html, priority, url, url_title,
                      app, date, acked, receipt, archived
               FROM messages
               WHERE archived = ?1
                 AND (?2 IS NULL OR priority = ?2)
                 AND (?3 IS NULL OR title LIKE ?3 OR message LIKE ?3 OR app LIKE ?3)
               ORDER BY date DESC, id DESC LIMIT ?4";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(
        rusqlite::params![archived as i64, priority, like, limit],
        |r| row_to_msg(r),
    );
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// 历史中出现过的所有发送应用名（设置页"按应用静音"用）。
pub fn distinct_apps(conn: &Connection) -> Vec<String> {
    let mut stmt = match conn
        .prepare("SELECT DISTINCT app FROM messages WHERE app != '' ORDER BY app")
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|it| it.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// 跨设备已读同步：按 umid 置已读（服务器不存已读态，由各设备本地应用）。
pub fn mark_read_by_umids(conn: &Connection, umids: &[String]) -> usize {
    umids.iter()
        .map(|u| {
            conn.execute(
                "UPDATE messages SET read=1 WHERE umid=?1 AND read=0",
                rusqlite::params![u],
            )
            .unwrap_or(0)
        })
        .sum()
}

/// 未读数（列表页脚显示用）。
pub fn unread_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE archived=0 AND read=0",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 未读消息的 umid 列表（广播用）。
pub fn unread_umids(conn: &Connection) -> Vec<String> {
    let mut stmt = match conn
        .prepare("SELECT umid FROM messages WHERE archived=0 AND read=0 AND umid != ''")
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|it| it.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

pub fn get(conn: &Connection, id: i64) -> Option<Msg> {
    conn.query_row(
        &format!("SELECT {MSG_COLS} FROM messages WHERE id = ?1"),
        rusqlite::params![id],
        |r| row_to_msg(r),
    )
    .ok()
}

/// 批量归档/恢复，返回影响行数。
pub fn set_archived(conn: &Connection, ids: &[i64], archived: bool) -> usize {
    ids.iter()
        .map(|id| {
            conn.execute(
                "UPDATE messages SET archived=?1 WHERE id=?2",
                rusqlite::params![archived as i64, id],
            )
            .unwrap_or(0)
        })
        .sum()
}

/// 批量删除，返回影响行数。
pub fn delete_ids(conn: &Connection, ids: &[i64]) -> usize {
    ids.iter()
        .map(|id| {
            conn.execute("DELETE FROM messages WHERE id=?1", rusqlite::params![id])
                .unwrap_or(0)
        })
        .sum()
}
