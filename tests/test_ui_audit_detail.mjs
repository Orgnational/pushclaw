#!/usr/bin/env node
// 详情便签组 UI 审计（2026-10-30）：逐控件点击链核对。
// 覆盖：打开未读详情触发 mark_read / detail-url→open_url / priority=2 未确认显示确认按钮并 ack
//      / detail-archive→archive_messages 参数 / detail-delete 两步确认 / ESC·背景·✕ 关闭。
// 骨架照抄 tests/test_send_button.mjs：jsdom 载入真实 index.html + app.js，注入 __TAURI__ mock。
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock 消息库（archive/ack/delete 会真实改写，模拟后端副作用） ----
const MSGS = [
  { id: "101", priority: 2, receipt: "R-101", acked: false, read: false, umid: "umid-101",
    url: "https://example.com/101", archived: false, title: "紧急标题", app: "NetMon",
    message: "紧急正文", date: 1760000000 },
  { id: "102", priority: 0, receipt: "", acked: false, read: false, umid: "umid-102",
    url: "https://example.com/102", archived: false, title: "普通标题", app: "AppB",
    message: "普通正文", date: 1760000100 },
  { id: "103", priority: 0, receipt: "", acked: false, read: true, umid: "umid-103",
    url: "", archived: true, title: "已归档消息", app: "AppC", message: "已归档正文", date: 1760000200 },
  { id: "104", priority: 2, receipt: "R-104", acked: true, read: true, umid: "umid-104",
    url: "", archived: false, title: "已确认紧急", app: "NetMon", message: "旧紧急正文", date: 1760000300 },
  { id: "105", priority: 0, receipt: "", acked: false, read: true, umid: "",
    url: "", archived: false, title: "已读消息", app: "AppE", message: "已读正文", date: 1760000400 },
];

const calls = [];   // [cmd, args 快照]
window.__TAURI__ = {
  core: { invoke: async (cmd, args = {}) => {
    calls.push([cmd, JSON.parse(JSON.stringify(args))]);
    if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
    if (cmd === "history") {
      let list = MSGS.filter((m) => !!m.archived === !!args.archived);
      if (args.priority === 2) list = list.filter((m) => m.priority === 2);
      return list;
    }
    if (cmd === "get_message") return MSGS.find((m) => String(m.id) === String(args.id)) ?? null;
    if (cmd === "mark_read") return null;
    if (cmd === "open_url") return null;
    if (cmd === "ack") {
      const m = MSGS.find((x) => x.receipt === args.receipt);
      if (m) m.acked = true;
      return null;
    }
    if (cmd === "archive_messages") {
      for (const id of args.ids) {
        const m = MSGS.find((x) => String(x.id) === String(id));
        if (m) m.archived = !!args.archived;
      }
      return args.ids.length;
    }
    if (cmd === "delete_messages") {
      for (const id of args.ids) {
        const i = MSGS.findIndex((x) => String(x.id) === String(id));
        if (i >= 0) MSGS.splice(i, 1);
      }
      return args.ids.length;
    }
    if (cmd === "list_apps") return [];
    return {};
  }},
  event: { listen: async () => {} },
};

const s = doc.createElement("script");
s.textContent = js;
doc.body.appendChild(s);
await wait(300);   // 等启动 IIFE：refreshStatus + loadHistory + refreshEmergencyBar

const $ = (id) => doc.getElementById(id);
const callsFor = (cmd) => calls.filter(([c]) => c === cmd).map(([, a]) => a);
const clearCalls = () => { calls.length = 0; };
const overlay = () => $("detail-overlay");
const overlayOpen = () => !overlay().classList.contains("hidden");
const openCard = async (id) => {
  const card = doc.querySelector(`#list .m[data-id="${id}"]`);
  if (!card) throw new Error(`列表中找不到卡片 ${id}（当前视图消息: ${MSGS.map((m) => m.id).join(",")}）`);
  card.click();
  await wait(150);
};
const escKey = async () => {
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(50);
};

let failed = false;
function ok(cond, msg) {
  if (cond) { console.log("  ✓", msg); return; }
  failed = true;
  console.error("  ✗ FAIL:", msg);
}

// ============ 1) 打开未读消息详情触发 mark_read ============
console.log("1) detail-mark-read：点击未读卡片 → get_message → mark_read{umid}");
clearCalls();
await openCard("101");
const gm1 = callsFor("get_message");
ok(gm1.some((a) => a && a.id === "101"), "点击列表卡片触发 invoke('get_message',{id:'101'})");
ok(overlayOpen(), "详情便签可见（detail-overlay 无 hidden）");
ok($("detail-title").textContent === "紧急标题", "详情标题渲染为消息标题");
const mr = callsFor("mark_read");
ok(mr.length === 1 && mr[0] && mr[0].umid === "umid-101",
   `未读消息(m.read=false,umid=umid-101)打开详情即 invoke('mark_read',{umid:'umid-101'})，实际: ${JSON.stringify(mr)}`);

// 反例：打开已读消息不应再次 mark_read
clearCalls();
await escKey();
await openCard("105");
ok(overlayOpen(), "已读消息 105 详情可见");
ok(callsFor("mark_read").length === 0, "已读消息打开详情不再触发 mark_read");
await escKey();

// ============ 2) detail-url 点击 → open_url ============
console.log("2) detail-url：详情内点链接 → invoke('open_url',{url})");
await openCard("102");
const urlEl = $("detail-url");
ok(!urlEl.classList.contains("hidden"), "带 url 的消息详情显示『打开链接』");
ok(urlEl.href === "https://example.com/102", `链接 href 来自消息 url，实际: ${urlEl.href}`);
clearCalls();
urlEl.click();
await wait(150);
const ou = callsFor("open_url");
ok(ou.length === 1 && ou[0] && ou[0].url === "https://example.com/102",
   `点击 detail-url 触发 invoke('open_url',{url:'https://example.com/102'})，实际: ${JSON.stringify(ou)}`);
ok(overlayOpen(), "open_url 点击不关闭详情（preventDefault，未冒泡成背景关闭）");

// 反例：无 url 消息不显示链接（用归档消息 103，见第 4 步打开时断言）

// ============ 3) priority=2 且未确认 → 显示确认按钮 → 点击 invoke ack ============
console.log("3) detail-ack：紧急未确认显示『确认』按钮，点击 → invoke('ack',{receipt})");
clearCalls();
await escKey();
await openCard("101");
const ackEl = $("detail-ack");
ok(!ackEl.classList.contains("hidden"), "priority=2 且未确认（receipt=R-101, acked=false）时确认按钮可见");
ok(ackEl.textContent === "确认" && !ackEl.disabled, "按钮文案『确认』且可用");
clearCalls();
ackEl.click();
await wait(200);
const acks = callsFor("ack");
ok(acks.length === 1 && acks[0] && acks[0].receipt === "R-101",
   `点击确认触发 invoke('ack',{receipt:'R-101'})，实际: ${JSON.stringify(acks)}`);
ok(ackEl.textContent === "✓ 已确认", `确认后按钮变『✓ 已确认』，实际: "${ackEl.textContent}"`);

// 反例：已确认的紧急消息、非紧急消息都不显示确认按钮
await escKey();
await openCard("104");
ok($("detail-ack").classList.contains("hidden"), "acked=true 的紧急消息不显示确认按钮");
await escKey();
await openCard("102");
ok($("detail-ack").classList.contains("hidden"), "priority=0 的消息不显示确认按钮");

// ============ 4) detail-archive → archive_messages 参数正确 ============
console.log("4) detail-archive：未归档→{archived:true}，归档视图→{archived:false}（恢复）");
await escKey();
clearCalls();
await openCard("101");
const archEl = $("detail-archive");
ok(archEl.textContent === "归档", `未归档消息按钮文案『归档』，实际: "${archEl.textContent}"`);
archEl.click();
await wait(200);
const ar1 = callsFor("archive_messages");
ok(ar1.length === 1 && ar1[0] && Array.isArray(ar1[0].ids) && ar1[0].ids.length === 1 &&
   ar1[0].ids[0] === "101" && ar1[0].archived === true,
   `归档触发 invoke('archive_messages',{ids:['101'],archived:true})，实际: ${JSON.stringify(ar1)}`);
ok(!overlayOpen(), "归档后详情关闭");

// 恢复：切到归档视图打开 103
doc.querySelector('.tab[data-view="archive"]').click();
await wait(200);
clearCalls();
await openCard("103");
ok($("detail-archive").textContent === "恢复到消息",
   `归档消息按钮文案『恢复到消息』，实际: "${$("detail-archive").textContent}"`);
ok($("detail-url").classList.contains("hidden"), "（2 反例）无 url 消息的『打开链接』保持隐藏");
$("detail-archive").click();
await wait(200);
const ar2 = callsFor("archive_messages");
ok(ar2.length === 1 && ar2[0] && ar2[0].ids.length === 1 && ar2[0].ids[0] === "103" &&
   ar2[0].archived === false,
   `恢复触发 invoke('archive_messages',{ids:['103'],archived:false})，实际: ${JSON.stringify(ar2)}`);
ok(!overlayOpen(), "恢复后详情关闭");
doc.querySelector('.tab[data-view="inbox"]').click();
await wait(200);

// ============ 5) detail-delete 两步确认 ============
console.log("5) detail-delete：首次点击只变确认文案，二次点击才 invoke delete_messages");
clearCalls();
await openCard("102");
const delEl = $("detail-delete");
delEl.click();
await wait(100);
ok(delEl.textContent === "确认删除？", `首次点击文案变『确认删除？』，实际: "${delEl.textContent}"`);
ok(callsFor("delete_messages").length === 0, "首次点击未触发 delete_messages（两步确认第一步）");
delEl.click();
await wait(200);
const dm = callsFor("delete_messages");
ok(dm.length === 1 && dm[0] && Array.isArray(dm[0].ids) && dm[0].ids.length === 1 &&
   dm[0].ids[0] === "102",
   `二次点击触发 invoke('delete_messages',{ids:['102']})，实际: ${JSON.stringify(dm)}`);
ok(!overlayOpen(), "删除后详情关闭");
ok(delEl.textContent === "删除", "执行后按钮文案复位『删除』");

// ============ 6) ESC / 背景点击 / ✕ 关闭（含清单外同区域 detail-close） ============
console.log("6) detail-close：ESC、背景点击、✕ 三条关闭路径");
await openCard("105");
ok(overlayOpen(), "打开详情用于关闭测试");
await escKey();
ok(!overlayOpen(), "按 ESC 关闭详情");
await openCard("105");
overlay().click();   // target=overlay 自身（背景）
await wait(50);
ok(!overlayOpen(), "点击背景（overlay 自身为 target）关闭详情");
await openCard("105");
$("detail-body").click();
await wait(50);
ok(overlayOpen(), "点击便签内部（detail-body）不误关详情");
$("detail-close").click();
await wait(50);
ok(!overlayOpen(), "点击 ✕（detail-close）关闭详情");

console.log(failed
  ? "详情便签审计存在 FAIL 项（见上）"
  : "详情便签审计 PASS：mark_read✓ open_url✓ ack✓ archive/restore✓ 两步删除✓ ESC/背景/✕ 关闭✓");
process.exit(failed ? 1 : 0);
