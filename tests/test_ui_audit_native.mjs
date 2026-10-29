#!/usr/bin/env node
// UI 审计：原生层（托盘/窗口）组（2026-10-30 审计）
// 覆盖：1) 托盘菜单 显示主窗口/立即同步/退出  2) 托盘左键点击窗口显隐切换
//       3) 关窗隐藏到托盘不退出  4) macOS Reopen（Dock/通知点击）定位最新消息  5) 单实例二次启动唤起已有窗口
//
// 分工：
//  - 1/2/3/5 与 4 的 Rust 侧属纯原生层（托盘/窗口/run-loop 事件），jsdom 无法触达：
//    本文件做静态代码链路断言（读 main.rs / lib.rs / Cargo.toml / tauri.conf.json 源文本，
//    断言 事件入口 → 处理器 → 行为 的每一环都存在于代码中），报告中标 NATIVE。
//  - 4 的前端事件链（navigate-latest → 切回消息 tab → 重载列表 → 滚动定位 #msg-<id>）
//    在 jsdom 中真实触发验证：捕获 listen 处理器后手动 dispatch，断言到 invoke 参数与 DOM 状态。
// 骨架照抄 tests/test_send_button.mjs / test_ui_audit_tabs.mjs。
import { JSDOM } from "jsdom";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const mainRs = read("app/src-tauri/src/main.rs");
const libRs = read("app/src-tauri/src/lib.rs");
const cargoToml = read("app/src-tauri/Cargo.toml");
const tauriConf = read("app/src-tauri/tauri.conf.json");
const appJs = read("app/ui/app.js");

const html = read("app/ui/index.html");
const js = read("app/ui/app.js");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
const { window } = dom;
const doc = window.document;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 取 startMarker 到其后第一个 endMarker 之间的源码块
const block = (src, startMarker, endMarker) => {
  const i = src.indexOf(startMarker);
  if (i < 0) return "";
  const j = src.indexOf(endMarker, i + startMarker.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
};

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log("  PASS:", label);
  else { failed++; console.error("  FAIL:", label); }
};

// =====================================================================
// 第一部分：静态代码链路断言（NATIVE 组——jsdom 触达不到的原生层）
// =====================================================================
console.log("== 静态链路 1) tray-menu：托盘菜单 显示主窗口/立即同步/退出 ==");
ok(mainRs.includes('MenuItemBuilder::with_id("show", "显示主窗口")'),
   'main.rs 定义菜单项 id="show" 文案「显示主窗口」');
ok(mainRs.includes('MenuItemBuilder::with_id("sync", "立即同步")'),
   'main.rs 定义菜单项 id="sync" 文案「立即同步」');
ok(mainRs.includes('MenuItemBuilder::with_id("quit", "退出")'),
   'main.rs 定义菜单项 id="quit" 文案「退出」');
const trayMenuBlock = block(mainRs, 'TrayIconBuilder::with_id("main")', ".build(app)?");
ok(trayMenuBlock.includes(".menu(&menu)") && trayMenuBlock.includes(".show_menu_on_left_click(false)"),
   "托盘挂载菜单且左键点击不弹菜单（show_menu_on_left_click(false)，左键留给显隐切换）");
ok(trayMenuBlock.includes('"show" => show_main(app)'),
   '菜单事件 "show" → show_main(app)（lib.rs show_main = get_webview_window("main") + show + set_focus）');
ok(libRs.includes('pub fn show_main') && block(libRs, "pub fn show_main", "}").includes('get_webview_window("main")'),
   "lib.rs:show_main 确实对 main 窗口 show + set_focus");
ok(trayMenuBlock.includes('"sync" =>') && trayMenuBlock.includes("fetch_and_store"),
   '菜单事件 "sync" → spawn fetch_and_store（与命令行 sync_now 同一拉取函数，commands.rs:sync_now 亦包它）');
ok(trayMenuBlock.includes('"quit" => app.exit(0)'),
   '菜单事件 "quit" → app.exit(0) 真正退出进程');
ok(mainRs.includes('tauri::include_image!("icons/tray.png")') &&
   existsSync(join(root, "app/src-tauri/icons/tray.png")),
   "托盘图标 assets/tray.png 存在（include_image! 缺文件会编译失败）");

console.log("== 静态链路 2) tray-left-click-toggle：托盘左键点击窗口显隐切换 ==");
const trayClickBlock = block(mainRs, ".on_tray_icon_event(", ".build(app)?");
ok(trayClickBlock.includes("TrayIconEvent::Click") &&
   trayClickBlock.includes("MouseButton::Left") &&
   trayClickBlock.includes("MouseButtonState::Up"),
   "on_tray_icon_event 只响应左键（Left + Up）Click 事件");
ok(trayClickBlock.includes("is_visible()") && trayClickBlock.includes("w.hide()") &&
   trayClickBlock.includes("w.show()") && trayClickBlock.includes("set_focus()"),
   "可见则 hide、不可见则 show+set_focus（显隐切换语义完整）");

console.log("== 静态链路 3) close-to-tray：关窗隐藏到托盘不退出 ==");
const closeBlock = block(mainRs, ".on_window_event(", ".build(tauri::generate_context!())");
ok(closeBlock.includes("WindowEvent::CloseRequested") && closeBlock.includes("api.prevent_close()"),
   "CloseRequested → api.prevent_close() 拦截默认关闭（进程不退出）");
ok(closeBlock.includes("window.hide()"), "拦截后 window.hide() 隐藏到托盘");
ok(!closeBlock.includes("app.exit"), "关窗路径不含 app.exit（不会连带退出进程）");

console.log("== 静态链路 5) single-instance：单实例二次启动唤起已有窗口 ==");
ok(cargoToml.includes("tauri-plugin-single-instance"),
   "Cargo.toml 声明 tauri-plugin-single-instance 依赖");
const siBlock = block(mainRs, "tauri_plugin_single_instance::init(", "}))");
ok(siBlock.includes('get_webview_window("main")') && siBlock.includes("w.show()") &&
   siBlock.includes("set_focus()"),
   "单实例回调：已有实例收到二次启动 → main 窗口 show + set_focus（唤起到前台）");
ok(mainRs.indexOf("tauri_plugin_single_instance::init") < mainRs.indexOf(".setup("),
   "single-instance 插件先于 setup 注册（Tauri 要求尽早在 Builder 上注册）");

console.log("== 静态链路 4a) reopen-rust：macOS Reopen → emit navigate-latest + show_main（NATIVE 侧） ==");
const runBlock = block(mainRs, ".run(|app, event|", ");\n}");
ok(runBlock.includes("RunEvent::Reopen"), "run 循环处理 RunEvent::Reopen（Dock/通知点击重新激活）");
ok(runBlock.includes("latest_new") && runBlock.includes('emit("navigate-latest", id)'),
   "Reopen → 读 AppState.latest_new（pushover.rs 新消息入库时写入）→ emit navigate-latest(id)");
ok(runBlock.includes("show_main(app)"), "Reopen → show_main(app)（先弹窗）");
ok(mainRs.includes("cfg(target_os = \"macos\")") || mainRs.includes('#[cfg(target_os = "macos")]'),
   "Reopen 分支限定 macOS");
ok(libRs.includes("pub latest_new: Mutex<Option<i64>>") &&
   read("app/src-tauri/src/pushover.rs").includes("*st.latest_new.lock()"),
   "latest_new 状态定义于 lib.rs，pushover.rs:fetch_and_store 新消息入库时写入");

console.log("== 静态链路 4b) window-label：tauri.conf.json 默认窗口 label=main 与 get_webview_window(\"main\") 对齐 ==");
ok(JSON.parse(tauriConf).app.windows[0].label === undefined &&
   (mainRs.includes('get_webview_window("main")') || libRs.includes('get_webview_window("main")')),
   "tauri.conf.json 窗口未设 label（Tauri 默认 label=main），与代码中 get_webview_window(\"main\") 一致");
ok(JSON.parse(tauriConf).app.withGlobalTauri === true,
   "withGlobalTauri=true：window.__TAURI__ 全局存在（app.js 前两行的依赖前提）");

// =====================================================================
// 第二部分：jsdom 行为验证——navigate-latest 前端事件链（4 的前端半边）
// =====================================================================
console.log("== jsdom 行为链 4c) navigate-latest：事件 → 切回消息 tab → 重载列表 → 滚动定位 ==");
const calls = [];       // [cmd, args] 全量记录
const listeners = {};   // 事件名 -> 处理器（Rust emit 侧，供手动触发）
const INBOX = [
  { id: "999", umid: "u9", app: "NetMon", title: "最新消息", message: "最新正文", date: 1760000999, priority: 0, read: false, acked: false, archived: false },
  { id: "901", umid: "u1", app: "AppA", title: "旧消息", message: "旧正文", date: 1760000901, priority: 0, read: true, acked: true, archived: false },
];
window.__TAURI__ = {
  core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
    if (cmd === "get_settings") return { send_token: "t", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
    if (cmd === "history") {
      if (args?.priority === 2) return [];          // 紧急横幅查询造空，保持横幅隐藏不干扰
      return args?.archived ? [] : INBOX;           // 消息范围 2 条 / 归档范围 0 条
    }
    if (cmd === "list_apps") return [];
    return {};
  }},
  event: { listen: async (name, handler) => { listeners[name] = handler; } },
};
// jsdom 未实现 scrollIntoView：polyfill 记录调用，供定位断言
const scrollCalls = [];
window.Element.prototype.scrollIntoView = function (...a) { scrollCalls.push([this, ...a]); };

const s = doc.createElement("script");
s.textContent = js;
doc.body.appendChild(s);
await wait(300);

const activeViews = () => [...doc.querySelectorAll(".tab.active")].map((t) => t.dataset.view);
const tab = (v) => doc.querySelector(`.tab[data-view="${v}"]`);

ok(typeof listeners["navigate-latest"] === "function", "app.js 已订阅 navigate-latest 事件（Rust Reopen/通知侧的对端）");

// 前置：制造「应用被点击时用户正停在其它 tab」的场景——切到归档 tab（真实点击）
tab("archive").click();
await wait(250);
ok(activeViews().length === 1 && activeViews()[0] === "archive", "前置：用户当前停在归档 tab（真实点击切换）");

// Rust Reopen 链路在此事件汇合：emit("navigate-latest", <i64 消息id>)（main.rs run 循环）
const mark = calls.length;
await listeners["navigate-latest"]({ payload: Number(INBOX[0].id) });   // Rust 侧 payload 为 i64
await wait(300);

ok(activeViews().length === 1 && activeViews()[0] === "inbox",
   "navigate-latest 触发后自动切回消息 tab（处理器内部真实 dispatch click）");
const historyAfter = calls.slice(mark).filter(([c, a]) => c === "history" && !!a?.archived === false);
ok(historyAfter.length >= 1, "navigate-latest 触发 loadHistory 重载（history invoked with archived=false）");
ok(doc.getElementById("count-label").textContent === "显示 2 条",
   "重载后 count-label 刷新为消息范围（显示 2 条）");

// 关键断言：定位最新消息。卡片必须渲染 id="msg-<消息id>" 才可能被 getElementById 找到滚动。
// navigate-latest 定位缺陷已修复：loadHistory 现渲染 id="msg-<id>"（与 data-id 并存），
// getElementById('msg-…') 能找到目标——KNOWN-BUG 守卫转正为无条件断言。
const scrollTarget = doc.getElementById(`msg-${INBOX[0].id}`);
const rendered = [...doc.querySelectorAll("#list .m")].map((el) => el.dataset.id);
ok(rendered.includes(String(INBOX[0].id)),
   `前置：最新消息卡片确已渲染（data-id=${INBOX[0].id} 在列表中），排除「消息不在列表」的假阴性`);
ok(scrollTarget !== null,
   "navigate-latest 应能找到 #msg-<id> 滚动定位目标（列表卡片渲染 id=\"msg-<id>\"）");
ok(scrollCalls.some(([el]) => el === scrollTarget),
   "找到目标后应调用 scrollIntoView 定位");

console.log(failed ? `\n${failed} 项断言失败` : "\n原生层（托盘/窗口）组审计测试 PASS（原生侧为静态链路断言，前端侧为 jsdom 点击链）");
process.exit(failed ? 1 : 0);
