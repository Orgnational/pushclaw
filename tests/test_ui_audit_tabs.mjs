#!/usr/bin/env node
// UI 审计：标签页与视图切换组（2026-10-30 审计）
// 覆盖：1) 四个 tab 点击切换 active 类  2) 设置/发送 tab 隐藏搜索栏与优先级筛选、显示对应视图
//       3) 消息/归档切换调用 loadHistory 且 archived 参数正确  4) 切 tab 清空多选状态
//       5) count-label 显示当前范围条数
// 另含同区域清单外核对：navigate-latest 事件驱动 tab 切回+滚动定位；设置/发送 tab 下批量栏与多选状态残留
// （batchbar-persist、navigate-latest 定位均已修复：断言无条件执行）。
// 规矩：加载真实 index.html + app.js，注入 __TAURI__ mock，dispatch 真实 click，
//       断言到 invoke 参数与 DOM 状态。AUDIT_STRICT=1 时把已知产品缺陷当失败跑。
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

const calls = [];       // [cmd, args] 全量记录
const listeners = {};   // 事件名 -> 处理器（供手动触发）
const INBOX = [1, 2, 3].map((i) => ({
  id: String(100 + i), umid: "u" + i, app: "App" + i, title: "T" + i,
  message: "正文" + i, date: 1760000000 + i, priority: i === 1 ? 2 : 0,
  read: true, acked: true, archived: false,
}));
const ARCHIVE = [1, 2].map((i) => ({
  id: String(200 + i), umid: "a" + i, app: "App" + i, title: "A" + i,
  message: "归档正文" + i, date: 1760000000 + i, priority: 0,
  read: true, acked: true, archived: true,
}));

window.__TAURI__ = {
  core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
    if (cmd === "get_settings") return { send_token: "t", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
    if (cmd === "history") {
      if (args?.priority === 2) return [];          // 紧急横幅查询造空，保持横幅隐藏不干扰
      return args?.archived ? ARCHIVE : INBOX;      // 消息范围 3 条 / 归档范围 2 条
    }
    if (cmd === "list_apps") return ["TestApp"];
    if (cmd === "list_devices") return ["mac-app", "phone"];
    return {};
  }},
  event: { listen: async (name, handler) => { listeners[name] = handler; } },
};
const s = doc.createElement("script");
s.textContent = js;
doc.body.appendChild(s);
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
await settle();

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log("  PASS:", label);
  else { failed++; console.error("  FAIL:", label); }
};
const tab = (v) => doc.querySelector(`.tab[data-view="${v}"]`);
const activeViews = () => [...doc.querySelectorAll(".tab.active")].map((t) => t.dataset.view);

// ===== 1) 四个 tab 点击切换 active 类 =====
console.log("== 1) tab-active：四个 tab 点击切换 active 类 ==");
const tabs = [...doc.querySelectorAll(".tab")];
ok(tabs.length === 4 && ["inbox", "archive", "send", "settings"].every((v) => tab(v)),
   "index.html 存在 4 个 .tab（inbox/archive/send/settings）");
ok(activeViews().length === 1 && activeViews()[0] === "inbox", "初始仅 inbox tab 拥有 active 类");
for (const v of ["send", "settings", "archive", "inbox"]) {
  tab(v).click();
  await settle();
  ok(activeViews().length === 1 && activeViews()[0] === v,
     `点击 ${v} tab 后仅它拥有 active 类（旧 active 被移除）`);
}

// ===== 2) 设置/发送 tab 隐藏搜索栏与优先级筛选、显示对应视图 =====
console.log("== 2) view-toggle：设置/发送 tab 隐藏搜索栏与优先级筛选、显示对应视图 ==");
const toolbar = doc.getElementById("search").closest(".toolbar");
ok(toolbar && !toolbar.classList.contains("hidden"), "基线：.toolbar（含 #search 与 #priority-chips）可见");
ok(toolbar.contains(doc.getElementById("priority-chips")), "前置：优先级筛选 chips 位于同一 .toolbar 容器内");

let mark = calls.length;
tab("send").click();
await settle();
ok(toolbar.classList.contains("hidden"), "点击发送 tab：搜索栏+优先级筛选所在 .toolbar 被隐藏");
ok(doc.getElementById("list").classList.contains("hidden"), "点击发送 tab：#list 隐藏");
ok(!doc.getElementById("send-view").classList.contains("hidden"), "点击发送 tab：#send-view 显示");
ok(doc.getElementById("settings-view").classList.contains("hidden"), "点击发送 tab：#settings-view 仍隐藏");
// 首次进入发送视图是测试 1 的第一次 send 点击（deviceOptions 有缓存，之后不再调用）：
ok(calls.filter(([c]) => c === "list_devices").length === 1,
   "invoke('list_devices') 全会话仅调用 1 次（首次进入发送视图懒加载设备列表，之后走缓存）");

mark = calls.length;
tab("settings").click();
await settle();
ok(!doc.getElementById("settings-view").classList.contains("hidden"), "点击设置 tab：#settings-view 显示");
ok(doc.getElementById("send-view").classList.contains("hidden"), "点击设置 tab：#send-view 隐藏");
ok(calls.slice(mark).some(([c]) => c === "get_settings"), "进入设置视图触发 invoke('get_settings') 回填表单");
ok(calls.slice(mark).some(([c]) => c === "list_apps"), "进入设置视图触发 invoke('list_apps') 渲染按应用静音列表");
// 设置路径的搜索栏/列表隐藏：view-toggle 缺陷已修复（共享元素显隐收敛到 applySharedElems，
// 每个 tab 目标态只计算一次，showSend(false) 不再回切），KNOWN-BUG 守卫转正为无条件断言。
ok(toolbar.classList.contains("hidden"), "设置视图下搜索栏+优先级筛选(.toolbar)应隐藏");
ok(doc.getElementById("list").classList.contains("hidden"), "设置视图下 #list 应隐藏");

// ===== 3) 消息/归档切换调用 loadHistory 且 archived 参数正确 =====
console.log("== 3) archive-param：消息/归档切换调用 loadHistory 且 archived 参数正确 ==");
mark = calls.length;
tab("archive").click();
await settle();
const hCalls = calls.slice(mark).filter(([c]) => c === "history").map(([, a]) => a);
ok(hCalls.length >= 1, "点击归档 tab 触发 invoke('history')");
ok(hCalls.some((a) => a.archived === true), "归档 tab：history 参数 archived=true");
ok(hCalls.some((a) => a.limit === 200), "归档 tab：history 参数 limit=200");
ok(hCalls.some((a) => a.query === null), "归档 tab：history 参数 query=null（搜索框为空）");
ok(hCalls.some((a) => a.priority === null), "归档 tab：history 参数 priority=null（未筛选）");
console.log(`  [观察] 一次归档 tab 点击触发 ${hCalls.length} 次 history（setSelecting(false) 内部 + 表层各调一次 loadHistory，双份 IPC）`);

mark = calls.length;
tab("inbox").click();
await settle();
const hCalls2 = calls.slice(mark).filter(([c]) => c === "history").map(([, a]) => a);
ok(hCalls2.length >= 1 && hCalls2.every((a) => a.archived === false),
   "点击消息 tab：history 参数 archived=false");

// ===== 4) 切 tab 清空多选状态 =====
console.log("== 4) clear-selection：切 tab 清空多选状态 ==");
const selBtn = doc.getElementById("select-btn");
selBtn.click();                       // 进入多选
await settle();
ok(!doc.getElementById("batch-bar").classList.contains("hidden"), "进入多选模式：#batch-bar 显示");
const card = doc.querySelector("#list .m");   // 重渲染后重新取卡片
card.click();                         // 勾选 1 条
await settle();
ok(doc.getElementById("sel-count").textContent === "已选 1 条",
   `勾选 1 条后 #sel-count="${doc.getElementById("sel-count").textContent}"`);
ok(card.classList.contains("sel"), "被勾选卡片带 sel 样式");

tab("archive").click();               // 切 tab → 应清空多选
await settle();
ok(doc.getElementById("batch-bar").classList.contains("hidden"), "切到归档 tab：#batch-bar 隐藏");
ok(doc.getElementById("sel-count").textContent === "已选 0 条", "切到归档 tab：多选集合清空（已选 0 条）");
ok(selBtn.title === "多选/批量操作", "切到归档 tab：select-btn title 复位（setSelecting(false) 已执行）");
ok(!selBtn.classList.contains("active-ghost"), "切到归档 tab：select-btn 高亮态移除");
ok(![...doc.querySelectorAll("#list .m")].some((el) => el.classList.contains("sel")),
   "切到归档 tab：重渲染后无任何卡片带 sel 样式");

// ===== 5) count-label 显示当前范围条数 =====
console.log("== 5) count-label：显示当前范围条数 ==");
tab("inbox").click();
await settle();
ok(doc.getElementById("count-label").textContent === "显示 3 条",
   `消息范围 #count-label="${doc.getElementById("count-label").textContent}"（来自 archived=false 响应 3 条）`);
tab("archive").click();
await settle();
ok(doc.getElementById("count-label").textContent === "归档显示 2 条",
   `归档范围 #count-label="${doc.getElementById("count-label").textContent}"（来自 archived=true 响应 2 条）`);

// ===== 6) [清单外] 设置/发送 tab 下多选状态与批量栏残留 =====
console.log("== 6) tab-batchbar-persist：切到设置/发送 tab 时多选状态与批量栏（清单外核对） ==");
tab("inbox").click();
await settle();
doc.getElementById("select-btn").click();
await settle();
doc.querySelector("#list .m").click();
await settle();
ok(doc.getElementById("sel-count").textContent === "已选 1 条", "前置：多选 1 条");
tab("settings").click();
await settle();
// batchbar-persist 缺陷已修复：切 tab 的多选清空/退出逻辑移出 if(!isSettings && !isSend) 守卫，
// 设置/发送 tab 同样执行 setSelecting(false)，KNOWN-BUG 守卫转正为无条件断言。
ok(doc.getElementById("batch-bar").classList.contains("hidden"), "切到设置 tab 后批量操作栏应隐藏");
ok(doc.getElementById("sel-count").textContent === "已选 0 条", "切到设置 tab 后多选集合应清空");
// 同一不变量对发送 tab 同样成立（缺陷场景覆盖设置+发送两个 tab）
tab("inbox").click();
await settle();
doc.getElementById("select-btn").click();
await settle();
doc.querySelector("#list .m").click();
await settle();
ok(doc.getElementById("sel-count").textContent === "已选 1 条", "前置：多选 1 条（发送 tab 场景）");
tab("send").click();
await settle();
ok(doc.getElementById("batch-bar").classList.contains("hidden"), "切到发送 tab 后批量操作栏应隐藏");
ok(doc.getElementById("sel-count").textContent === "已选 0 条", "切到发送 tab 后多选集合应清空");

// ===== 7) [清单外] navigate-latest 事件驱动 tab 切回消息 + 定位滚动 =====
console.log("== 7) navigate-latest：事件驱动切回消息 tab（清单外核对） ==");
ok(typeof listeners["navigate-latest"] === "function", "app.js 已订阅 navigate-latest 事件");
tab("archive").click();
await settle();
ok(activeViews()[0] === "archive", "前置：当前在归档 tab");
// jsdom 未实现 scrollIntoView（v24.1.3 无此方法）：打桩计数，断言定位确实发生。
// （navigate-latest 定位缺陷已修复：列表卡片渲染 id="msg-<id>"，处理器能找到目标，
//   KNOWN-BUG 守卫转正为无条件断言——stub 必须在触发事件前就位。）
const scrollCalls = [];
window.HTMLElement.prototype.scrollIntoView = function (opts) { scrollCalls.push(opts); };
mark = calls.length;
await listeners["navigate-latest"]({ payload: Number(INBOX[0].id) });   // Rust 侧 payload 为 i64 消息 id
await settle();
ok(activeViews().length === 1 && activeViews()[0] === "inbox",
   "navigate-latest 事件触发后 inbox tab 变为 active");
ok(calls.slice(mark).some(([c]) => c === "history"), "navigate-latest 事件触发 loadHistory 重载列表");
ok(doc.getElementById("count-label").textContent === "显示 3 条", "navigate-latest 后 count-label 刷新为消息范围");

const scrollTarget = doc.getElementById(`msg-${INBOX[0].id}`);
ok(scrollTarget !== null,
   "navigate-latest 应能找到 #msg-<id> 滚动定位目标（列表卡片渲染 id=\"msg-<id>\"）");
ok(scrollCalls.length === 1 && scrollCalls[0]?.behavior === "smooth" && scrollCalls[0]?.block === "center",
   "navigate-latest 应对定位目标调用 scrollIntoView({behavior:'smooth', block:'center'})");

console.log(failed ? `\n${failed} 项断言失败` : "\n标签页与视图切换组审计测试 PASS");
process.exit(failed ? 1 : 0);
