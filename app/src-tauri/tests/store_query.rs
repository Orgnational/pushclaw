//! 消息列表真 SQL 回归测试（2026-10-19 用户质疑"真的看到落库的消息了吗"后补）。
//!
//! 历史事故：v0.12.0 给 Msg 加 read 列时，row_to_msg 读 15 列但 query() 的
//! 内联 SQL 只 SELECT 13 列 → get(14) 越界 → filter_map(|r| r.ok()) 静默
//! 丢弃每一行 → 消息列表永远空。jsdom/真路径命令测试都 mock/绕过了
//! 真实 SQL+列映射组合，故从未拦截。
//!
//! 本测试对真实 SQLite（内存库）执行 真schema+真insert+真query+真get，
//! 列数漂移即刻失败。

use pushclaw_core::store;

fn insert_fixture(conn: &rusqlite::Connection) {
    let now = 1730000000i64;
    for (i, (title, pri, archived)) in [
        ("收件箱-A", 0i64, 0i64),
        ("紧急-B", 2, 0),
        ("已归档-C", 0, 1),
    ].iter().enumerate() {
        conn.execute(
            "INSERT INTO messages (id, umid, title, message, html, priority, url,
             url_title, app, date, received_at, acked, receipt, archived, icon, read)
             VALUES (?1,?2,?3,?4,0,?5,'','', 'app-x', ?6, ?6, 0, '', ?7, 'icn', 0)",
            rusqlite::params![
                (i + 1) as i64, format!("umid-{i}"), title,
                format!("正文{i}"), pri, now + i as i64, archived,
            ],
        ).unwrap();
    }
}

#[test]
fn query_returns_rows_with_all_columns() {
    let conn = store::open(&std::env::temp_dir().join("po_storeq_test.db")).unwrap();
    conn.execute("DELETE FROM messages", []).unwrap();
    insert_fixture(&conn);

    let inbox = store::query(&conn, None, 200, None, false);
    assert_eq!(inbox.len(), 2, "收件箱应返回 2 条（列数漂移会得 0——历史事故形态）");
    assert!(inbox.iter().all(|m| m.title.starts_with("收件箱") || m.title.starts_with("紧急")));
    // 15 列字段真实可读（icon/read 是事故列）
    assert!(inbox.iter().all(|m| m.icon == "icn"));
    assert!(inbox.iter().all(|m| !m.read));
    // 排序：date DESC
    assert_eq!(inbox[0].title, "紧急-B");

    let archive = store::query(&conn, None, 200, None, true);
    assert_eq!(archive.len(), 1);
    assert_eq!(archive[0].title, "已归档-C");

    // 过滤与搜索
    let p2 = store::query(&conn, None, 200, Some(2), false);
    assert_eq!(p2.len(), 1);
    let hit = store::query(&conn, Some("收件箱"), 200, None, false);
    assert_eq!(hit.len(), 1);
    // get() 单条（同列清单）
    assert_eq!(store::get(&conn, 1).unwrap().title, "收件箱-A");
}

#[test]
fn query_respects_limit() {
    let conn = store::open(&std::env::temp_dir().join("po_storeq_test2.db")).unwrap();
    conn.execute("DELETE FROM messages", []).unwrap();
    insert_fixture(&conn);
    assert_eq!(store::query(&conn, None, 1, None, false).len(), 1);
}
