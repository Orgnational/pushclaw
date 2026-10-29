#!/usr/bin/env node
// 紧急横幅（emergency-bar）组 UI 审计：jsdom 点击链测试。
// 追到的代码链（审计时点）：
//   渲染/条数  refreshEmergencyBar  app.js:65-76
//              → invoke("history",{limit:50,priority:2,archived:false}) app.js:66
//              → Rust history 命令 commands.rs:94 → store::query store.rs:307
//              （Rust 不过滤 acked，前端 app.js:67 .filter(m=>!m.acked) 负责）
//   横幅 ack   #emergency-bar 事件委托 app.js:527-535
//              → invoke("ack",{receipt}) app.js:532 → await loadHistory() app.js:533
//              → Rust ack 命令 commands.rs:148-166（pushover::acknowledge + UPDATE acked=1）
//   全确认隐藏 app.js:69（unacked.length===0 → hidden + innerHTML=""）
//   无紧急不渲染 同 app.js:69（空列表 / 全 acked 走同一分支）
//   同区域附加：new-message 事件刷新 app.js:546-549；
//              切发送/设置视图隐藏、切回消息恢复 app.js:227 / app.js:282；
//              退出登录后主视图隐藏（横幅随之不可见）app.js:448-473。
// 覆盖方式：加载真实 index.html + app.js，注入 __TAURI__ mock（invoke 记录调用、
// 可按命令返回造好的数据；listen 捕获事件处理器手动触发），dispatch 真实 click 事件，
// 断言 invoke 参数与 DOM 变化。
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function must(cond, msg) {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
}

const mkMsg = (id, receipt, title, message, acked = false) => ({
  id, title, app: "ops", message, receipt, acked,
  priority: 2, date: 1760000000, read: false, archived: false,
  html: false, url: "", umid: "u" + id, icon: "",
});

function boot(emergencyMsgs) {
  const calls = [];          // 记录全部 invoke(cmd, args)
  const listeners = {};      // listen(name, handler) 捕获
  const ackClickFeedback = []; // ack invoke 执行瞬间横幅按钮的 UI 态
  let configured = true;     // logout 后置 false，模拟会话清除
  const db = { emergency: emergencyMsgs };

  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
  const { window } = dom;
  const doc = window.document;
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "get_status") return { configured, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
      if (cmd === "history") {
        // 横幅专用查询（app.js:66）：limit=50 & priority=2
        if (args?.limit === 50 && args?.priority === 2) return db.emergency.map((m) => ({ ...m }));
        return []; // 主列表为空，隔离横幅断言
      }
      if (cmd === "ack") {
        const btn = doc.querySelector(`#emergency-bar .emg-ack[data-receipt="${args?.receipt}"]`);
        ackClickFeedback.push(btn ? { text: btn.textContent, disabled: btn.disabled } : null);
        const m = db.emergency.find((x) => x.receipt === args?.receipt);
        if (m) m.acked = true; // 模拟 Rust UPDATE messages SET acked=1
        return null;
      }
      if (cmd === "logout") { configured = false; return null; }
      if (cmd === "get_settings") return { send_token: "t", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
      if (cmd === "list_apps") return [];
      if (cmd === "list_devices") return ["mac-app"];
      return {};
    }},
    event: { listen: async (name, fn) => { listeners[name] = fn; } },
  };
  const s = doc.createElement("script");
  s.textContent = js;
  doc.body.appendChild(s);
  return { doc, calls, listeners, ackClickFeedback, db };
}

// ============ 实例 1：两条未确认 priority=2 消息 ============
const t1 = boot([
  mkMsg("9000000001", "r-receipt-1", "服务器告警", "CPU 100% 持续 5 分钟"),
  mkMsg("9000000002", "r-receipt-2", "磁盘写满", "/dev/sda1 使用率 100%"),
]);
await sleep(400); // 等启动 IIFE：refreshStatus → loadHistory → refreshEmergencyBar

// ---- F1 存在未确认 priority=2 消息时渲染横幅与条数 ----
const emqCall = t1.calls.find(([c, a]) => c === "history" && a?.limit === 50 && a?.priority === 2);
must(emqCall, "F1: 未按 {limit:50, priority:2, archived:false} 查询紧急消息（app.js:66）");
must(emqCall[1].archived === false && Object.keys(emqCall[1]).sort().join() === "archived,limit,priority",
  "F1: 紧急查询参数不精确: " + JSON.stringify(emqCall[1]));
const bar = t1.doc.getElementById("emergency-bar");
must(bar && !bar.classList.contains("hidden"), "F1: 有未确认紧急消息时横幅仍带 hidden");
must(bar.textContent.includes("2 条紧急消息待确认"),
  "F1: 横幅条数应为 2，实际: " + JSON.stringify(bar.textContent.slice(0, 80)));
must(bar.querySelectorAll(".emg-item").length === 2, "F1: 横幅条目数应为 2");
must(bar.querySelector('.emg-item[data-id="9000000001"]') && bar.querySelector('.emg-item[data-id="9000000002"]'),
  "F1: 条目未携带 data-id");
must(bar.querySelector('.emg-ack[data-receipt="r-receipt-1"]') && bar.querySelector('.emg-ack[data-receipt="r-receipt-2"]'),
  "F1: 确认按钮未携带 data-receipt");
must(bar.textContent.includes("服务器告警") && bar.textContent.includes("CPU 100%"),
  "F1: 横幅未展示消息标题/摘要");
console.log("PASS F1(emg-render): 未确认 priority=2 → 横幅渲染且条数正确（2 条）");

// ---- F2 横幅 ack 按钮 → invoke ack → 刷新 ----
t1.doc.querySelector('#emergency-bar .emg-ack[data-receipt="r-receipt-1"]').click();
await sleep(300);
const ackIdx = t1.calls.findIndex(([c, a]) => c === "ack" && a?.receipt === "r-receipt-1");
must(ackIdx >= 0, "F2: 点击横幅确认按钮未触发 invoke('ack')（app.js:527-532）");
const ackArgs = t1.calls[ackIdx][1];
must(ackArgs.receipt === "r-receipt-1" && Object.keys(ackArgs).length === 1,
  "F2: ack 参数应为 {receipt:'r-receipt-1'}，实际: " + JSON.stringify(ackArgs));
must(t1.ackClickFeedback[0] && t1.ackClickFeedback[0].text === "确认中…" && t1.ackClickFeedback[0].disabled === true,
  "F2: ack 调用瞬间按钮未进入 禁用/确认中… 反馈态（app.js:530）");
must(t1.calls.slice(ackIdx + 1).some(([c, a]) => c === "history" && a?.limit === 200),
  "F2: ack 成功后未触发 loadHistory 刷新（app.js:533）");
must(t1.calls.slice(ackIdx + 1).some(([c, a]) => c === "history" && a?.limit === 50 && a?.priority === 2),
  "F2: ack 成功后未重查紧急横幅（loadHistory→refreshEmergencyBar app.js:112）");
must(bar.textContent.includes("1 条紧急消息待确认"),
  "F2: ack 后横幅条数未变为 1，实际: " + JSON.stringify(bar.textContent.slice(0, 80)));
must(!bar.querySelector('.emg-ack[data-receipt="r-receipt-1"]'), "F2: 已确认条目未从横幅移除");
console.log("PASS F2(emg-ack): 横幅确认按钮 → invoke('ack',{receipt}) → 列表+横幅刷新，条数 2→1");

// ---- F3 全部确认后横幅隐藏 ----
t1.doc.querySelector('#emergency-bar .emg-ack[data-receipt="r-receipt-2"]').click();
await sleep(300);
must(t1.calls.some(([c, a]) => c === "ack" && a?.receipt === "r-receipt-2"), "F3: 第二条确认未调用 ack");
must(bar.classList.contains("hidden"), "F3: 全部确认后横幅未加 hidden（app.js:69）");
must(bar.innerHTML === "", "F3: 全部确认后横幅内容未清空（app.js:69）");
console.log("PASS F3(emg-hide): 全部确认后横幅隐藏且内容清空");

// ---- F5(同区域附加) new-message 事件驱动横幅刷新 ----
t1.db.emergency[0].acked = false; // 模拟新的未确认紧急消息到达
must(typeof t1.listeners["new-message"] === "function", "F5: 未捕获 new-message 事件监听");
await t1.listeners["new-message"]();
await sleep(200);
must(!bar.classList.contains("hidden") && bar.textContent.includes("1 条紧急消息待确认"),
  "F5: new-message 事件后横幅未按最新未确认数刷新（app.js:546-549）");
console.log("PASS F5(emg-new-message): new-message 事件 → 横幅按最新未确认数刷新");

// ---- F6(同区域附加) 切发送/设置视图隐藏横幅，切回消息恢复 ----
t1.doc.querySelector('.tab[data-view="send"]').click();
await sleep(200);
must(bar.classList.contains("hidden"), "F6a: 切到发送视图横幅未隐藏（app.js:227）");
t1.doc.querySelector('.tab[data-view="inbox"]').click();
await sleep(200);
must(!bar.classList.contains("hidden") && bar.textContent.includes("1 条紧急消息待确认"),
  "F6a: 切回消息视图横幅未恢复（app.js:227 toggle 条件）");
console.log("PASS F6a(emg-tab-switch): 发送视图隐藏横幅，切回消息视图恢复");
// F6b: 设置视图。view-toggle 缺陷已修复（共享元素显隐收敛到 applySharedElems，每个 tab
// 目标态只计算一次；refreshEmergencyBar 只更新内容、横幅仅在收件箱 tab 显示），
// KNOWN-BUG 守卫转正为无条件断言（恢复断言合并了条数核对，语义更严）。
t1.doc.querySelector('.tab[data-view="settings"]').click();
await sleep(200);
must(bar.classList.contains("hidden"), "F6b: 切到设置视图横幅未隐藏");
t1.doc.querySelector('.tab[data-view="inbox"]').click();
await sleep(200);
must(!bar.classList.contains("hidden") && bar.textContent.includes("1 条紧急消息待确认"),
  "F6b: 从设置切回消息横幅未恢复");
console.log("PASS F6b(emg-settings-hide): 设置视图隐藏横幅，切回消息视图恢复且条数正确");

// ---- F7(同区域附加) 退出登录 → 回登录视图，横幅随主视图不可见 ----
// 注：logout 处理器 app.js:470 显式隐藏横幅，但 setSelecting(false)→loadHistory 的
// fire-and-forget 链可能随后重查并重显横幅——该竞态被「主视图整体隐藏」掩盖
// （refreshStatus→configured=false→main-view hidden），故此处断言用户可见结果。
t1.doc.getElementById("logout-btn").click();
await sleep(80);
must(!t1.calls.some(([c]) => c === "logout"), "F7: 单击退出不应立即调用 logout（两步确认）");
t1.doc.getElementById("logout-btn").click();
await sleep(300);
must(t1.calls.some(([c]) => c === "logout"), "F7: 二次点击未调用 logout");
must(t1.doc.getElementById("main-view").classList.contains("hidden") &&
     !t1.doc.getElementById("login-view").classList.contains("hidden"),
  "F7: 退出登录后未回到登录视图（app.js:471 + app.js:171-172）");
console.log("PASS F7(emg-logout): 退出两步确认 → 回登录视图（横幅随主视图不可见）");

// ============ 实例 2：无未确认紧急消息 ============
const t2 = boot([]);
await sleep(400);
const bar2 = t2.doc.getElementById("emergency-bar");

// ---- F4a 空列表：启动即不渲染 ----
must(bar2.classList.contains("hidden") && bar2.innerHTML === "",
  "F4: 无紧急消息时启动后横幅未保持隐藏（app.js:69）");
must(t2.calls.some(([c, a]) => c === "history" && a?.limit === 50 && a?.priority === 2),
  "F4: 启动时未执行紧急查询，无法证明『不渲染』来自正确判断");
// ---- F4b 到达的紧急消息全部已确认（acked=true）→ 前端过滤后仍不渲染 ----
t2.db.emergency.push(mkMsg("9000000003", "r-receipt-3", "已确认告警", "resolved", true));
await t2.listeners["new-message"]();
await sleep(200);
must(bar2.classList.contains("hidden") && bar2.innerHTML === "",
  "F4: 仅 acked=true 消息时横幅未保持隐藏（app.js:67 filter）");
must(!bar2.querySelector(".emg-ack"), "F4: 不应出现确认按钮");
console.log("PASS F4(emg-none): 空列表 / 全 acked 两态 → 横幅不渲染");

console.log("紧急横幅组审计全部 PASS（F1 渲染条数 / F2 ack+刷新 / F3 全确认隐藏 / F4 无紧急不渲染 / F5-F7 同区域附加）");
