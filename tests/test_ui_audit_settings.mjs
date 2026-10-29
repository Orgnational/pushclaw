#!/usr/bin/env node
// UI 审计：设置视图组（2026-10-30 审计）
// 覆盖：1) settings-load：进入设置页 get_settings 填充全部字段（token/user/设备名/邮箱/版本/开关/时段）
//       2) settings-save：保存按钮携带表单值 invoke save_settings 并显示 ✓（含 2s 后复位）
//       3) send-test：测试发送 invoke send_test 成功（✓ 已发送）/失败（发送失败 + ⚠ 提示）反馈
//       4) quiet-opacity：免打扰开关切换 quiet-row 透明度（1 ↔ 0.4）
//       5) muted-instant-save：静音清单勾选即时 save_settings（muted_apps）
//       6) muted-empty：无应用记录时显示提示
// 清单外核对：quiet-row 透明度随 quiet_enabled 载入同步（缺陷 quiet-opacity 已修复，KNOWN-BUG 守卫已转正为无条件断言）；
//             空值字段回落默认（设备名/邮箱 "-"、时段 23:00/08:00）。
// 规矩：加载真实 index.html + app.js，注入 __TAURI__ mock（invoke 记录调用），dispatch 真实 click，
//       断言到 invoke 参数与 DOM 状态。AUDIT_STRICT=1 时把已知产品缺陷当失败跑。
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf8");
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// get_settings 的主场景返回值（各字段取互异值，逐一核对回填）
const SETTINGS = {
  send_token: "tok123456789012345678901234567890",
  send_user: "userkey-abc123",
  toast: true,
  quiet_enabled: true,
  quiet_start: "01:30",
  quiet_end: "06:45",
  muted_apps: ["Mail"],
  version: "9.9.9",
  device_name: "macbook-pro",
  email: "audit@example.com",
};

// 启动一个全新 DOM：可配置 list_apps / get_settings 返回值 / send_test 是否失败
function bootDom({ listApps, settings, sendTestFails }) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
  const window = dom.window;
  const doc = window.document;
  const calls = [];   // [cmd, args] 全量记录
  const knobs = sendTestFails;   // 可变开关对象 { on: bool }
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
      if (cmd === "get_settings") return { ...settings };
      if (cmd === "list_apps") return [...listApps];
      if (cmd === "send_test") {
        if (knobs.on) throw new Error("mock: send_test 故意失败");
        return "ok";
      }
      if (cmd === "save_settings") return {};
      if (cmd === "history") return [];          // 消息/紧急横幅查询都造空，保持设置视图不 受干扰
      return {};
    }},
    event: { listen: async () => {} },
  };
  const s = doc.createElement("script");
  s.textContent = js;
  doc.body.appendChild(s);
  return { window, doc, calls, knobs };
}

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log("  PASS:", label);
  else { failed++; console.error("  FAIL:", label); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lastCall = (calls, cmd) => [...calls].reverse().find(([c]) => c === cmd);
const callsSince = (calls, mark, cmd) => calls.slice(mark).filter(([c]) => c === cmd);

// ================= 实例一：主场景（有应用记录、免打扰开启） =================
const { doc, calls, knobs } = bootDom({ listApps: ["Mail", "Slack"], settings: SETTINGS, sendTestFails: { on: false } });
await settle();

// ===== 1) settings-load：进入设置页 get_settings 填充全部字段 =====
console.log("== 1) settings-load：进入设置页 get_settings 填充全部字段 ==");
ok(doc.getElementById("settings-view").classList.contains("hidden"), "前置：初始 settings-view 隐藏");
let mark = calls.length;
doc.querySelector('.tab[data-view="settings"]').click();
await settle();
ok(!doc.getElementById("settings-view").classList.contains("hidden"), "点击设置 tab：settings-view 显示");
ok(callsSince(calls, mark, "get_settings").length === 1, "进入设置视图触发 invoke('get_settings')");
ok(callsSince(calls, mark, "list_apps").length === 1, "进入设置视图触发 invoke('list_apps') 渲染静音清单");
ok(doc.getElementById("set-device").textContent === SETTINGS.device_name,
   `设备名回填 #set-device="${doc.getElementById("set-device").textContent}"`);
ok(doc.getElementById("set-email").textContent === SETTINGS.email,
   `邮箱回填 #set-email="${doc.getElementById("set-email").textContent}"`);
ok(doc.getElementById("set-version").textContent === "v" + SETTINGS.version,
   `版本回填 #set-version="${doc.getElementById("set-version").textContent}"`);
ok(doc.getElementById("set-toast").checked === SETTINGS.toast, "Toast 开关 checked 与 get_settings.toast 一致");
ok(doc.getElementById("set-quiet").checked === SETTINGS.quiet_enabled, "免打扰开关 checked 与 get_settings.quiet_enabled 一致");
ok(doc.getElementById("quiet-row").style.opacity === "1",
   `清单外：quiet_enabled=${SETTINGS.quiet_enabled} 载入后 quiet-row 全亮 opacity="1"（载入同步正向用例）`);
ok(doc.getElementById("set-quiet-start").value === SETTINGS.quiet_start,
   `免打扰开始时段 #set-quiet-start="${doc.getElementById("set-quiet-start").value}"`);
ok(doc.getElementById("set-quiet-end").value === SETTINGS.quiet_end,
   `免打扰结束时段 #set-quiet-end="${doc.getElementById("set-quiet-end").value}"`);
ok(doc.getElementById("set-token").value === SETTINGS.send_token, "API Token 回填 set-token");
ok(doc.getElementById("set-user").value === SETTINGS.send_user, "User Key 回填 set-user");

// ===== 2) muted-instant-save：静音清单勾选即时 save_settings（muted_apps） =====
console.log("== 2) muted-instant-save：静音清单勾选即时 save_settings ==");
const cbs = [...doc.querySelectorAll("#muted-list input[data-app]")];
ok(cbs.length === 2 && cbs.map((c) => c.dataset.app).join(",") === "Mail,Slack",
   "静音清单按 list_apps 渲染 2 个勾选框（Mail / Slack）");
ok(cbs.find((c) => c.dataset.app === "Mail").checked, "前置：Mail 在 get_settings.muted_apps 中 → 初始勾选");
ok(!cbs.find((c) => c.dataset.app === "Slack").checked, "前置：Slack 不在 muted_apps 中 → 初始未勾选");

mark = calls.length;
doc.querySelector('#muted-list input[data-app="Slack"]').click();   // 勾选 Slack
await settle();
let saveCalls = callsSince(calls, mark, "save_settings");
ok(saveCalls.length === 1, "勾选 Slack 立即触发一次 invoke('save_settings')（无需点保存）");
if (saveCalls.length) {
  const s = saveCalls[0][1].settings;
  ok(eq(s.muted_apps, ["Mail", "Slack"]), `载荷 muted_apps=${JSON.stringify(s.muted_apps)}（即时收集全部勾选框）`);
  ok(s.send_token === SETTINGS.send_token && s.toast === SETTINGS.toast,
     "载荷其余字段从 get_settings 结果展开透传（send_token/toast 不丢）");
  ok(saveCalls[0][1].settings.quiet_enabled === SETTINGS.quiet_enabled, "载荷 quiet_enabled 同样透传");
}
doc.querySelector('#muted-list input[data-app="Mail"]').click();   // 取消 Mail
await settle();
saveCalls = callsSince(calls, mark, "save_settings");
ok(saveCalls.length === 2 && eq(saveCalls[1][1].settings.muted_apps, ["Slack"]),
   `再次取消 Mail → 第 2 次即时保存 muted_apps=${JSON.stringify(saveCalls[1]?.[1]?.settings?.muted_apps)}`);
doc.querySelector('#muted-list input[data-app="Mail"]').click();   // 重新勾选 Mail（为保存测试恢复状态）
await settle();
saveCalls = callsSince(calls, mark, "save_settings");
ok(saveCalls.length === 3 && eq(saveCalls[2][1].settings.muted_apps, ["Mail", "Slack"]),
   `重新勾选 Mail → 第 3 次即时保存 muted_apps=${JSON.stringify(saveCalls[2]?.[1]?.settings?.muted_apps)}`);

// ===== 3) quiet-opacity：免打扰开关切换 quiet-row 透明度 =====
console.log("== 3) quiet-opacity：免打扰开关切换 quiet-row 透明度 ==");
const quiet = doc.getElementById("set-quiet");
const quietRow = doc.getElementById("quiet-row");
ok(quiet.checked === true, "前置：免打扰开关当前勾选");
quiet.click();   // 勾选 → 取消（jsdom checkbox click 会触发 change）
await settle();
ok(quiet.checked === false && quietRow.style.opacity === "0.4",
   `取消勾选后 #quiet-row opacity="${quietRow.style.opacity}"（变暗）`);
quiet.click();   // 取消 → 勾选
await settle();
ok(quiet.checked === true && quietRow.style.opacity === "1",
   `重新勾选后 #quiet-row opacity="${quietRow.style.opacity}"（恢复全亮）`);

// ===== 4) settings-save：保存按钮携带表单值 invoke save_settings 并显示 ✓ =====
console.log("== 4) settings-save：保存按钮携带表单值 invoke save_settings 并显示 ✓ ==");
const saveBtn = doc.getElementById("set-save");
doc.getElementById("set-token").value = "  tok-NEW-999  ";   // 带空格，验证 trim
doc.getElementById("set-user").value = "user-NEW";
doc.getElementById("set-toast").click();          // toast true → false
doc.getElementById("set-quiet").click();          // quiet true → false
doc.getElementById("set-quiet-start").value = "02:10";
doc.getElementById("set-quiet-end").value = "";   // 空值，验证回落默认 08:00
mark = calls.length;
saveBtn.click();
await settle();
const saveOne = callsSince(calls, mark, "save_settings");
ok(saveOne.length === 1, "点击保存触发 invoke('save_settings')");
if (saveOne.length) {
  const s = saveOne[0][1].settings;
  ok(s.send_token === "tok-NEW-999", `载荷 send_token="${s.send_token}"（输入已 trim）`);
  ok(s.send_user === "user-NEW", `载荷 send_user="${s.send_user}"`);
  ok(s.toast === false, `载荷 toast=${s.toast}（开关勾选状态）`);
  ok(s.quiet_enabled === false, `载荷 quiet_enabled=${s.quiet_enabled}（开关勾选状态）`);
  ok(s.quiet_start === "02:10", `载荷 quiet_start="${s.quiet_start}"（输入值）`);
  ok(s.quiet_end === "08:00", `载荷 quiet_end="${s.quiet_end}"（空输入回落默认 08:00）`);
  ok(eq(s.muted_apps, ["Mail", "Slack"]), `载荷 muted_apps=${JSON.stringify(s.muted_apps)}（收集静音清单勾选框）`);
}
ok(saveBtn.textContent === "✓ 已保存", `保存后按钮文案="${saveBtn.textContent}"（显示 ✓）`);
await new Promise((r) => setTimeout(r, 2100));   // 等过 2s 复位定时器
ok(saveBtn.textContent === "保存" && saveBtn.disabled === false,
   `2s 后按钮复位文案="${saveBtn.textContent}"、disabled=${saveBtn.disabled}（可再次点击）`);

// ===== 5) send-test：测试发送 invoke send_test 成功/失败反馈 =====
console.log("== 5) send-test：测试发送成功/失败反馈 ==");
const testBtn = doc.getElementById("set-sendtest");
mark = calls.length;
testBtn.click();
await settle();
let stCalls = callsSince(calls, mark, "send_test");
ok(stCalls.length === 1 && stCalls[0][1] === undefined, "点击发送测试消息触发 invoke('send_test')（无参数）");
ok(testBtn.textContent === "✓ 已发送", `成功反馈按钮文案="${testBtn.textContent}"`);
await new Promise((r) => setTimeout(r, 3100));   // 等过 3s 复位定时器（按钮恢复可用）
ok(testBtn.textContent === "发送测试消息" && testBtn.disabled === false,
   `3s 后复位文案="${testBtn.textContent}"、disabled=${testBtn.disabled}`);
knobs.on = true;   // 下一次 send_test mock 抛错
mark = calls.length;
testBtn.click();
await settle();
stCalls = callsSince(calls, mark, "send_test");
ok(stCalls.length === 1, "失败场景：invoke('send_test') 被再次触发");
ok(testBtn.textContent === "发送失败", `失败反馈按钮文案="${testBtn.textContent}"`);
ok(doc.getElementById("view-hint").textContent.includes("⚠") &&
   doc.getElementById("view-hint").textContent.includes("send_test 故意失败"),
   `失败时 view-hint 显示 ⚠ 错误信息："${doc.getElementById("view-hint").textContent.slice(0, 60)}…"`);

// ================= 实例二：空应用记录 + 免打扰关闭（全新加载态） =================
// 独立 DOM：排除实例一手动切换残留的内联样式，验证"刚进入设置页"的原始状态。
console.log("== 6) muted-empty：无应用记录时显示提示（独立全新 DOM） ==");
const EMPTY_SETTINGS = {
  send_token: "", send_user: "", toast: false, quiet_enabled: false,
  quiet_start: "", quiet_end: "", muted_apps: [],
  version: "0.0.0", device_name: "", email: "",
};
const dom2 = bootDom({ listApps: [], settings: EMPTY_SETTINGS, sendTestFails: { on: false } });
const doc2 = dom2.doc, calls2 = dom2.calls;
await settle();
mark = calls2.length;
doc2.querySelector('.tab[data-view="settings"]').click();
await settle();
ok(callsSince(calls2, mark, "get_settings").length === 1 && callsSince(calls2, mark, "list_apps").length === 1,
   "空库场景：进入设置页仍触发 get_settings + list_apps");
const mutedBox2 = doc2.getElementById("muted-list");
ok(mutedBox2.textContent === "暂无应用记录" && mutedBox2.querySelectorAll("input[data-app]").length === 0,
   `list_apps 为空时 #muted-list 显示提示 "${mutedBox2.textContent}" 且不渲染勾选框`);
ok(doc2.getElementById("set-device").textContent === "-" && doc2.getElementById("set-email").textContent === "-",
   `清单外-空值回落：设备名/邮箱空 → "-"（实际 "${doc2.getElementById("set-device").textContent}" / "${doc2.getElementById("set-email").textContent}"）`);
ok(doc2.getElementById("set-quiet-start").value === "23:00" && doc2.getElementById("set-quiet-end").value === "08:00",
   "清单外-空值回落：时段空 → 默认 23:00 / 08:00");
ok(doc2.getElementById("set-version").textContent === "v0.0.0", "清单外：版本回填带 v 前缀（空值场景同样生效）");

// 清单外核对：quiet-row 透明度随 quiet_enabled 载入同步（缺陷 quiet-opacity，已修复）。
// loadSettings 须按 get_settings 的 quiet_enabled 落位 quiet-row 透明度（复用 change 处理器同一常量）：
// 关闭 → 0.4（弱化）、开启 → 1（全亮），与手动切换后的观感一致；曾在载入路径缺同步（KNOWN-BUG 守卫已转正为无条件断言）。
const opacityAfterLoad = doc2.getElementById("quiet-row").style.opacity;
console.log("== 7) quiet-load-sync：quiet-row 透明度随 quiet_enabled 载入同步（无条件断言） ==");
ok(opacityAfterLoad === "0.4",
   `quiet_enabled=false 载入后 quiet-row 应处于弱化透明度 0.4（实际 opacity="${opacityAfterLoad}"）`);

console.log(failed ? `\n${failed} 项断言失败` : "\n设置视图组审计测试 PASS");
process.exit(failed ? 1 : 0);
