#!/usr/bin/env node
// UI 点击链补全（2026-10-19 整改）：设置保存、退出两步确认。
// 死按钮事故后确立的规则：每个用户操作路径都要有点击级测试。
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
const { window } = dom;

const calls = [];
window.__TAURI__ = {
  core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
    if (cmd === "get_settings") return { send_token: "t", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
    if (cmd === "history") return [];
    if (cmd === "list_apps") return [];
    return {};
  }},
  event: { listen: async () => {} },
};
const s = window.document.createElement("script");
s.textContent = js;
window.document.body.appendChild(s);
await new Promise((r) => setTimeout(r, 300));

// ---- 设置保存点击链 ----
window.document.querySelector('.tab[data-view="settings"]').click();
await new Promise((r) => setTimeout(r, 200));
window.document.getElementById("set-token").value = "changed-token";
window.document.getElementById("set-save").click();
await new Promise((r) => setTimeout(r, 200));
const saveCall = calls.find(([c, a]) => c === "save_settings" && a?.settings?.send_token === "changed-token");
if (!saveCall) { console.error("FAIL: 点击保存未携带表单值触发 save_settings"); process.exit(1); }
const saveBtnText = window.document.getElementById("set-save").textContent;
if (!saveBtnText.includes("✓")) { console.error("FAIL: 保存按钮未显示✓:", saveBtnText); process.exit(1); }

// ---- 退出两步确认点击链 ----
const logout = window.document.getElementById("logout-btn");
logout.click();   // 第一次：进入确认态，不触发命令
await new Promise((r) => setTimeout(r, 100));
if (calls.some(([c]) => c === "logout")) { console.error("FAIL: 单击退出不应立即调用 logout（两步确认）"); process.exit(1); }
logout.click();   // 第二次：确认执行
await new Promise((r) => setTimeout(r, 200));
if (!calls.some(([c]) => c === "logout")) { console.error("FAIL: 二次点击未调用 logout"); process.exit(1); }

console.log("UI 点击链 PASS（设置保存✓ + 退出两步确认✓）");
