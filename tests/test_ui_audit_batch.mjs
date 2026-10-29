#!/usr/bin/env node
// UI 审计·「批量操作」组点击链核对（7 项）：
//   1 多选模式切换  2 选择模式点卡片=勾选而非开详情  3 全选收集字符串 id
//   4 批量归档 archive_messages  5 批量删除两步确认(5s 回退)  6 取消退出多选  7 sel-count 计数
// 骨架照抄 tests/test_send_button.mjs：jsdom + __TAURI__ mock，dispatch 真实 click。
// 运行：cd 仓库根 && node tests/test_ui_audit_batch.mjs
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
const $ = (id) => doc.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 i64 上限级的超大 id：产品若把 id 过 Number() 会丢精度/变 number——必须原样字符串往返
const MSGS = [
  { id: "9223372036854775807", app: "ci", title: "构建失败", message: "job #1 failed",
    priority: 0, read: true, date: 1760000000, acked: true, archived: false,
    umid: "u1", receipt: null, html: false, url: null, icon: null },
  { id: "1234567890123456789", app: "monitor", title: "磁盘告警", message: "disk 91%",
    priority: 1, read: true, date: 1760000100, acked: true, archived: false,
    umid: "u2", receipt: null, html: false, url: null, icon: null },
];
const ARCHIVED = [
  { id: "888888888888888888", app: "old", title: "旧消息", message: "archived",
    priority: 0, read: true, date: 1750000000, acked: true, archived: true,
    umid: "u3", receipt: null, html: false, url: null, icon: null },
];
const ALL = [...MSGS, ...ARCHIVED];

const calls = [];
window.__TAURI__ = {
  core: { invoke: async (cmd, args = {}) => {
    calls.push([cmd, args]);
    if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
    if (cmd === "get_settings") return { send_token: "t", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
    if (cmd === "history") {
      if (args.priority === 2) return [];              // 紧急横幅查询：无未确认紧急消息
      return ALL.filter((m) => !!m.archived === !!args.archived);
    }
    if (cmd === "get_message") return ALL.find((m) => m.id === args.id) ?? null;
    if (cmd === "list_apps") return [];
    if (cmd === "list_devices") return ["mac-app"];
    return {};
  }},
  event: { listen: async () => {} },
};
const s = doc.createElement("script");
s.textContent = js;
doc.body.appendChild(s);
await sleep(300); // 等启动链 refreshStatus + loadHistory 完成

const card = (i) => doc.querySelectorAll("#list .m")[i];
const cardIds = () => [...doc.querySelectorAll("#list .m")].map((el) => el.dataset.id);
const sameIds = (got, want) =>
  Array.isArray(got) && got.every((x) => typeof x === "string") &&
  got.length === want.length && want.every((w) => got.includes(w));
let step = 0;
const ok = (cond, msg) => { if (!cond) { console.error(`FAIL [step ${step}]: ${msg}`); process.exit(1); } };
// 缺陷 sel-count 已修复：批量归档/删除清空 state.selected 后必须调 refreshBatchBar，
// #sel-count 不得滞留旧值。断言无条件执行，不再有 KNOWN-BUG 宽松分支。
const expectCountCleared = (where) => {
  ok($("sel-count").textContent === "已选 0 条",
    `${where}执行后 sel-count 应显示『已选 0 条』, 实际: ${$("sel-count").textContent}`);
};

// ---- 1. 多选模式切换（按钮态 + 卡片 selectable + .cb 勾选框出现） ----
step = 1;
ok($("batch-bar").classList.contains("hidden"), "初始 batch-bar 应隐藏");
$("select-btn").click(); await sleep(150);
ok(!$("batch-bar").classList.contains("hidden"), "点 select-btn 后 batch-bar 应显示");
ok($("select-btn").classList.contains("active-ghost"), "select-btn 应有 active-ghost 激活态");
ok($("select-btn").title === "退出多选模式", "select-btn title 应切为『退出多选模式』，实际: " + $("select-btn").title);
ok(cardIds().length === 2, "收件箱应渲染 2 张卡片, 实际: " + cardIds().length);
for (const el of doc.querySelectorAll("#list .m"))
  ok(el.classList.contains("selectable"), "多选模式下卡片应有 selectable 类");
ok(doc.querySelectorAll("#list .m .cb").length === 2, "多选模式下每张卡片应有 .cb 勾选框");
$("select-btn").click(); await sleep(150);
ok($("batch-bar").classList.contains("hidden"), "再点 select-btn 应退出多选（batch-bar 隐藏）");
for (const el of doc.querySelectorAll("#list .m"))
  ok(!el.classList.contains("selectable"), "退出后卡片不应再有 selectable 类");
ok($("select-btn").title === "多选/批量操作", "退出后 title 应回到『多选/批量操作』");

// ---- 2. 选择模式点卡片切换勾选而非开详情 ----
step = 2;
$("select-btn").click(); await sleep(150);   // 重新进入多选
calls.length = 0;
card(0).click(); await sleep(100);
ok(card(0).classList.contains("sel"), "选择模式点卡片应加 sel 勾选类");
ok($("sel-count").textContent === "已选 1 条", "点 1 张后计数应为 1, 实际: " + $("sel-count").textContent);
ok(!calls.some(([c]) => c === "get_message"), "选择模式点卡片不得调 get_message（应勾选而非开详情）");
ok($("detail-overlay").classList.contains("hidden"), "选择模式点卡片不应打开详情便签");
card(0).click(); await sleep(100);
ok(!card(0).classList.contains("sel"), "再点同一卡片应取消勾选");
ok($("sel-count").textContent === "已选 0 条", "取消后计数应回 0");
// 对照组：非选择模式点卡片 → 走 get_message 开详情（证明两分支确实不同）
$("select-btn").click(); await sleep(150);   // 退出多选
calls.length = 0;
card(0).click(); await sleep(200);
ok(calls.some(([c, a]) => c === "get_message" && a.id === "9223372036854775807"),
  "非选择模式点卡片应调 get_message 开详情");
ok(!$("detail-overlay").classList.contains("hidden"), "非选择模式点卡片应打开详情");
$("detail-close").click(); await sleep(50);
$("select-btn").click(); await sleep(150);   // 重新进入多选

// ---- 3. 全选收集全部 id（字符串） ----
step = 3;
$("sel-all").click(); await sleep(150);
ok($("sel-count").textContent === "已选 2 条", "全选后计数应为 2, 实际: " + $("sel-count").textContent);
for (const el of doc.querySelectorAll("#list .m"))
  ok(el.classList.contains("sel"), "全选后每张卡片应有 sel 类");

// ---- 4. 批量归档 invoke archive_messages ----
step = 4;
calls.length = 0;
$("sel-archive").click(); await sleep(250);
const arch = calls.find(([c]) => c === "archive_messages");
ok(arch, "点批量归档应触发 invoke('archive_messages'), 实际调用: " + JSON.stringify(calls));
ok(sameIds(arch?.[1]?.ids, ["9223372036854775807", "1234567890123456789"]),
  "ids 应为字符串且与卡片 data-id 完全一致（防 Number 丢精度）, 实际: " + JSON.stringify(arch?.[1]?.ids));
ok(arch?.[1]?.archived === true, "收件箱视图批量归档应 archived=true");
// 内部选择确已清空：loadHistory 重渲染后卡片不再带 sel 类
for (const el of doc.querySelectorAll("#list .m"))
  ok(!el.classList.contains("sel"), "归档执行后卡片不应再有 sel 类（选择集已清空）");
expectCountCleared("批量归档");
// 空选择点归档：不得触发 invoke（app.js:397 前置卫语句）
calls.length = 0;
$("sel-archive").click(); await sleep(100);
ok(!calls.some(([c]) => c === "archive_messages"), "未选中任何条目时点归档不应触发 invoke");
// 归档视图方向：按钮文案『恢复』+ archived=false
doc.querySelector('.tab[data-view="archive"]').click(); await sleep(200);
ok(cardIds().length === 1, "归档视图应渲染 1 条, 实际: " + cardIds().length);
$("select-btn").click(); await sleep(150);
card(0).click(); await sleep(100);
ok($("sel-archive").textContent === "恢复", "归档视图批量按钮文案应为『恢复』, 实际: " + $("sel-archive").textContent);
calls.length = 0;
$("sel-archive").click(); await sleep(250);
const restore = calls.find(([c]) => c === "archive_messages");
ok(restore && restore[1].archived === false && sameIds(restore[1].ids, ["888888888888888888"]),
  "归档视图点恢复应 archive_messages(archived=false) 且 id 正确, 实际: " + JSON.stringify(restore?.[1]));
doc.querySelector('.tab[data-view="inbox"]').click(); await sleep(200); // 回收件箱（同时退出多选）

// ---- 5. 批量删除两步确认（5 秒回退） ----
step = 5;
$("select-btn").click(); await sleep(150);
card(0).click(); await sleep(100);
calls.length = 0;
$("sel-delete").click(); await sleep(100);
ok($("sel-delete").textContent === "确认删除 1 条？", "首点应进入确认态, 实际: " + $("sel-delete").textContent);
ok(!calls.some(([c]) => c === "delete_messages"), "首点不得调用 delete_messages");
await sleep(5300);                            // 越过 5000ms 回退定时器
ok($("sel-delete").textContent === "删除", "5 秒未确认应回退为『删除』, 实际: " + $("sel-delete").textContent);
$("sel-delete").click(); await sleep(100);    // 回退后需重新武装
ok($("sel-delete").textContent === "确认删除 1 条？", "回退后首点应重新进入确认态");
ok(!calls.some(([c]) => c === "delete_messages"), "回退后首点仍不得调用 delete_messages");
$("sel-delete").click(); await sleep(250);    // 5 秒内二点 = 确认
const del = calls.find(([c]) => c === "delete_messages");
ok(del, "确认态下二点应触发 invoke('delete_messages'), 实际调用: " + JSON.stringify(calls));
ok(sameIds(del?.[1]?.ids, ["9223372036854775807"]),
  "删除 ids 应为所选字符串 id, 实际: " + JSON.stringify(del?.[1]?.ids));
ok($("sel-delete").textContent === "删除", "执行删除后按钮文案应回『删除』");
expectCountCleared("批量删除");

// ---- 6. 取消退出多选 ----
step = 6;
card(0).click(); await sleep(100);            // 重新选一条
ok($("sel-count").textContent === "已选 1 条", "先选中一条, 实际: " + $("sel-count").textContent);
$("sel-cancel").click(); await sleep(150);
ok($("batch-bar").classList.contains("hidden"), "点取消应隐藏 batch-bar");
for (const el of doc.querySelectorAll("#list .m"))
  ok(!el.classList.contains("selectable"), "取消后卡片不应再有 selectable 类");
ok($("sel-count").textContent === "已选 0 条", "取消后计数应归零（选择集已清）");

// ---- 7. sel-count 实时显示已选数 ----
step = 7;
$("select-btn").click(); await sleep(150);
card(0).click(); await sleep(100);
ok($("sel-count").textContent === "已选 1 条", "选 1 条应显示『已选 1 条』, 实际: " + $("sel-count").textContent);
card(1).click(); await sleep(100);
ok($("sel-count").textContent === "已选 2 条", "选 2 条应显示『已选 2 条』, 实际: " + $("sel-count").textContent);
card(1).click(); await sleep(100);
ok($("sel-count").textContent === "已选 1 条", "取消 1 条应显示『已选 1 条』, 实际: " + $("sel-count").textContent);

console.log("批量操作组 7 项控件点击链全部 PASS");
