#!/usr/bin/env node
// 「Rust 事件桥」控件点击链审计：login-success / read-sync / new-message / ws-status / ws-error / do-sync / navigate-latest
// 模式照抄 tests/test_ui_audit_header.mjs（jsdom 载入真实 index.html + app.js，
// 注入 __TAURI__ mock：invoke 记录调用并按命令返回造好的数据、listen 捕获事件处理器，
// 手动 fire 模拟 Rust 侧 app.emit(...)，断言到 invoke 参数与 DOM 状态。
// 已知产品缺陷（navigate-latest 定位）已修复，本文件断言全部无条件执行。
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
const { window } = dom;
const doc = window.document;

const calls = [];
const listeners = {};
// 启动态：未登录（Rust login 命令保存会话后才 emit login-success，见 commands.rs:67→89）
let statusResp = { configured: false, email: "", device_name: "", connected: false, version: "t", device_registered: false };
let historyRows = [
  { id: "101", title: "第一条", message: "hello", app: "AppA", priority: 0, date: 1761792000, read: false, acked: true, archived: false, html: false, receipt: "" },
  { id: "102", title: "第二条", message: "world", app: "AppB", priority: 1, date: 1761792060, read: true, acked: true, archived: false, html: false, receipt: "" },
];
let urgentRows = [];   // refreshEmergencyBar 查询（limit:50, priority:2）的返回

window.__TAURI__ = {
  core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "get_status") return statusResp;
    if (cmd === "history") {
      if (args?.priority === 2 && args?.limit === 50) return urgentRows;
      return historyRows;
    }
    if (cmd === "get_settings") return { send_token: "t", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
    if (cmd === "list_apps") return [];
    if (cmd === "list_devices") return ["mac-app"];
    if (cmd === "sync_now") return 2;
    if (cmd === "get_icon") return null;
    return {};
  }},
  event: { listen: async (name, handler) => { (listeners[name] ??= []).push(handler); return () => {}; } },
};
const s = doc.createElement("script");
s.textContent = js;
doc.body.appendChild(s);
await new Promise((r) => setTimeout(r, 300));

const $ = (id) => doc.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fire = async (name, ev) => { for (const h of listeners[name] ?? []) await h(ev); };
let failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS:", label); return; }
  failed++;
  console.error("FAIL:", label, detail === undefined ? "" : JSON.stringify(detail));
}
const mark = () => calls.length;
const after = (m) => calls.slice(m);

// ---- ⓪ 前置：7 个事件全部注册了监听；未登录启动不拉历史 ----
const EVENTS = ["login-success", "read-sync", "new-message", "ws-status", "ws-error", "do-sync", "navigate-latest"];
check("app.js 对 7 个 Rust 事件各注册了一个监听器",
  EVENTS.every((n) => listeners[n]?.length === 1),
  Object.keys(listeners));
check("启动（未登录）只调 get_status、不拉 history", !calls.some(([c]) => c === "history"), calls.map(([c]) => c));
check("启动未登录：登录视图可见", !$("login-view").classList.contains("hidden"));
check("启动未登录：主视图隐藏", $("main-view").classList.contains("hidden"));
check("启动未登录：device-label 显示 '未登录'", $("device-label").textContent === "未登录", $("device-label").textContent);

// ---- ① login-success：切视图 + refreshStatus + loadHistory ----
// 真实链路：login 命令先 save_session（commands.rs:67）再 emit("login-success")（commands.rs:89），
// 故事件到达时 get_status 已返回 configured:true——mock 按此顺序翻转 statusResp。
statusResp = { configured: true, email: "me@example.com", device_name: "MacBook-Pro", connected: true, version: "t", device_registered: true };
let m = mark();
const p1 = fire("login-success", { payload: "MacBook-Pro" });
// 处理器同步段（app.js:540-541）先手改视图，之后才 await refreshStatus——分发后立即断言
check("login-success 同步切视图：login-view 立即隐藏（双保险，app.js:540）",
  $("login-view").classList.contains("hidden"));
check("login-success 同步切视图：main-view 立即显示（app.js:541）",
  !$("main-view").classList.contains("hidden"));
await p1;
await sleep(150);
check("login-success 后触发 refreshStatus（invoke get_status）",
  after(m).some(([c]) => c === "get_status"), after(m).map(([c]) => c));
const h1 = after(m).find(([c, a]) => c === "history" && a?.limit === 200);
check("login-success 后触发 loadHistory（invoke history limit:200）", !!h1, after(m).map(([c]) => c));
check("login-success 的 loadHistory 参数 archived:false / query:null",
  !!h1 && h1[1].archived === false && h1[1].query === null, h1?.[1]);
check("login-success 后 device-label 显示 '设备名 · 邮箱'（refreshStatus）",
  $("device-label").textContent === "MacBook-Pro · me@example.com", $("device-label").textContent);
check("login-success 后 conn-dot on（status.connected=true）", $("conn-dot").className === "dot on", $("conn-dot").className);

// ---- ② read-sync：触发 loadHistory（app.js:545；Rust 发射点 pushover.rs:568 / commands.rs:333）----
m = mark();
await fire("read-sync", { payload: ["u1", "u2"] });
await sleep(150);
const h2 = after(m).find(([c, a]) => c === "history" && a?.limit === 200);
check("read-sync 事件触发 loadHistory（invoke history limit:200）", !!h2, after(m).map(([c]) => c));
check("read-sync 后列表计数更新为 '显示 2 条'", $("count-label").textContent === "显示 2 条", $("count-label").textContent);

// ---- ③ new-message：inbox 视图刷新列表 + 总是刷新紧急横幅（app.js:546-549；发射点 pushover.rs:596）----
urgentRows = [
  { id: "201", title: "紧急A", message: "服务器着火了", app: "AppA", priority: 2, date: 1761792100, read: false, acked: false, archived: false, html: false, receipt: "r-201" },
  { id: "202", title: "紧急B", message: "已确认过的紧急", app: "AppA", priority: 2, date: 1761792101, read: false, acked: true, archived: false, html: false, receipt: "r-202" },
];
check("事件前紧急横幅隐藏（urgentRows 为空）", $("emergency-bar").classList.contains("hidden"));
m = mark();
await fire("new-message", { payload: { id: 103, title: "新消息", priority: 0 } });
await sleep(200);
check("new-message（inbox 视图）触发列表刷新 history limit:200",
  after(m).some(([c, a]) => c === "history" && a?.limit === 200), after(m).map(([c]) => c));
const eb = after(m).find(([c, a]) => c === "history" && a?.limit === 50 && a?.priority === 2);
check("new-message 触发横幅刷新 history(limit:50, priority:2, archived:false)",
  !!eb && eb[1].archived === false, after(m).filter(([c]) => c === "history").map(([, a]) => a));
check("new-message 后紧急横幅显示", !$("emergency-bar").classList.contains("hidden"));
check("紧急横幅按 acked 过滤：只显示 1 条待确认（'🚨 1 条紧急消息待确认'）",
  $("emergency-bar").textContent.includes("🚨 1 条紧急消息待确认"), $("emergency-bar").textContent.slice(0, 60));
check("紧急横幅渲染确认按钮（.emg-ack 携带 data-receipt）",
  doc.querySelector("#emergency-bar .emg-ack")?.dataset.receipt === "r-201",
  doc.querySelector("#emergency-bar .emg-ack")?.dataset.receipt);
check("紧急横幅条目携带 data-id", doc.querySelector("#emergency-bar .emg-item")?.dataset.id === "201",
  doc.querySelector("#emergency-bar .emg-item")?.dataset.id);

// 分支：非 inbox 视图（归档）→ 不刷新列表，横幅仍刷新
doc.querySelector('.tab[data-view="archive"]').click();
await sleep(250);   // 归档 tab 自身的 loadHistory(archived:true) 完成
m = mark();
await fire("new-message", { payload: { id: 104, title: "又一条", priority: 0 } });
await sleep(200);
check("new-message（archive 视图）不触发列表刷新（无 history limit:200）",
  !after(m).some(([c, a]) => c === "history" && a?.limit === 200), after(m).map(([c, a2]) => [c, a2?.limit]));
check("new-message（archive 视图）仍刷新紧急横幅（history limit:50 priority:2）",
  after(m).some(([c, a]) => c === "history" && a?.limit === 50 && a?.priority === 2), after(m).map(([c]) => c));
doc.querySelector('.tab[data-view="inbox"]').click();
await sleep(250);

// ---- ⑤ ws-error：view-hint 持续显示 '⚠ ' + payload（app.js:555-558；发射点 pushover.rs:689/703/718/728/744）----
await fire("ws-error", { payload: "连接中断: E帧" });
check("ws-error → view-hint 显示 '⚠ ' + payload",
  $("view-hint").textContent === "⚠ 连接中断: E帧", $("view-hint").textContent);

// ---- ④ ws-status：conn-dot 随 payload 切换；connected 恢复时清除 ⚠（app.js:550-554；发射点 pushover.rs:696/699）----
await fire("ws-status", { payload: "reconnecting" });
check("ws-status 'reconnecting' → conn-dot off", $("conn-dot").className === "dot off", $("conn-dot").className);
check("reconnecting 不清除 ws-error 文案", $("view-hint").textContent === "⚠ 连接中断: E帧", $("view-hint").textContent);
await fire("ws-status", { payload: "connected" });
check("ws-status 'connected' → conn-dot on", $("conn-dot").className === "dot on", $("conn-dot").className);
check("恢复连接（connected）清除 view-hint 的 ⚠ 文案", $("view-hint").textContent === "", $("view-hint").textContent);

// ---- ⑥ do-sync：Rust fetch_and_store 收尾发射 → 前端监听器触发 loadHistory（app.js:612）----
// 缺陷 do-sync-emit 已修复，KNOWN-BUG 守卫转正为无条件断言：pushover.rs 的 fetch_and_store
// 在函数收尾（Ok 返回前、含 0 新消息路径）emit("do-sync")；托盘 "sync" 菜单（main.rs:134）
// 与 sync_now 命令（commands.rs:504）都经此路径，0 条新消息也通知前端刷新列表。
// 静态半链：发射点必须位于 fetch_and_store 函数体内所有提前 return 之后（真正收尾）。
const pushoverRs = readFileSync(join(root, "app/src-tauri/src/pushover.rs"), "utf8");
const fnStart = pushoverRs.indexOf("pub async fn fetch_and_store");
const fnBody = fnStart >= 0
  ? pushoverRs.slice(fnStart, pushoverRs.indexOf("/// 广播已读信令", fnStart))
  : "";
const emitIdx = fnBody.indexOf('emit("do-sync"');
check("Rust fetch_and_store 内存在 emit(\"do-sync\")（事件桥 Rust 半链）",
  fnStart >= 0 && emitIdx >= 0, `定位 fetch_and_store=${fnStart >= 0}，emit("do-sync")=${emitIdx >= 0}`);
check("emit(\"do-sync\") 位于 fetch_and_store 收尾（其后至函数尾无提前 return）",
  emitIdx >= 0 && fnBody.lastIndexOf("return ") < emitIdx,
  `emit@${emitIdx}，最后 return@${fnBody.lastIndexOf("return ")}`);
m = mark();
await fire("do-sync", { payload: null });
await sleep(150);
check("do-sync 事件触发 loadHistory（invoke history limit:200）",
  after(m).some(([c, a]) => c === "history" && a?.limit === 200), after(m).map(([c]) => c));

// ---- ⑦ navigate-latest：切回收件箱 + 定位最新消息（app.js:560-567；发射点 main.rs:178 macOS Reopen）----
// jsdom 未实现 scrollIntoView：打桩计数，若产品修复后元素存在也不至于抛错
const scrollCalls = [];
window.HTMLElement.prototype.scrollIntoView = function (opts) { scrollCalls.push(opts); };
doc.querySelector('.tab[data-view="archive"]').click();
await sleep(250);
check("前置：当前在归档视图（archive tab active）", doc.querySelector('.tab[data-view="archive"]').classList.contains("active"));
m = mark();
await fire("navigate-latest", { payload: 101 });
await sleep(250);
check("navigate-latest 切回消息 tab（inbox active）",
  doc.querySelector('.tab[data-view="inbox"]').classList.contains("active"),
  [...doc.querySelectorAll(".tab")].map((t) => `${t.dataset.view}:${t.classList.contains("active")}`));
check("navigate-latest 归档 tab 失活", !doc.querySelector('.tab[data-view="archive"]').classList.contains("active"));
const h7 = after(m).find(([c, a]) => c === "history" && a?.limit === 200 && a?.archived === false);
check("navigate-latest 触发 loadHistory（history limit:200 archived:false）", !!h7, after(m).map(([c, a2]) => [c, a2?.limit, a2?.archived]));
check("navigate-latest 后回到收件箱（列表可见）", !$("list").classList.contains("hidden"));
// 定位部分（navigate-latest 定位缺陷已修复）：loadHistory 渲染的卡片现带 id="msg-<消息id>"，
// app.js 的 getElementById(`msg-${payload}`) 能找到目标——KNOWN-BUG 守卫转正为无条件断言。
check("navigate-latest 应能找到 #msg-<id> 定位目标（列表项渲染 id='msg-<id>'）",
  doc.getElementById("msg-101") !== null, `msg-101 存在=${doc.getElementById("msg-101") !== null}`);
check("navigate-latest 应调用 scrollIntoView({behavior:'smooth', block:'center'})",
  scrollCalls.length === 1 && scrollCalls[0]?.behavior === "smooth" && scrollCalls[0]?.block === "center",
  scrollCalls);

if (failed) { console.error(`\n${failed} 项断言失败`); process.exit(1); }
console.log("\nRust 事件桥：全部断言 PASS");
