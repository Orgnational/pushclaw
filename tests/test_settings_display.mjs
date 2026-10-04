import { JSDOM } from "jsdom";
import fs from "fs";

const html = fs.readFileSync("app/ui/index.html", "utf8");
const js = fs.readFileSync("app/ui/app.js", "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
const { window } = dom;
const calls = [];
window.__TAURI__ = {
  core: { invoke: async (cmd) => {
    calls.push(cmd);
    if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "mac-app", connected: true, version: "0.14.2", device_registered: true };
    if (cmd === "get_settings") return {
      send_token: "TOKENaaaaTOKENbbbbTOKENccccdddd11",
      send_user: "uAAAAuAAAAuAAAAuAAAAuAAAAuAAAA1",
      toast: true, quiet_enabled: false, quiet_start: "23:00", quiet_end: "08:00",
      muted_apps: [], version: "0.14.2", device_name: "mac-app", email: "x@y" };
    if (cmd === "history") return [];
    if (cmd === "list_apps") return ["AppA"];
    return {};
  }},
  event: { listen: async () => {} },
};
const s = window.document.createElement("script");
s.textContent = js;
window.document.body.appendChild(s);
await new Promise(r => setTimeout(r, 400));
window.document.querySelector('.tab[data-view="settings"]').click();
await new Promise(r => setTimeout(r, 500));
const tok = window.document.getElementById("set-token").value;
const usr = window.document.getElementById("set-user").value;
console.log("调用命令:", calls.join(", "));
console.log("set-token:", tok ? `有值(尾4 ${tok.slice(-4)})` : "<空>");
console.log("set-user :", usr ? `有值(尾4 ${usr.slice(-4)})` : "<空>");
// 回归防线：设置页"发送"区必须显示 get_settings 返回的凭据
if (!tok || !usr) { console.error("FAIL: 设置页发送凭据未填充"); process.exit(1); }
console.log("设置页凭据显示 PASS");
