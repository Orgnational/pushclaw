#!/usr/bin/env node
/**
 * 登录跳转复现：真实 login handler 流程（mock IPC），验证提交后是否跳转主视图。
 * 运行：node tests/test_login_jump.mjs（在 app/ 目录下，需 jsdom）
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf-8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf-8");

let loginDone = false;
const invokes = [];
const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
const { window } = dom;
window.__TAURI__ = { core: { invoke: async (cmd, args) => {
  invokes.push([cmd, args]);
  switch (cmd) {
    case "get_status": return loginDone
      ? { configured: true, email: "t@t", device_name: "d", connected: true, db_path: "/x", version: "t" }
      : { configured: false, email: "", device_name: "", connected: false, db_path: "/x", version: "t" };
    case "login":
      await new Promise(r => setTimeout(r, 100));
      loginDone = true;
      return;
    case "history": return loginDone ? [{ id: "1", umid: "u1", title: "t", message: "m", html: false, priority: 0, url: "", url_title: "", app: "a", date: 1, acked: false, receipt: "", archived: false, read: true, icon: "" }] : [];
    case "get_settings": return { send_token: "", send_user: "", toast: true, notify_sound: false, quiet_enabled: false, quiet_start: "", quiet_end: "", muted_apps: [], version: "t", device_name: "d", email: "t@t" };
    case "list_apps": return ["A"];
    case "get_icon": return null;
    default: return null;
  }
}}, event: { listen: async () => () => {} }};

const s = window.document.createElement("script");
s.textContent = js;
window.document.body.appendChild(s);

const $ = (id) => window.document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const expect = (c, n, d = "") => { console.log(`[${c ? "PASS" : "FAIL"}] ${n}${c ? "" : " — " + d}`); if (!c) failed++; };

await sleep(80);
expect(!$("login-view").classList.contains("hidden"), "初始显示登录视图");
expect($("main-view").classList.contains("hidden"), "初始隐藏主视图");

$("f-email").value = "t@t";
$("f-password").value = "pw";
$("f-device").value = "dev";
$("login-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
await sleep(400);
expect($("login-view").classList.contains("hidden"), "登录成功后登录视图隐藏",
  `loginView hidden=${$("login-view").classList.contains("hidden")}`);
expect(!$("main-view").classList.contains("hidden"), "主视图显示",
  `mainView hidden=${$("main-view").classList.contains("hidden")}`);
expect(invokes.some(([c]) => c === "history"), "登录后加载历史");

console.log(failed ? `\n${failed} 项失败` : "\n登录跳转流程通过");
process.exit(failed ? 1 : 0);
