//! 设置结构完整性测试：序列化方向防线。
//!
//! 历史事故：AppSettings 漏定义 email 字段（v0.9.1 写设置页时漏绑），
//! get_settings 返回里没有它，前端读 undefined 显示空——运行数个版本才被发现。
//! serde(default) 只防"前端少传字段"（反序列化方向）；本测试防
//! "结构体漏字段导致前端拿不到"（序列化方向）：断言 get_settings 的
//! 返回 JSON 必须包含设置页渲染所需的全部只读字段。

use pushclaw_core::commands::AppSettings;

#[test]
fn serialized_settings_contains_all_ui_fields() {
    let st = AppSettings {
        send_token: "t".into(),
        send_user: "u".into(),
        toast: true,
        quiet_enabled: false,
        quiet_start: String::new(),
        quiet_end: String::new(),
        muted_apps: Vec::new(),
        version: "0.0.0-test".into(),
        device_name: "dev".into(),
        email: "a@b.c".into(),
    };
    let json = serde_json::to_value(&st).expect("AppSettings 应可序列化");
    // 设置页渲染读取的每个字段（app.js loadSettings 的 st.* 全集）
    // notify_sound 已移除（v0.14.2 假开关清理），清单同步
    for field in [
        "send_token", "send_user", "toast",
        "quiet_enabled", "quiet_start", "quiet_end", "muted_apps",
        "version", "device_name", "email",
    ] {
        assert!(
            json.get(field).is_some(),
            "AppSettings 序列化缺字段 `{field}`——设置页该栏位会显示空（历史事故模式）"
        );
    }
    assert_eq!(json["email"], "a@b.c");
}

#[test]
fn msg_serialization_keeps_string_id_and_read() {
    // 消息结构防线：id 必须以字符串序列化（大整数精度事故），
    // read 字段必须存在（已读同步渲染依赖）
    let m = pushclaw_core::store::Msg {
        id: 1183335762543728906i64,
        umid: "u1".into(),
        title: String::new(),
        message: String::new(),
        html: false,
        priority: 0,
        url: String::new(),
        url_title: String::new(),
        app: String::new(),
        date: 0,
        acked: false,
        receipt: String::new(),
        archived: false,
        icon: String::new(),
        read: false,
    };
    let json = serde_json::to_value(&m).expect("Msg 应可序列化");
    assert_eq!(
        json["id"], "1183335762543728906",
        "id 必须序列化为字符串（JS Number 精度上限 2^53）"
    );
    assert_eq!(json["read"], false, "read 字段必须存在（已读态渲染依赖）");
}
