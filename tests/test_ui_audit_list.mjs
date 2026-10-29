#!/usr/bin/env node
// 「消息列表」组 UI 控件点击链核对（UI 审计 · 核对员·list）
// 覆盖：
//   1. list-card-render   history 渲染消息卡片（标题/时间/未读点/优先级徽章）
//   2. search-debounce    搜索输入 300ms 防抖后触发查询且传 query（含 trim/空→null）
//   3. priority-chips     优先级 chips 切换过滤参数并刷新
//   4. card-click-detail  点击卡片（非选择模式）打开详情 + 未读标记已读
//   5. html-render-esc    html 消息渲染为 HTML、纯文本转义（列表侧 + 详情侧）
//   6. icon-cache         数据驱动图标管线：get_icon→缓存→渲染 img、img 必有 src、失败本会话不重试
//   7. empty-state        空状态显示（收件箱/归档两种文案）
//   + card-click-select-guard（清单外同区域交叉核对）：选择模式下点击卡片不开详情
// 骨架照抄 tests/test_send_button.mjs / test_ui_clicks.mjs：jsdom + __TAURI__ mock + 真实事件 dispatch。
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "app/ui/index.html"), "utf8");
const js = readFileSync(join(root, "app/ui/app.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function ok(cond, label) {
  if (cond) console.log("  PASS:", label);
  else { console.error("  FAIL:", label); failures++; }
}

// 与 app.js fmtTime（app.js:18-24）同算法，用于断言卡片 <time> 的展示值
function fmtTime(unix) {
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 逼真消息对象：字段与 Rust Msg（store.rs:51-68，id 序列化为字符串）一致
function makeMsg(over = {}) {
  return {
    id: "101", umid: "u-101", title: "服务器告警", message: "CPU 100%",
    html: false, priority: 2, url: "", url_title: "", app: "AppA",
    date: 1761811200, acked: true, receipt: "r-101", archived: false,
    icon: "", read: false,
    ...over,
  };
}

async function boot({ history = async () => [], message = async () => null, icons = {} } = {}) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
  const { window } = dom;
  const calls = [];
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args ?? {}]);
        if (cmd === "get_status") return { configured: true, email: "x@y", device_name: "d", connected: true, version: "t", device_registered: true, db_path: "/tmp/x" };
        if (cmd === "history") return await history(args ?? {});
        if (cmd === "get_message") return await message(args ?? {});
        if (cmd === "get_icon") return icons[args?.name] ?? null;
        return {};
      },
    },
    event: { listen: async () => {} },
  };
  const s = window.document.createElement("script");
  s.textContent = js;
  window.document.body.appendChild(s);
  await sleep(350);   // 启动 IIFE（app.js:570-573）：refreshStatus + loadHistory + refreshEmergencyBar
  return { window, doc: window.document, calls };
}
const loads = (calls) => calls.filter(([c, a]) => c === "history" && a.limit === 200);
const input = (win, el) => el.dispatchEvent(new win.Event("input", { bubbles: true }));

// ============ 1. history 渲染消息卡片 ============
{
  console.log("\n[1] list-card-render：卡片标题/时间/未读点/优先级徽章");
  const m1 = makeMsg();  // p2 未读 有标题
  const m2 = makeMsg({ id: "102", umid: "u-102", title: "", message: "常规消息", priority: 1, read: true, app: "AppB", receipt: "" });
  const { doc, calls } = await boot({ history: async () => [m1, m2] });

  const first = loads(calls)[0];
  ok(!!first && first[1].query === null && first[1].limit === 200 && first[1].priority === null && first[1].archived === false,
    "初始 invoke('history', {query:null, limit:200, priority:null, archived:false})");

  const cards = doc.querySelectorAll("#list .m");
  ok(cards.length === 2, `渲染 2 张卡片（实际 ${cards.length}）`);
  const c1 = doc.querySelector('#list .m[data-id="101"]');
  const c2 = doc.querySelector('#list .m[data-id="102"]');
  ok(!!c1 && !!c2, "卡片携带 data-id（字符串大整数安全）");
  ok(c1.querySelector(".t").textContent === "服务器告警", "标题渲染 .t=服务器告警");
  ok(c1.querySelector("time").textContent === fmtTime(m1.date), `时间渲染 <time>=${fmtTime(m1.date)}`);
  ok(!!c1.querySelector(".unread-dot"), "未读消息渲染 .unread-dot");
  ok(c1.querySelector(".flag.f2")?.textContent === "紧急", "p2 徽章 .flag.f2=紧急");
  ok(c1.classList.contains("p2"), "卡片带 p2 样式类");
  ok(c2.querySelector(".t").textContent === "AppB", "空标题回落应用名 .t=AppB");
  ok(!c2.querySelector(".unread-dot"), "已读消息无 .unread-dot");
  ok(c2.querySelector(".flag.f1")?.textContent === "高优", "p1 徽章 .flag.f1=高优");
  ok(c2.classList.contains("p1") && !c2.classList.contains("p2"), "卡片带 p1 无 p2 样式类");
  ok(doc.getElementById("count-label").textContent === "显示 2 条", "计数栏=显示 2 条");
}

// ============ 2. 搜索输入 300ms 防抖 → 查询传 query ============
{
  console.log("\n[2] search-debounce：300ms 防抖 + query 参数（trim / 空串→null / 重置）");
  const { window, calls } = await boot({ history: async () => [makeMsg()] });
  const search = window.document.getElementById("search");
  const n = () => loads(calls).length;
  const lastQ = () => loads(calls).at(-1)?.[1].query;
  const base = n();
  ok(base === 1, `启动后恰 1 次列表加载（实际 ${base}）`);

  search.value = "hello"; input(window, search);
  await sleep(60);
  ok(n() === base, "输入后 60ms 内未触发查询（防抖未到 300ms）");
  await sleep(340);
  ok(n() === base + 1 && lastQ() === "hello", "300ms 后触发且 query=hello");

  search.value = "  spaced  "; input(window, search);
  await sleep(400);
  ok(n() === base + 2 && lastQ() === "spaced", "query 经 trim 后传后端（'  spaced  '→spaced）");

  search.value = "ab"; input(window, search);
  await sleep(100);
  search.value = "abc"; input(window, search);
  await sleep(100);
  ok(n() === base + 2, "连续输入重置防抖计时器（200ms 处仍未触发）");
  await sleep(300);
  ok(n() === base + 3 && lastQ() === "abc", "停顿 300ms 后仅触发一次且 query=abc");

  search.value = ""; input(window, search);
  await sleep(400);
  ok(n() === base + 4 && lastQ() === null, "清空搜索后 query=null（而非空串）");
}

// ============ 3. 优先级 chips 切换过滤参数并刷新 ============
{
  console.log("\n[3] priority-chips：切换 state.priority 并刷新列表");
  const { doc, calls } = await boot({ history: async () => [makeMsg()] });
  const lastP = () => loads(calls).at(-1)?.[1].priority;

  doc.querySelector('#priority-chips .chip[data-p="2"]').click();
  await sleep(250);
  ok(lastP() === 2, "点击「! 紧急」→ history priority=2");
  ok(loads(calls).at(-1)[1].query === null && loads(calls).at(-1)[1].limit === 200 && loads(calls).at(-1)[1].archived === false,
    "切换时其余参数不变（query/limit/archived）");
  const active1 = [...doc.querySelectorAll(".chip.active")];
  ok(active1.length === 1 && active1[0].dataset.p === "2", "active 态唯一且落在被点 chip");

  doc.querySelector('#priority-chips .chip[data-p="1"]').click();
  await sleep(250);
  ok(lastP() === 1, "点击「↑ 高优」→ history priority=1");

  doc.querySelector('#priority-chips .chip[data-p=""]').click();
  await sleep(250);
  ok(lastP() === null, "点击「全部」→ priority=null（非 0）");
}

// ============ 4. 点击卡片（非选择模式）打开详情 ============
{
  console.log("\n[4] card-click-detail：卡片点击 → get_message → 详情便签 + 未读标记已读");
  const m1 = makeMsg({ acked: false, read: false });                       // p2 未读 有回执
  const m2 = makeMsg({ id: "102", umid: "u-102", title: "", message: "常规消息", priority: 1, read: true, app: "AppB", receipt: "" });
  const { doc, calls } = await boot({
    history: async (a) => (a.limit === 50 ? [] : [m1, m2]),   // 紧急横幅查询返回空，保持列表区纯净
    message: async (a) => ({ "101": m1, "102": m2 }[a.id] ?? null),
  });
  const overlay = () => doc.getElementById("detail-overlay");

  doc.querySelector('#list .m[data-id="101"] .t').click();   // 点子元素，验证 closest(".m") 委托
  await sleep(300);
  ok(calls.some(([c, a]) => c === "get_message" && a.id === "101"), "点击卡片 → invoke('get_message',{id:'101'})");
  ok(!overlay().classList.contains("hidden"), "详情便签显示（overlay 移除 hidden）");
  ok(doc.getElementById("detail-title").textContent === "服务器告警", "详情标题=服务器告警");
  ok(doc.getElementById("detail-flag").textContent === "!" && doc.getElementById("detail-flag").style.display !== "none", "p2 详情旗标=!");
  const ack = doc.getElementById("detail-ack");
  ok(!ack.classList.contains("hidden") && !ack.disabled && ack.textContent === "确认", "p2+有回执+未确认 → 确认按钮可用");
  ok(doc.getElementById("detail-url").classList.contains("hidden"), "无 url → 链接隐藏");
  ok(doc.getElementById("detail-meta").textContent.includes("AppA"), "详情 meta 含应用名");
  ok(calls.some(([c, a]) => c === "mark_read" && a.umid === "u-101"), "未读消息开详情 → invoke('mark_read',{umid:'u-101'})");

  doc.getElementById("detail-close").click();
  await sleep(100);
  ok(overlay().classList.contains("hidden"), "关闭按钮收起详情");

  doc.querySelector('#list .m[data-id="102"] .t').click();
  await sleep(300);
  ok(calls.some(([c, a]) => c === "get_message" && a.id === "102"), "第二张卡片 → get_message id=102");
  ok(doc.getElementById("detail-title").textContent === "AppB", "详情标题回落应用名");
  ok(doc.getElementById("detail-flag").textContent === "↑" && doc.getElementById("detail-flag").style.display !== "none", "p1 详情旗标=↑（app.js:134-136 p1 显示旗标，p0 才隐藏）");
  ok(doc.getElementById("detail-ack").classList.contains("hidden"), "非 p2 → 无确认按钮");
  ok(!calls.some(([c, a]) => c === "mark_read" && a.umid === "u-102"), "已读消息不再触发 mark_read");
  doc.getElementById("detail-close").click();

  // 清单外交叉：选择模式下点击卡片只勾选、不开详情
  const gmBefore = calls.filter(([c]) => c === "get_message").length;
  doc.getElementById("select-btn").click();
  await sleep(250);
  ok(!doc.getElementById("batch-bar").classList.contains("hidden"), "（交叉）选择模式开启");
  doc.querySelector('#list .m[data-id="101"]').click();
  await sleep(250);
  ok(calls.filter(([c]) => c === "get_message").length === gmBefore, "（交叉）选择模式点击卡片不触发 get_message");
  ok(doc.querySelector('#list .m[data-id="101"]').classList.contains("sel"), "（交叉）选择模式点击改为勾选 .sel");
  ok(doc.getElementById("sel-count").textContent === "已选 1 条", "（交叉）计数=已选 1 条");
  doc.getElementById("select-btn").click();
  await sleep(250);
  doc.querySelector('#list .m[data-id="101"]').click();
  await sleep(300);
  const after = calls.filter(([c]) => c === "get_message");
  ok(after.length === gmBefore + 1 && after.at(-1)[1].id === "101", "（交叉）退出选择模式后点击恢复打开详情");
}

// ============ 5. html 消息渲染为 HTML、纯文本转义 ============
{
  console.log("\n[5] html-render-esc：html=true 原样渲染 / html=false 与列表侧转义");
  const rawPlain = '<b>bold</b> & "q" <script>window.__pwned=1</script>';
  const msgPlain = makeMsg({ id: "100", umid: "u-100", title: "纯文本", message: rawPlain, priority: 0, read: true });
  const msgHtml = makeMsg({ id: "201", umid: "u-201", title: "富文本", message: "<b>bold</b><i>it</i>", html: true, priority: 0, read: true });
  const msgImg = makeMsg({ id: "202", umid: "u-202", title: "注入测试", message: '<img src=x onerror="window.__pwned=1">', priority: 0, read: true });
  const { window, doc, calls } = await boot({
    history: async (a) => (a.limit === 50 ? [] : [msgPlain, msgHtml, msgImg]),
    message: async (a) => ({ "201": msgHtml, "202": msgImg }[a.id] ?? null),
  });

  const pre = doc.querySelector('#list .m[data-id="100"] pre');
  ok(!doc.querySelector('#list .m[data-id="100"] pre b'), "列表侧：纯文本中的 <b> 未生成元素（已转义）");
  ok(!doc.querySelector('#list .m[data-id="100"] pre script'), "列表侧：<script> 未生成元素（已转义）");
  ok(pre.textContent === rawPlain, "列表侧：pre 文本逐字还原原始内容（含 <> & \"）");
  ok(window.__pwned === undefined, "列表侧：脚本未执行");

  doc.querySelector('#list .m[data-id="201"] .t').click();
  await sleep(300);
  ok(calls.some(([c, a]) => c === "get_message" && a.id === "201"), "打开富文本详情");
  const b = doc.querySelector("#detail-body b");
  const it = doc.querySelector("#detail-body i");
  ok(!!b && b.textContent === "bold" && !!it && it.textContent === "it", "详情侧：html=true 原样渲染为 HTML 元素");
  doc.getElementById("detail-close").click();

  doc.querySelector('#list .m[data-id="202"] .t').click();
  await sleep(300);
  ok(!doc.querySelector("#detail-body img"), "详情侧：html=false 时 <img> 未生成元素（已转义）");
  ok(doc.querySelector("#detail-body pre").textContent === msgImg.message, "详情侧：纯文本逐字还原");
  ok(window.__pwned === undefined, "详情侧：onerror 未执行");
}

// ============ 6. 图标获取→缓存→渲染 img、失败本会话不重试 ============
{
  console.log("\n[6] icon-cache：数据驱动图标管线（get_icon→缓存→渲染 img，失败不重试）");
  const m1 = makeMsg({ icon: "GhostApp" });
  const m2 = makeMsg({ id: "102", umid: "u-102", title: "", message: "x", priority: 1, read: true, app: "AppB", receipt: "", icon: "GhostApp" });
  const m3 = makeMsg({ id: "103", umid: "u-103", title: "失败图标", message: "y", priority: 0, read: true, app: "AppC", receipt: "", icon: "NullApp" });
  const { window, doc, calls } = await boot({
    history: async (a) => (a.limit === 50 ? [] : [m1, m2, m3]),
    icons: { GhostApp: "data:image/png;base64,AAAA" },   // get_icon mock：GhostApp 成功；NullApp 返回 null（下载失败）
  });
  await sleep(400);   // 给 fillIcons 充分的异步窗口

  const iconCalls = (name) => calls.filter(([c, a]) => c === "get_icon" && a?.name === name).length;
  // 期望行为（审计标准）：有 icon 的消息应触发 get_icon，成功后渲染 <img class=app-ico>（必有 src）
  ok(iconCalls("GhostApp") === 1, "fillIcons 对未缓存图标触发 invoke('get_icon',{name:'GhostApp'})（去重后恰 1 次）");
  ok(doc.querySelectorAll('img.app-ico[data-icon="GhostApp"]').length === 2,
    "获取成功后引用该图标的 2 张消息卡片均渲染 <img class=app-ico data-icon=GhostApp>");
  ok(doc.querySelector('img.app-ico[src="data:image/png;base64,AAAA"]') !== null, "img.src 指向 get_icon 返回的 data URL");
  ok(doc.querySelector('img.app-ico[data-icon="NullApp"]') === null, "get_icon 返回 null（下载失败）→ 不渲染该图标的 img");
  ok([...doc.querySelectorAll("img.app-ico")].every((im) => im.getAttribute("src")),
    "无空/缺失 src 的 img（v0.12.3 教训：绝不渲染无 src 的 img）");

  // 失败本会话不重试：搜索防抖触发再次加载列表，NullApp 不再发起 get_icon；已缓存图标不重复请求
  const search = doc.getElementById("search");
  search.value = "y"; input(window, search);
  await sleep(450);
  ok(iconCalls("NullApp") === 1, "失败图标本会话不重试：二次加载后 get_icon('NullApp') 仍恰 1 次");
  ok(iconCalls("GhostApp") === 1, "已缓存图标不重复请求：get_icon('GhostApp') 仍恰 1 次");
}

// ============ 7. 空状态显示 ============
{
  console.log("\n[7] empty-state：收件箱/归档空状态文案");
  const { doc, calls } = await boot({ history: async () => [] });

  let empty = doc.querySelector("#list .empty");
  ok(!!empty && empty.querySelector("p").textContent === "还没有消息", "收件箱空 → .empty +「还没有消息」");
  ok(!doc.querySelector("#list .m"), "空状态无消息卡片");
  ok(doc.getElementById("count-label").textContent === "显示 0 条", "计数栏=显示 0 条");

  doc.querySelector('.tab[data-view="archive"]').click();
  await sleep(250);
  ok(loads(calls).at(-1)[1].archived === true, "切归档 → history archived=true");
  empty = doc.querySelector("#list .empty");
  ok(!!empty && empty.querySelector("p").textContent === "归档是空的", "归档空 → 「归档是空的」");

  doc.querySelector('.tab[data-view="inbox"]').click();
  await sleep(250);
  ok(loads(calls).at(-1)[1].archived === false, "切回收件箱 → archived=false");
  ok(doc.querySelector("#list .empty").querySelector("p").textContent === "还没有消息", "切回后恢复收件箱空文案");
}

console.log("");
if (failures) {
  console.error(`消息列表组核对 FAIL：${failures} 项断言未通过`);
  process.exit(1);
}
console.log("消息列表组核对 PASS ✓（卡片渲染/搜索防抖/chips/卡片点击详情/html转义/图标管线/空状态 + 选择模式交叉守卫）");
