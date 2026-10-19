#!/usr/bin/env node
// 发送按钮点击链回归（2026-10-19 事故：snd-send 自 v0.11.0 起未绑定——
// 按钮、doSend 函数都存在但没连接，点击零反应零报错，存活三周）。
// 断言：点击发送按钮 → invoke("send_message") 被调用（按钮→handler→IPC 全链）。
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
    if (cmd === "get_settings") return { send_token: "t30charsXXXXXXXXXXXXXXXXXXXXXX", send_user: "u", toast: true, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "x@y" };
    if (cmd === "history") return [];
    if (cmd === "list_apps") return [];
    if (cmd === "list_devices") return ["mac-app"];
    return {};
  }},
  event: { listen: async () => {} },
};
const s = window.document.createElement("script");
s.textContent = js;
window.document.body.appendChild(s);
await new Promise((r) => setTimeout(r, 300));

// 切到发送 tab + 填正文 + 点发送按钮
window.document.querySelector('.tab[data-view="send"]').click();
await new Promise((r) => setTimeout(r, 200));
window.document.getElementById("snd-message").value = "点击链回归正文";
window.document.getElementById("snd-send").click();
await new Promise((r) => setTimeout(r, 300));

const hit = calls.find(([c]) => c === "send_message");
if (!hit) {
  console.error("FAIL: 点击发送按钮未触发 invoke('send_message')——按钮绑定缺失（历史事故形态）");
  process.exit(1);
}
if (hit[1].message !== "点击链回归正文") {
  console.error("FAIL: 正文未随 invoke 传递:", JSON.stringify(hit[1]));
  process.exit(1);
}
const res = window.document.getElementById("snd-result").textContent;
if (!res.includes("✓")) {
  console.error("FAIL: 发送结果栏未显示 ✓，实际:", res);
  process.exit(1);
}
console.log("发送按钮点击链 PASS（点击→invoke→✓ 结果）");
