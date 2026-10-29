#!/usr/bin/env node
// 「发送视图」组 UI 控件点击链核对（UI 审计 · 核对员·send）
// 覆盖：
//   1. send-tab-devices-load  切到发送页懒加载设备下拉（成功填充 / 失败 report / 成功后缓存不重复拉取）
//   2. send-btn-invoke-args   发送按钮点击 → invoke("send_message") 携带全部字段
//                             注：清单写"7 字段"，实际链路携带 8 键
//                             message/title/html/priority/device/url/imageB64/imageName
//                             （app.js:297-305），与 Rust 签名 commands.rs:419-428 一一对应
//                             （Tauri v2 IPC 键为 camelCase）；
//                             若把 imageB64+imageName 计作一个"图片"字段则为 7。
//   3. send-ctrl-cmd-enter    正文内 Ctrl/Cmd+Enter 触发发送；无修饰键 Enter / 其它键不触发
//   4. send-image-b64         图片选择转 base64 传 imageB64/imageName（含跨 0x8000 分块）
//   5. send-success-clear     成功显示 ✓ 已发送并清空正文与图片
//   6. send-fail-shows-error  失败显示 ⚠ 与错误文本，按钮恢复可用
//   7. send-busy-disabled     发送中禁用按钮，完成后恢复
//
// IPC 键名契约（缺陷 send-image-keys 已修复，本组按 camelCase 无条件断言）：
//   Tauri v2 命令参数默认 camelCase（tauri-macros-2.6.3 wrapper.rs:51 默认
//   ArgumentCase::Camel），commands.rs:418 的 #[tauri::command] 未加 rename_all，
//   故 Rust 参数 image_b64/image_name（commands.rs:427-428）期望 IPC 键
//   imageB64/imageName；缺键 visit_none() 静默为 None → 图片附件静默丢失。
//   前端曾以 snake_case image_b64/image_name 调 invoke 触发该缺陷，现已改为
//   camelCase（app.js:300-302），与同文件 login 的 deviceName/sendToken 约定一致。
//
// 骨架照抄 tests/test_send_button.mjs / test_ui_clicks.mjs / test_ui_audit_list.mjs：
// jsdom 加载真实 index.html + app.js，注入 __TAURI__ mock，dispatch 真实 click/input/keydown 事件。
// 运行：cd <仓库根> && node tests/test_ui_audit_send.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log("  PASS:", label); }
  catch (e) { failures++; console.error("  FAIL:", label, "—", e.message); }
}

// mock File：jsdom 24 无 Blob.prototype.arrayBuffer（探针实测 undefined），
// 而 app.js:245 调用 files[0].arrayBuffer()——按平台语义补上实例方法，返回构造时的字节。
function makeMockFile(win, bytes, name) {
  const u8 = new win.Uint8Array(bytes);
  const f = new win.File([u8], name, { type: "image/png" });
  f.arrayBuffer = async () => u8.buffer;
  return f;
}
function attachFile(win, input, f) {
  Object.defineProperty(input, "files", { value: [f], configurable: true });
}

async function boot({ devices, sendFail, deferSend } = {}) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
  const { window } = dom;
  const calls = [];
  let sendResolver = null;
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args ?? {}]);
        if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true };
        if (cmd === "history") return [];
        if (cmd === "get_icon") return null;
        if (cmd === "list_devices") {
          if (devices?.fail) throw devices.fail;           // Tauri invoke 以字符串 reject
          return devices?.list ?? ["mac-app", "phone"];
        }
        if (cmd === "send_message") {
          if (deferSend) return new Promise((r) => { sendResolver = r; });   // 挂起：验证"发送中"态
          if (sendFail) throw sendFail;
          return "1";
        }
        return {};
      },
    },
    event: { listen: async () => {} },
  };
  const s = window.document.createElement("script");
  s.textContent = js;
  window.document.body.appendChild(s);
  await sleep(350);   // 启动 IIFE（app.js:570-573）：refreshStatus + loadHistory + refreshEmergencyBar
  return {
    win: window,
    doc: window.document,
    calls,
    resolveSend: (v) => sendResolver(v),
  };
}
const openSend = async (win, doc) => {
  doc.querySelector('.tab[data-view="send"]').click();
  await sleep(100);
};
const sends = (calls) => calls.filter(([c]) => c === "send_message");
const deviceCalls = (calls) => calls.filter(([c]) => c === "list_devices");
// args 建在 jsdom realm（Object.prototype 不同源），JSON 往返归一到 Node realm 再做深比较
const plain = (args) => JSON.parse(JSON.stringify(args));

// ============ 1. send-tab-devices-load：切到发送页懒加载设备下拉 ============
{
  console.log("\n[1] send-tab-devices-load：成功填充 / 失败 report / 成功后缓存");
  await check("进入发送页前不拉取设备", async () => {
    const { doc, calls } = await boot();
    assert.equal(doc.getElementById("snd-device").options.length, 1, "初始只有'全部设备'");
    assert.equal(deviceCalls(calls).length, 0, "启动时不应调用 list_devices");
  });

  await check("点击发送 tab → list_devices 成功 → 下拉被填充（懒加载首次）", async () => {
    const { win, doc, calls } = await boot({ devices: { list: ["mac-app", "phone"] } });
    await openSend(win, doc);
    assert.equal(deviceCalls(calls).length, 1, "首次进入应恰好调用一次 list_devices");
    const opts = [...doc.getElementById("snd-device").options];
    assert.deepEqual(opts.map((o) => o.value), ["", "mac-app", "phone"], "下拉选项值");
    assert.deepEqual(opts.map((o) => o.textContent), ["全部设备", "mac-app", "phone"], "下拉选项文本");
    assert.equal(doc.getElementById("send-view").classList.contains("hidden"), false, "发送页可见");
    assert.equal(doc.getElementById("list").classList.contains("hidden"), true, "列表隐藏");
  });

  await check("再次切换 tab 不重复拉取（deviceOptions 缓存生效）", async () => {
    const { win, doc, calls } = await boot({ devices: { list: ["mac-app"] } });
    await openSend(win, doc);
    doc.querySelector('.tab[data-view="inbox"]').click();
    await sleep(60);
    doc.querySelector('.tab[data-view="send"]').click();
    await sleep(60);
    assert.equal(deviceCalls(calls).length, 1, "缓存生效，应仍是 1 次");
    assert.equal(doc.getElementById("snd-device").options.length, 2, "选项保留");
  });

  await check("list_devices 失败 → report() 显示 ⚠ + 错误，下拉保持空", async () => {
    const { win, doc } = await boot({ devices: { fail: "pushover: 401 Unauthorized" } });
    await openSend(win, doc);
    const hint = doc.getElementById("view-hint").textContent;
    assert.ok(hint.startsWith("⚠ "), "view-hint 应显示 ⚠ 前缀，实际:" + hint);
    assert.ok(hint.includes("pushover: 401 Unauthorized"), "view-hint 应含错误文本，实际:" + hint);
    assert.equal(doc.getElementById("snd-device").options.length, 1, "失败时下拉仍只有'全部设备'");
  });
}

// ============ 2. send-btn-invoke-args：发送按钮点击携带全部字段 invoke send_message ============
{
  console.log("\n[2] send-btn-invoke-args：8 键参数与 trim/null 归一化");
  await check("填满表单点击发送 → invoke 参数逐键精确匹配", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    doc.getElementById("snd-title").value = "  发布公告  ";
    doc.getElementById("snd-message").value = "  正文第一行\n第二行  ";
    doc.getElementById("snd-html").checked = true;
    doc.getElementById("snd-priority").value = "2";
    doc.getElementById("snd-device").value = "phone";
    doc.getElementById("snd-url").value = "  https://x.example/a  ";
    doc.getElementById("snd-send").click();
    await sleep(120);
    assert.equal(sends(calls).length, 1, "应恰好一次 send_message");
    const args = plain(sends(calls)[0][1]);
    assert.deepEqual(args, {
      message: "  正文第一行\n第二行  ",       // 正文不 trim（app.js:254）
      title: "发布公告",                       // title trim（app.js:255）
      html: true,
      priority: 2,                             // Number()（app.js:257）
      device: "phone",
      url: "https://x.example/a",              // url trim（app.js:303）
      imageB64: null,
      imageName: null,
    });
  });

  await check("空字段归一化为 null / 布尔默认（|| null 与 || false）", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    doc.getElementById("snd-message").value = "只有正文";
    doc.getElementById("snd-send").click();
    await sleep(120);
    const args = plain(sends(calls)[0][1]);
    assert.deepEqual(args, {
      message: "只有正文",
      title: null, html: false, priority: 0, device: null, url: null,
      imageB64: null, imageName: null,
    });
  });
}

// ============ 3. send-ctrl-cmd-enter：快捷发送 ============
{
  console.log("\n[3] send-ctrl-cmd-enter：Ctrl/Cmd+Enter 发送，无修饰键不发送");
  await check("Ctrl+Enter 触发一次发送且携带正文", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    doc.getElementById("snd-message").value = "快捷键正文";
    doc.getElementById("snd-message").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await sleep(120);
    assert.equal(sends(calls).length, 1, "Ctrl+Enter 应恰好触发一次 send_message");
    assert.equal(sends(calls)[0][1].message, "快捷键正文");
  });

  await check("Cmd(Meta)+Enter 同样触发", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    doc.getElementById("snd-message").value = "mac 快捷键";
    doc.getElementById("snd-message").dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await sleep(120);
    assert.equal(sends(calls).length, 1, "Cmd+Enter 应触发 send_message");
    assert.equal(sends(calls)[0][1].message, "mac 快捷键");
  });

  await check("无修饰键 Enter / Ctrl+其它键 不触发发送", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    const msg = doc.getElementById("snd-message");
    msg.value = "不该发送A";
    msg.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(60);
    msg.value = "不该发送B";
    msg.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    await sleep(60);
    assert.equal(sends(calls).length, 0, "无修饰键 Enter 与 Ctrl+其它键不应发送");
  });
}

// ============ 4. send-image-b64：图片选择转 base64 传 imageB64/imageName ============
{
  console.log("\n[4] send-image-b64：文件→分块 b64→invoke 参数（前端链路）");
  await check("小图片文件：imageB64 与 Node base64 一致、imageName 正确", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    const bytes = [0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0x00, 0x80];
    attachFile(win, doc.getElementById("snd-image"), makeMockFile(win, bytes, "pic.png"));
    doc.getElementById("snd-message").value = "带图";
    doc.getElementById("snd-send").click();
    await sleep(150);
    assert.equal(sends(calls).length, 1, "应触发一次 send_message");
    const args = sends(calls)[0][1];
    assert.equal(args.imageB64, Buffer.from(bytes).toString("base64"), "imageB64 应为文件内容的 base64");
    assert.equal(args.imageName, "pic.png", "imageName 应为文件名");
  });

  await check("跨 0x8000 分块边界（0x8001 字节）b64 仍正确", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    const bytes = Array.from({ length: 0x8001 }, (_, i) => i % 251);
    attachFile(win, doc.getElementById("snd-image"), makeMockFile(win, bytes, "big.png"));
    doc.getElementById("snd-message").value = "大图";
    doc.getElementById("snd-send").click();
    await sleep(250);
    const args = sends(calls)[0][1];
    assert.equal(args.imageB64, Buffer.from(bytes).toString("base64"), "分块拼接后的 b64 应完整一致");
    assert.equal(args.imageName, "big.png");
  });
}

// ============ 5. send-success-clear：成功显示 ✓ 已发送并清空正文与图片 ============
{
  console.log("\n[5] send-success-clear：✓ 结果 + 清空正文/图片");
  await check("成功后 snd-result 显示 ✓ 已发送，正文与图片被清空", async () => {
    const { win, doc, calls } = await boot();
    await openSend(win, doc);
    doc.getElementById("snd-message").value = "要被清空的正文";
    attachFile(win, doc.getElementById("snd-image"), makeMockFile(win, [1, 2, 3], "a.png"));
    doc.getElementById("snd-send").click();
    await sleep(150);
    assert.ok(sends(calls).length === 1);
    const res = doc.getElementById("snd-result").textContent;
    assert.ok(res.startsWith("✓ 已发送"), "结果栏应以 '✓ 已发送' 开头，实际:" + res);
    assert.match(res, /\d/, "应带时间戳");
    assert.equal(doc.getElementById("snd-message").value, "", "正文应被清空");
    assert.equal(doc.getElementById("snd-image").value, "", "图片应被清空");
  });
}

// ============ 6. send-fail-shows-error：失败显示 ⚠ 与错误 ============
{
  console.log("\n[6] send-fail-shows-error：⚠ + 错误文本，按钮恢复");
  await check("send_message reject → snd-result 显示 ⚠ 与错误文本", async () => {
    const { win, doc } = await boot({ sendFail: "Token 未配置" });
    await openSend(win, doc);
    doc.getElementById("snd-message").value = "失败场景";
    doc.getElementById("snd-send").click();
    await sleep(150);
    const res = doc.getElementById("snd-result").textContent;
    assert.equal(res, "⚠ Token 未配置", "结果栏应为 '⚠ ' + 错误，实际:" + res);
    assert.equal(doc.getElementById("snd-send").disabled, false, "失败后按钮应恢复可用");
    assert.equal(doc.getElementById("snd-message").value, "失败场景", "失败时正文不应被清空");
  });
}

// ============ 7. send-busy-disabled：发送中禁用按钮 ============
{
  console.log("\n[7] send-busy-disabled：挂起期间禁用，完成后恢复");
  await check("invoke 挂起期间按钮 disabled=true、显示'发送中…'；resolve 后恢复", async () => {
    const { win, doc, resolveSend } = await boot({ deferSend: true });
    await openSend(win, doc);
    doc.getElementById("snd-message").value = "挂起正文";
    doc.getElementById("snd-send").click();
    await sleep(60);
    assert.equal(doc.getElementById("snd-send").disabled, true, "发送中按钮应禁用");
    assert.equal(doc.getElementById("snd-result").textContent, "发送中…", "应显示'发送中…'");
    assert.equal(doc.getElementById("snd-message").value, "挂起正文", "挂起期间正文保留");
    resolveSend("1");
    await sleep(120);
    assert.equal(doc.getElementById("snd-send").disabled, false, "完成后按钮恢复可用");
    assert.ok(doc.getElementById("snd-result").textContent.startsWith("✓ 已发送"), "完成后显示 ✓");
    assert.equal(doc.getElementById("snd-message").value, "", "完成后正文清空");
  });
}

console.log(failures ? `\n${failures} 项断言失败` : "\n发送视图组：全部断言通过");
process.exit(failures ? 1 : 0);
