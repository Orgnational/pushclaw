#!/usr/bin/env node
/**
 * 前端逻辑回归测试（jsdom）：在真实 DOM + 模拟 Tauri IPC 下复现 UI 操作流，
 * 断言 invoke 收到的参数正确。核心回归点：**消息 id 为 19 位大整数时必须以
 * 字符串全程传递**（JS Number 会静默丢精度导致按 id 的操作全部失配）。
 *
 * 运行：node tests/test_ui_logic.mjs（在 app/ 目录下）
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "ui");
const html = readFileSync(join(uiDir, "index.html"), "utf-8");
const js = readFileSync(join(uiDir, "app.js"), "utf-8");

// 模拟 Pushover 真实量级的消息 id（19 位，超过 Number.MAX_SAFE_INTEGER）
const BIG1 = "1183335762543728906";
const BIG2 = "1183335762543728907";
const BIG3 = "1183335762543728908";

const msgs = [
  { id: BIG3, umid: "u3", title: "第三条", message: "m3", html: false, priority: 1,
    url: "", url_title: "", app: "TestApp", date: 3000, acked: false, receipt: "", archived: false, read: false },
  { id: BIG2, umid: "u2", title: "第二条", message: "m2", html: false, priority: 0,
    url: "", url_title: "", app: "TestApp", date: 2000, acked: false, receipt: "", archived: false, read: true },
  { id: BIG1, umid: "u1", title: "第一条", message: "m1", html: false, priority: 2,
    url: "", url_title: "", app: "TestApp", date: 1000, acked: false,
    receipt: "rc-1", archived: false, read: false },
];

const invokes = [];
const listeners = {};
const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true,
  runScripts: "dangerously" });
const { window } = dom;

window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      invokes.push([cmd, args]);
      switch (cmd) {
        case "get_status": return { configured: true, email: "t@t", device_name: "test", connected: true, db_path: "/x", device_registered: true };
        case "history": {
          const q = args?.query ?? null;
          const archived = args?.archived ?? false;
          return msgs.filter((m) => m.archived === archived)
            .filter((m) => !q || (m.title + m.message + m.app).includes(q));
        }
        case "get_message": return msgs.find((m) => m.id === args.id) ?? null;
        case "delete_messages": {
          const n = msgs.filter((m) => args.ids.includes(m.id)).length;
          for (const m of msgs) if (args.ids.includes(m.id)) m.archived = "DELETED";
          return n;
        }
        case "archive_messages": {
          let n = 0;
          for (const m of msgs) if (args.ids.includes(m.id)) { m.archived = args.archived; n++; }
          return n;
        }
        case "ack": return;
        case "sync_now": return 0;
        case "get_settings": return {
          send_token: "", send_user: "", toast: true,
          quiet_enabled: false, quiet_start: "23:00", quiet_end: "08:00",
          muted_apps: [], version: "test", device_name: "test",
        };
        case "save_settings": return;
        case "list_apps": return ["TestApp"];
        case "get_icon": return "data:image/png;base64,x";
        case "list_devices": return ["dev-1"];
        case "mark_read": return;
        case "mark_all_read": return;
        case "send_message": return "req-mock";
        case "logout": return;
        case "open_url": return;
        default: return null;
      }
    },
  },
  event: { listen: async (name, fn) => { listeners[name] = fn; return () => {}; } },
};

// 去掉 <script src> 引用；先注入 __TAURI__ mock，再以 script 形式运行 app.js
window.document.querySelectorAll("script").forEach((el) => el.remove());
const mock = window.document.createElement("script");
mock.textContent = "window.__TAURI__ = window.__TAURI__;";  // 占位，真实 mock 已在 window 上
window.document.body.appendChild(mock);
const runner = window.document.createElement("script");
runner.textContent = js;
window.document.body.appendChild(runner);

const $ = (id) => window.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function expect(cond, name, detail = "") {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${cond ? "" : " — " + detail}`);
  if (!cond) failed++;
}

await sleep(50); // 等启动 IIFE 完成首次加载

// ---- 1. 启动即加载消息列表 ----
expect($("list").innerHTML.includes("第一条"), "启动渲染消息列表");
expect($("list").innerHTML.includes(`data-id="${BIG1}"`), "卡片 data-id 为完整字符串（无精度丢失）",
  $("list").innerHTML.slice(0, 200));

// ---- 2. 点击卡片 → get_message 收到字符串 id ----
window.document.querySelector(`#list .m[data-id="${BIG3}"]`).click();
await sleep(20);
const gm = invokes.find(([c]) => c === "get_message");
expect(gm && gm[1].id === BIG3, "点击卡片 get_message 收到字符串大 id",
  JSON.stringify(gm?.[1]));
expect(!$("detail-overlay").classList.contains("hidden"), "便签详情已打开");
expect($("detail-title").textContent === "第三条", "详情标题正确");
$("detail-close").click();
await sleep(10);

// ---- 3. 选择模式 → 全选 → 删除（两步确认）----
invokes.length = 0;
$("select-btn").click(); await sleep(20);
$("sel-all").click(); await sleep(20);
expect($("sel-count").textContent.includes("3"), "全选后计数为 3", $("sel-count").textContent);
$("sel-delete").click(); await sleep(10);   // 第一步：武装确认
expect($("sel-delete").textContent.includes("确认删除"), "删除按钮进入确认态");
$("sel-delete").click(); await sleep(20);   // 第二步：执行
const del = invokes.find(([c]) => c === "delete_messages");
expect(!!del, "delete_messages 已调用");
expect(del && del[1].ids.length === 3 && del[1].ids.includes(BIG1) && del[1].ids.includes(BIG3),
  "删除 id 全程字符串且精确匹配", JSON.stringify(del?.[1]));
const rounded = del && del[1].ids.some((x) => x === String(Number(BIG1)));
expect(!rounded, "无精度舍入的 id 混入");

// ---- 4. 批量归档/恢复 + 详情归档 ----
invokes.length = 0;
// 恢复被删标记的模拟数据，重新加载列表后再全选归档
msgs.forEach((m) => { if (m.archived === "DELETED") m.archived = false; });
window.document.querySelector('.tab[data-view="inbox"]').click();
await sleep(20);
$("sel-all").click(); await sleep(20);
$("sel-archive").click(); await sleep(20);
const arch = invokes.find(([c]) => c === "archive_messages");
expect(arch && arch[1].archived === true && arch[1].ids.length === 3,
  "批量归档参数正确", JSON.stringify(arch?.[1]));

// ---- 5. 切归档标签页 → 列表过滤 ----
invokes.length = 0;
window.document.querySelector('.tab[data-view="archive"]').click();
await sleep(20);
const h2 = invokes.filter(([c]) => c === "history").find(([, a]) => a.archived === true);
expect(!!h2, "归档标签页请求 archived=true");

// ---- 6. 优先级筛选 ----
invokes.length = 0;
window.document.querySelector('.tab[data-view="inbox"]').click();
await sleep(20);
window.document.querySelector('.chip[data-p="2"]').click();
await sleep(20);
const h3 = invokes.filter(([c]) => c === "history").find(([, a]) => a.priority === 2);
expect(!!h3, "紧急筛选请求 priority=2");

console.log(failed ? `\n${failed} 项失败` : "\nUI 逻辑全部通过");
process.exit(failed ? 1 : 0);
