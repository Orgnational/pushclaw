#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! PushClaw 桌面端：托盘 + 原生通知 + 历史窗口。

use pushclaw_core::{commands, pushover, store, AppState, show_main};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent};

fn main() {
    // rustls 提供者歧义防护（tokio-tungstenite 间接引入 aws-lc-rs 与 ring 并存）
    let _ = rustls::crypto::ring::default_provider().install_default();

    let db_path = store::db_path();
    let conn = store::open(&db_path).expect("打开历史库失败");
    let session = store::load_session();
    let (tx, _rx) = tokio::sync::watch::channel(0u64);

    tauri::Builder::default()
        // 单实例强制：二次启动时把已有窗口带到前台（防多开抢设备会话）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            db: Mutex::new(conn),
            session: Mutex::new(session),
            session_tx: tx,
            latest_new: Mutex::new(None),
            connected: AtomicBool::new(false),
            settings: Mutex::new(store::load_settings()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::get_settings,
            commands::save_settings,
            commands::send_test,
            commands::send_message,
            commands::list_devices,
            commands::list_apps,
            commands::mark_read,
            commands::mark_all_read,
            commands::get_icon,
            commands::login,
            commands::logout,
            commands::register_device,
            commands::history,
            commands::get_message,
            commands::delete_messages,
            commands::archive_messages,
            commands::ack,
            commands::sync_now,
            commands::open_url,
        ])
        .setup(|app| {
            // websocket 常驻循环
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                pushover::ws_loop(handle).await;
            });

            // 端到端诊断通道（PUSHOVER_DEBUG_LOGIN=email:password:device_name 时启用）：
            // 复刻 login 命令的完整后端路径（登录+注册+存盘+emit login-success），
            // 用于脱离 GUI 表单输入验证"后端成功→前端跳转"链路。正常用户不受影响。
            if let Ok(creds) = std::env::var("PUSHOVER_DEBUG_LOGIN") {
                let parts: Vec<&str> = creds.splitn(4, ':').collect();
                if parts.len() >= 3 {
                    let (e, p, n) = (parts[0].to_string(), parts[1].to_string(), parts[2].to_string());
                    let tk = parts.get(3).map(|s| s.to_string());
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(4)).await;   // 等前端就绪
                        eprintln!("[debug-login] 开始（{e} / 设备 {n} / token {}）",
                            if tk.is_some() {"已带"} else {"未带"});
                        match pushover::login_and_register(&e, &p, None, &n).await {
                            Ok(sess) => {
                                use tauri::{Emitter, Manager};
                                eprintln!("[debug-login] a. 协议完成 device_id={}", sess.device_id);
                                store::save_session(&sess).expect("debug: 存会话");
                                eprintln!("[debug-login] b. app.json 已落盘");
                                let st = handle.state::<crate::AppState>();
                                {
                                    let mut s = st.settings.lock().unwrap_or_else(|x| x.into_inner()).clone();
                                    s.send_user = sess.user_key.clone();
                                    if let Some(ref t) = tk { s.send_token = t.clone(); }
                                    store::save_settings(&s).expect("debug: 存设置");
                                    *st.settings.lock().unwrap_or_else(|x| x.into_inner()) = s.clone();
                                    eprintln!("[debug-login] c. settings 已落盘 token尾4={}",
                                        &s.send_token[s.send_token.len().saturating_sub(4).max(0)..]);
                                }
                                eprintln!("[debug-login] c. settings 已落盘");
                                *st.session.lock().unwrap_or_else(|x| x.into_inner()) = Some(sess.clone());
                                eprintln!("[debug-login] d. 内存会话已置");
                                let ver = *st.session_tx.borrow() + 1;
                                let _ = st.session_tx.send(ver);
                                eprintln!("[debug-login] e. session_tx 已发");
                                let r = handle.emit("login-success", sess.device_name.clone());
                                eprintln!("[debug-login] f. emit 返回 {:?}", r.map(|_| "ok"));
                                eprintln!("[debug-login] 完成：会话已存，login-success 已 emit");
                            }
                            Err(e) => eprintln!("[debug-login] 失败: {e}"),
                        }
                    });
                }
            }

            // 托盘
            let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
            let sync = MenuItemBuilder::with_id("sync", "立即同步").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .item(&sync)
                .separator()
                .item(&quit)
                .build()?;
            // 托盘专用图标：白色爪痕透明底；macOS 模板模式自适应深浅色菜单栏
            let tray_icon = tauri::include_image!("icons/tray.png");
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("PushClaw")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "sync" => {
                        let h = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = pushover::fetch_and_store(h).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 隐藏到托盘，不退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app, event| {
            // macOS：点击通知或 Dock 重新激活 → 显示窗口并定位最新消息
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                let st = app.state::<AppState>();
                let latest = *st.latest_new.lock().unwrap();
                if let Some(id) = latest {
                    let _ = app.emit("navigate-latest", id);
                }
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, &event);
        });
}
