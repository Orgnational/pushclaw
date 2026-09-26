//! 设置载荷反序列化回归测试：镜像前端 save_settings 的 invoke 载荷，
//! 防止 serde 必填字段导致的"保存无效"回归（v0.11.x 实际事故：
//! version/device_name 被要求必填，前端不回传 → serde 拒绝 → UI 无反应）。

use pushclaw_core::commands::AppSettings;

/// 前端 app.js save 按钮发送的确切载荷形状（无 version/device_name）。
const FRONTEND_PAYLOAD: &str = r#"{
    "send_token": "token-x",
    "send_user": "user-x",
    "toast": true,
    "notify_sound": false,
    "quiet_enabled": true,
    "quiet_start": "23:00",
    "quiet_end": "08:00",
    "muted_apps": ["AppA", "AppB"]
}"#;

#[test]
fn frontend_payload_deserializes() {
    let st: AppSettings = serde_json::from_str(FRONTEND_PAYLOAD)
        .expect("前端保存载荷必须可反序列化（缺省字段不应拒绝）");
    assert_eq!(st.send_token, "token-x");
    assert_eq!(st.send_user, "user-x");
    assert!(st.toast);
    assert!(!st.notify_sound);
    assert!(st.quiet_enabled);
    assert_eq!(st.quiet_start, "23:00");
    assert_eq!(st.quiet_end, "08:00");
    assert_eq!(st.muted_apps, vec!["AppA".to_string(), "AppB".to_string()]);
    // 只读展示字段给缺省值
    assert_eq!(st.version, "");
    assert_eq!(st.device_name, "");
}

#[test]
fn minimal_payload_also_deserializes() {
    // 所有业务字段都是 serde default 时，空对象也应可解析
    // 注意：AppSettings 的 bool 走标准 false 缺省（与 Settings 的 default_true 不同）
    let st: AppSettings = serde_json::from_str("{}").expect("空对象应可反序列化");
    assert!(st.send_token.is_empty());
    assert!(!st.toast); // 空载荷 = 未配置，toast 缺省 false
}
