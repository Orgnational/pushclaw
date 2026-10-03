fn main() {
    let st = pushclaw_core::store::load_settings();
    let t = if st.send_token.is_empty() { "<空>".into() } else { format!("尾4 {}", &st.send_token[st.send_token.len()-4..]) };
    let u = if st.send_user.is_empty() { "<空>".into() } else { format!("尾4 {}", &st.send_user[st.send_user.len()-4..]) };
    println!("load_settings() 真实读取: token={t} user={u} toast={} quiet={}", st.toast, st.quiet_enabled);
}
