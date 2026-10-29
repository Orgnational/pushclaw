#!/usr/bin/env node
// 「顶部操作与状态栏」控件点击链审计：readall / sync / logout / conn-dot / device-label / ws-error
// （另核对 header 同区域清单外控件：tabs、select-btn）
// 模式照抄 tests/test_send_button.mjs：jsdom 载入真实 index.html + app.js，
// 注入 __TAURI__ mock（invoke 记录调用、listen 捕获事件处理器），dispatch 真实 click 事件。
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
let historyRows = [
  { id: "101", title: "第一条", message: "hello", app: "AppA", priority: 0, date: 1761792000, read: false, acked: true, archived: false },
  { id: "102", title: "第二条", message: "world", app: "AppB", priority: 1, date: 1761792060, read: true, acked: true, archived: false },
];
let statusResp = { configured: true, email: "me@example.com", device_name: "MacBook-Pro", connected: true, version: "t", device_registered: true };

window.__TAURI__ = {
  core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "get_status") return statusResp;
    if (cmd === "history") return historyRows;
    if (cmd === "get_settings") return { send_token: "t", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
    if (cmd === "list_apps") return [];
    if (cmd === "list_devices") return ["mac-app"];
    if (cmd === "sync_now") return 2;
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
const lastCall = (cmd, from) => {
  for (let i = calls.length - 1; i >= (from ?? 0); i--) if (calls[i][0] === cmd) return calls[i];
  return null;
};
let failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS:", label); return; }
  failed++;
  console.error("FAIL:", label, detail === undefined ? "" : JSON.stringify(detail));
}

// ---- ① device-label：登录态显示 设备名 · 邮箱（app.js refreshStatus → get_status）----
check("device-label 登录态显示 '设备名 · 邮箱'",
  $("device-label").textContent === "MacBook-Pro · me@example.com",
  $("device-label").textContent);
check("启动 get_status.connected=true → conn-dot on", $("conn-dot").className === "dot on", $("conn-dot").className);

// ---- ② readall 两步确认 + 4 秒回退（app.js readall-btn handler）----
let mark = calls.length;
$("readall-btn").click();
await sleep(50);
check("readall 第一次点击：进入确认态 dataset.armed=1", $("readall-btn").dataset.armed === "1", $("readall-btn").dataset.armed);
check("readall 第一次点击：按钮加 armed 样式类", $("readall-btn").classList.contains("armed"));
check("readall 第一次点击：title 提示再点一次", $("readall-btn").title === "再点一次确认全部已读", $("readall-btn").title);
check("readall 第一次点击：不触发 mark_all_read（两步确认）", !lastCall("mark_all_read", mark));

await sleep(4600);   // 4 秒回退窗口 + 余量
check("readall 4 秒后回退：armed 清除", $("readall-btn").dataset.armed === undefined, $("readall-btn").dataset.armed);
check("readall 4 秒后回退：armed 样式类移除", !$("readall-btn").classList.contains("armed"));
check("readall 4 秒后回退：title 恢复", $("readall-btn").title === "全部标记为已读", $("readall-btn").title);

mark = calls.length;
$("readall-btn").click();   // 再次武装
await sleep(30);
$("readall-btn").click();   // 确认执行
await sleep(250);
const mr = lastCall("mark_all_read", mark);
check("readall 二次点击后 invoke('mark_all_read') 被调用", !!mr, calls.slice(mark).map((c) => c[0]));
const mrIdx = calls.indexOf(mr);
// loadHistory 的特征参数是 limit:200（refreshEmergencyBar 是 limit:50/priority:2，须排除）
const hiAfterMr = mr && calls.some((c, i) => i > mrIdx && c[0] === "history" && c[1]?.limit === 200);
check("readall 确认后刷新列表（mark_all_read 之后调用 history）", hiAfterMr);

// ---- ③ sync：点击 → sync_now → 刷新列表（app.js sync-btn handler）----
mark = calls.length;
$("sync-btn").click();
await sleep(250);
const sn = lastCall("sync_now", mark);
check("sync 点击触发 invoke('sync_now')", !!sn, calls.slice(mark).map((c) => c[0]));
const snIdx = calls.indexOf(sn);
check("sync 后刷新列表（sync_now 之后调用 history）", !!sn && calls.some((c, i) => i > snIdx && c[0] === "history" && c[1]?.limit === 200));
check("sync 后列表计数更新为 '显示 2 条'", $("count-label").textContent === "显示 2 条", $("count-label").textContent);

// ---- ④ tabs（header 内清单外控件）：视图切换传递 archived 参数 ----
mark = calls.length;
doc.querySelector('.tab[data-view="archive"]').click();
await sleep(250);
// loadHistory 的特征参数 limit:200（refreshEmergencyBar 的 history(limit:50) 须排除）
const ha = calls.slice(mark).find(([c, a]) => c === "history" && a?.limit === 200);
check("归档 tab 点击 → history(archived:true)", !!ha && ha[1]?.archived === true, ha?.[1]);
check("归档视图计数含 '归档' 前缀", $("count-label").textContent.startsWith("归档"), $("count-label").textContent);
doc.querySelector('.tab[data-view="inbox"]').click();
await sleep(250);
const hi2 = calls.slice(mark).find(([c, a]) => c === "history" && a?.limit === 200 && a?.archived === false);
check("消息 tab 点击 → history(archived:false)", !!hi2, calls.slice(mark).filter(([c]) => c === "history").map((c) => c[1]));

// ---- ⑤ select-btn（header 内清单外控件）：多选模式开关 ----
mark = calls.length;
$("select-btn").click();
await sleep(250);
check("select-btn 点击进入多选：batch-bar 显示", !$("batch-bar").classList.contains("hidden"));
check("select-btn 点击进入多选：按钮加 active-ghost", $("select-btn").classList.contains("active-ghost"));
check("select-btn 进入多选后重载列表", !!lastCall("history", mark));
$("select-btn").click();
await sleep(250);
check("select-btn 再点退出多选：batch-bar 隐藏", $("batch-bar").classList.contains("hidden"));

// ---- ⑥ ws-error：⚠ 文案持续显示（app.js listen('ws-error')）----
await fire("ws-error", { payload: "连接中断: E帧" });
check("ws-error 事件 → view-hint 显示 '⚠ ' + payload",
  $("view-hint").textContent === "⚠ 连接中断: E帧", $("view-hint").textContent);

// ---- ⑦ conn-dot：随 ws-status 事件切换；恢复连接清除 ⚠ ----
await fire("ws-status", { payload: "reconnecting" });
check("ws-status 'reconnecting' → conn-dot off", $("conn-dot").className === "dot off", $("conn-dot").className);
check("reconnecting 不清除 ⚠ 文案", $("view-hint").textContent === "⚠ 连接中断: E帧", $("view-hint").textContent);
await fire("ws-status", { payload: "connected" });
check("ws-status 'connected' → conn-dot on", $("conn-dot").className === "dot on", $("conn-dot").className);
check("恢复连接（connected）清除 view-hint ⚠ 文案", $("view-hint").textContent === "", $("view-hint").textContent);

// ---- ⑧ logout 两步确认 → invoke logout → 回登录视图（app.js logout-btn handler）----
mark = calls.length;
$("logout-btn").click();
await sleep(50);
check("logout 第一次点击：进入确认态 dataset.armed=1", $("logout-btn").dataset.armed === "1", $("logout-btn").dataset.armed);
check("logout 第一次点击：不触发 invoke('logout')", !lastCall("logout", mark));
statusResp = { configured: false, email: "", device_name: "", connected: false, version: "t", device_registered: false };
$("logout-btn").click();
await sleep(300);
check("logout 第二次点击触发 invoke('logout')", !!lastCall("logout", mark), calls.slice(mark).map((c) => c[0]));
check("logout 后回到登录视图（login-view 可见）", !$("login-view").classList.contains("hidden"));
check("logout 后主视图隐藏", $("main-view").classList.contains("hidden"));
check("logout 后 device-label 显示 '未登录'", $("device-label").textContent === "未登录", $("device-label").textContent);
check("logout 后 conn-dot off（status.connected=false）", $("conn-dot").className === "dot off", $("conn-dot").className);
check("logout 后紧急横幅隐藏", $("emergency-bar").classList.contains("hidden"));

if (failed) { console.error(`\n${failed} 项断言失败`); process.exit(1); }
console.log("\n顶部操作与状态栏：全部断言 PASS");
