#!/usr/bin/env node
// 登录视图 UI 审计（点击链逐项核对）：
//   ① login-required   表单必填/格式校验（email/password required；设备名 pattern）
//   ② login-5fields    提交触发 invoke("login") 且恰好携带 5 字段（email/password/twofa/deviceName/sendToken）
//   ③ login-2fa-msg    错误 2fa_required 显示两步验证提示
//   ④ login-error-path 其它错误显示于 login-error 且错误路径也 refreshStatus
//   ⑤ login-success    login-success 事件切主视图并刷新
//   ⑥ login-btn-busy   登录中禁用按钮、完成恢复文案
// 骨架沿用 tests/test_send_button.mjs：jsdom 加载真实 index.html + app.js，
// 注入 __TAURI__ mock（invoke 记录参数；listen 捕获事件处理器供手动触发），
// 用真实 click/submit 事件驱动。jsdom 24 支持约束校验：必填违规时按钮 click
// 不会派发 submit（探测过），与浏览器行为一致，①可用真实点击链验证。
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
const { window } = dom;
const $ = (id) => window.document.getElementById(id);
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const TOKEN30 = "T".repeat(30);

// ---- __TAURI__ mock ----
const calls = [];            // [cmd, args]
const listeners = {};        // 事件名 → 处理器
let statusResult = { configured: false, email: "", device_name: "", connected: false, version: "t", device_registered: false };
let loginImpl = async () => {};   // 各阶段注入 login 的返回行为
let loginGate = null;             // { resolve }：挂起 login 以观察按钮禁用态

window.__TAURI__ = {
  core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "get_status") return { ...statusResult };
    if (cmd === "login") return loginImpl();
    if (cmd === "history") return [];
    if (cmd === "get_icon") return null;
    return {};
  }},
  event: { listen: async (name, cb) => { listeners[name] = cb; return () => {}; } },
};
const s = window.document.createElement("script");
s.textContent = js;
window.document.body.appendChild(s);
await tick(300);   // 等启动 IIFE（refreshStatus）完成

// ---- 断言/计数工具 ----
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (m) => console.log("PASS:", m);
const loginCalls = () => calls.filter(([c]) => c === "login");
const statusCount = () => calls.filter(([c]) => c === "get_status").length;
const mainHistoryCount = () => calls.filter(([c, a]) => c === "history" && a && a.limit === 200).length;
const assertEq = (act, exp, m) => {
  if (act !== exp) fail(`${m}：期望 ${JSON.stringify(exp)}，实际 ${JSON.stringify(act)}`);
};

function fillForm({ email = "user@example.com", password = "pw-secret", twofa = "", device = "mac-app", token = "" } = {}) {
  $("f-email").value = email;
  $("f-password").value = password;
  $("f-twofa").value = twofa;
  $("f-device").value = device;
  $("f-token").value = token;
}

// ========== 启动态 ==========
if (typeof listeners["login-success"] !== "function")
  fail("app.js 未通过 listen 订阅 login-success 事件");
assertEq($("login-view").classList.contains("hidden"), false, "启动(未配置)应显示登录视图");
assertEq($("main-view").classList.contains("hidden"), true, "启动(未配置)应隐藏主视图");
ok("启动：未登录态停在登录视图，login-success 处理器已捕获");

// ========== ① 必填/格式校验（真实按钮点击链） ==========
{
  let invalidEvents = 0;
  $("login-form").addEventListener("invalid", () => invalidEvents++, true);
  fillForm({ email: "", password: "" });
  $("login-btn").click();
  await tick();
  assertEq(loginCalls().length, 0, "①空 email/password 点击提交不应触发 invoke('login')");
  assertEq($("login-error").classList.contains("hidden"), true, "①被原生校验拦截时不应显示错误条");
  assertEq($("f-email").validity.valueMissing, true, "①email 应报 valueMissing");
  assertEq($("f-email").checkValidity(), false, "①email checkValidity 应为 false");
  assertEq(invalidEvents > 0, true, "①应派发 invalid 事件");

  fillForm({ email: "user@example.com", password: "" });
  $("login-btn").click();
  await tick();
  assertEq(loginCalls().length, 0, "①仅缺 password 点击提交不应触发 invoke('login')");

  // 清单外同区域控件：设备名 pattern（index.html:23 required pattern=[A-Za-z0-9_-]{1,25}）
  fillForm({ device: "bad name!" });
  $("login-btn").click();
  await tick();
  assertEq(loginCalls().length, 0, "①设备名不合 pattern 不应触发 invoke('login')");
  assertEq($("f-device").validity.patternMismatch, true, "①设备名应报 patternMismatch");
  ok("①必填/格式校验：空 email / 空 password / 设备名 pattern 违规均被点击链拦截，invoke('login') 零调用");
}

// ========== ② login 携带 5 字段 ＋ ③ 2fa_required 提示 ＋ ⑥失败恢复 ==========
{
  fillForm({ email: "user@example.com", password: "pw-secret", twofa: "  123456  ", device: "mac-app", token: `  ${TOKEN30}  ` });
  loginImpl = async () => { throw "2fa_required"; };   // 模拟 pushover.rs:180 bail!("2fa_required")
  const statusBefore = statusCount();
  $("login-btn").click();
  assertEq($("login-btn").disabled, true, "⑥提交瞬间按钮应禁用（同步前缀）");
  assertEq($("login-btn").textContent, "登录中…", "⑥提交瞬间文案应为 登录中…");
  await tick();
  assertEq(loginCalls().length, 1, "②合法提交应触发一次 invoke('login')");
  const args = loginCalls()[0][1];
  assertEq(Object.keys(args).sort().join(","), "deviceName,email,password,sendToken,twofa",
    "②login 应恰好携带 5 个字段");
  assertEq(args.email, "user@example.com", "②email 传值");
  assertEq(args.password, "pw-secret", "②password 传值（原文，不 trim）");
  assertEq(args.twofa, "123456", "②twofa 传值且 trim");
  assertEq(args.deviceName, "mac-app", "②deviceName 传值");
  assertEq(args.sendToken, TOKEN30, "②sendToken 传值且 trim");

  const errEl = $("login-error");
  assertEq(errEl.classList.contains("hidden"), false, "③失败后 login-error 应显示");
  assertEq(errEl.textContent, "该账号开启了两步验证，请填写验证码后重试", "③2fa_required 应显示两步验证专用提示");
  assertEq(statusCount(), statusBefore + 1, "③错误路径也应 refreshStatus（get_status 再次被调）");
  assertEq($("login-view").classList.contains("hidden"), false, "③未配置状态下应留在登录视图");
  assertEq($("login-btn").disabled, false, "⑥失败后按钮应恢复可用");
  assertEq($("login-btn").textContent, "登录", "⑥失败后文案应恢复为 登录");
  ok("②login 恰带 5 字段且值正确（含 trim）＋③2fa 专用提示＋错误路径 refreshStatus＋⑥失败恢复");
}

// ========== ②补：email trim ＋ 空 twofa/sendToken 归一 null ==========
// type=email 原生校验会拦截首尾空格值（浏览器同行为），故此处直接派发 submit
// 事件测处理函数本身的 trim/归一逻辑（app.js:187-191）。
{
  fillForm({ email: "  spaced@example.com  ", password: "pw", twofa: "", token: "" });
  loginImpl = async () => { throw "nope"; };
  $("login-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  const args = loginCalls()[loginCalls().length - 1][1];
  assertEq(args.email, "spaced@example.com", "②处理函数对 email 做 trim（app.js:187）");
  assertEq(args.twofa, null, "②空 twofa 应传 null（app.js:189）");
  assertEq(args.sendToken, null, "②空 sendToken 应传 null（app.js:191）");
  ok("②补：email trim 生效；空 twofa/sendToken 归一为 null");
}

// ========== ④ 其它错误 → login-error 显示 ＋ 错误路径 refreshStatus ==========
{
  fillForm({});
  loginImpl = async () => { throw "Bad credentials"; };
  const statusBefore = statusCount();
  $("login-btn").click();
  assertEq($("login-btn").disabled, true, "⑥提交瞬间按钮应禁用（其它错误路径）");
  await tick();
  const errEl = $("login-error");
  assertEq(errEl.classList.contains("hidden"), false, "④其它错误后 login-error 应显示");
  assertEq(errEl.textContent, "Bad credentials", "④其它错误应原样显示 String(err)");
  assertEq(statusCount(), statusBefore + 1, "④错误路径也应 refreshStatus（get_status 再次被调）");
  ok("④其它错误显示于 login-error 且错误路径也 refreshStatus");
}

// ========== ⑤ login-success 事件切主视图并刷新 ==========
{
  statusResult = { configured: true, email: "user@example.com", device_name: "mac-app", connected: true, version: "t", device_registered: true };
  const statusBefore = statusCount(), historyBefore = mainHistoryCount();
  await listeners["login-success"]();   // 模拟 Rust commands.rs:89 app.emit("login-success", ...)
  assertEq($("login-view").classList.contains("hidden"), true, "⑤login-success 后登录视图应隐藏");
  assertEq($("main-view").classList.contains("hidden"), false, "⑤login-success 后主视图应显示");
  assertEq(statusCount(), statusBefore + 1, "⑤处理器应 refreshStatus");
  assertEq(mainHistoryCount(), historyBefore + 1, "⑤处理器应 loadHistory");
  assertEq($("device-label").textContent, "mac-app · user@example.com", "⑤状态栏应显示设备与邮箱");
  ok("⑤login-success 事件切主视图并刷新（refreshStatus + loadHistory）");
}

// ========== ⑥ 登录中禁用按钮、成功后恢复文案 ==========
{
  fillForm({});
  const loginsBefore = loginCalls().length, statusBefore = statusCount(), historyBefore = mainHistoryCount();
  loginImpl = () => new Promise((resolve) => { loginGate = { resolve }; });
  $("login-btn").click();
  assertEq($("login-btn").disabled, true, "⑥login 挂起期间按钮应禁用");
  assertEq($("login-btn").textContent, "登录中…", "⑥login 挂起期间文案应为 登录中…");
  await tick();
  assertEq($("login-btn").disabled, true, "⑥login 未返回期间按钮应持续禁用");
  assertEq(loginCalls().length, loginsBefore + 1, "⑥成功链路应触发 invoke('login')");
  loginGate.resolve();
  await tick(150);
  assertEq($("login-btn").disabled, false, "⑥成功后按钮应恢复");
  assertEq($("login-btn").textContent, "登录", "⑥成功后文案应恢复为 登录");
  assertEq(statusCount(), statusBefore + 1, "⑥成功链路应 refreshStatus");
  assertEq(mainHistoryCount(), historyBefore + 1, "⑥成功链路应 loadHistory");
  assertEq($("main-view").classList.contains("hidden"), false, "⑥成功后应停留在主视图");
  ok("⑥登录中禁用按钮（挂起态持续禁用）、成功后恢复文案并刷新");
}

console.log("\n登录视图 6 项控件功能全部 PASS");
