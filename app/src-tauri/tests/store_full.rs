//! 存储层全函数真实覆盖（真 SQLite，2026-10-19 测试体系整改）。
//! 此前仅 query/get 有真测试；insert/mark_read/delete/archive 等写路径
//! 全部裸奔——"列表永远空"事故正发生在读路径，写路径同类风险未查。

use pushclaw_core::store;
use serde_json::json;

fn opendb() -> rusqlite::Connection {
    // 每测试独立库：cargo 并行跑测试，共享库文件会互相干扰计数
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!("po_store_full_{}.db", n));
    let _ = std::fs::remove_file(&p);
    store::open(&p).unwrap()
}

fn msg_json(id: i64, umid: &str, app: &str) -> serde_json::Value {
    json!({
        "id": id, "umid": umid, "title": format!("t-{id}"), "message": "正文",
        "html": 0, "priority": 0, "app": app, "date": 1730000000 + id,
        "acked": 0, "receipt": "", "icon": "ic"
    })
}

#[test]
fn insert_dedups_by_id_and_reports_new() {
    let conn = opendb();
    conn.execute("DELETE FROM messages", []).unwrap();
    let batch = vec![msg_json(1, "u1", "AppA"), msg_json(2, "u2", "AppB")];
    let new = store::insert(&conn, &batch);
    assert_eq!(new.len(), 2, "首次插入应报 2 条新消息");
    assert!(new.iter().all(|m| !m.read), "新消息应为未读");

    // 同 id 重放（断线重连重推场景）：不产生新消息
    let again = store::insert(&conn, &batch);
    assert_eq!(again.len(), 0, "重复 id 不应再入库");

    // id 缺失/为 0 的脏数据静默跳过
    let dirty = vec![json!({"umid": "x", "message": "no id"})];
    assert_eq!(store::insert(&conn, &dirty).len(), 0);
}

#[test]
fn read_state_roundtrip() {
    let conn = opendb();
    conn.execute("DELETE FROM messages", []).unwrap();
    store::insert(&conn, &[msg_json(10, "ru1", "A"), msg_json(11, "ru2", "A")]);

    assert_eq!(store::unread_count(&conn), 2);
    let umids = store::unread_umids(&conn);
    assert_eq!(umids.len(), 2);

    // 跨设备已读同步：按 umid 置已读
    let applied = store::mark_read_by_umids(&conn, &["ru1".into()]);
    assert_eq!(applied, 1);
    assert_eq!(store::unread_count(&conn), 1);
    // 幂等：重复应用不重复计数
    assert_eq!(store::mark_read_by_umids(&conn, &["ru1".into()]), 0);
}

#[test]
fn archive_and_delete() {
    let conn = opendb();
    conn.execute("DELETE FROM messages", []).unwrap();
    store::insert(&conn, &[msg_json(20, "du1", "A"), msg_json(21, "du2", "B"), msg_json(22, "du3", "B")]);

    assert_eq!(store::set_archived(&conn, &[20, 22], true), 2);
    // 归档后收件箱不可见、归档页可见（历史事故就在这个查询对）
    assert_eq!(store::query(&conn, None, 200, None, false).len(), 1);
    assert_eq!(store::query(&conn, None, 200, None, true).len(), 2);
    // 恢复
    assert_eq!(store::set_archived(&conn, &[20], false), 1);
    // 删除
    assert_eq!(store::delete_ids(&conn, &[20, 21]), 2);
    assert_eq!(store::query(&conn, None, 200, None, false).len(), 0);
    assert_eq!(store::query(&conn, None, 200, None, true).len(), 1);
}

#[test]
fn distinct_apps_for_mute_list() {
    let conn = opendb();
    conn.execute("DELETE FROM messages", []).unwrap();
    store::insert(&conn, &[msg_json(30, "a1", "AppA"), msg_json(31, "a2", "AppB"), msg_json(32, "a3", "AppA")]);
    assert_eq!(store::distinct_apps(&conn), vec!["AppA".to_string(), "AppB".to_string()]);
}

#[test]
fn migrations_preserve_legacy_data() {
    // 旧库缺 archived/icon/read 列时 open() 自动迁移且数据无损
    let path = std::env::temp_dir().join("po_store_legacy.db");
    let _ = std::fs::remove_file(&path);
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, title TEXT);
             INSERT INTO messages (id, title) VALUES (99, 'legacy');").unwrap();
    }
    let migrated = store::open(&path).unwrap();
    let (title,): (String,) = migrated
        .query_row("SELECT title FROM messages WHERE id=99", [], |r| {
            Ok((r.get(0)?,)) }).unwrap();
    assert_eq!(title, "legacy");
    let _ = std::fs::remove_file(&path);
}
