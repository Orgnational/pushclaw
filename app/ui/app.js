// Pushover Toolkit 前端：invoke 调 Rust 命令 + listen 订阅事件。
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const loginView = $("login-view");
const mainView = $("main-view");

// ---------- 状态 ----------
const state = {
  view: "inbox",        // inbox | archive
  priority: null,       // null | 1 | 2
  selecting: false,
  selected: new Set(),
  deleteArmed: false,
};

function fmtTime(unix) {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function report(err) {
  $("view-hint").textContent = "⚠ " + String(err).slice(0, 160);
  setTimeout(() => { $("view-hint").textContent = ""; }, 8000);
}
window.addEventListener("unhandledrejection", (e) => report(e.reason));
window.addEventListener("error", (e) => report(e.message));

const iconCache = {};
function ico(m) {
  if (!m.icon) return "";
  return `<img class="app-ico" data-icon="${esc(m.icon)}" alt="">`;
}

async function fillIcons() {
  const need = [...new Set(
    [...document.querySelectorAll("img.app-ico[data-icon]")]
      .filter((im) => !im.src.startsWith("data:"))
      .map((im) => im.dataset.icon))];
  await Promise.all(need.map(async (name) => {
    if (iconCache[name]) {
      applyIcon(name);
      return;
    }
    const url = await invoke("get_icon", { name });
    if (url) { iconCache[name] = url; applyIcon(name); }
  }));
}

function applyIcon(name) {
  document.querySelectorAll(`img.app-ico[data-icon="${CSS.escape(name)}"]`)
    .forEach((im) => { im.src = iconCache[name]; });
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

// ---------- 紧急横幅（官方指南：priority=2 醒目呈现直至手动确认） ----------
async function refreshEmergencyBar() {
  const unacked = (await invoke("history", { limit: 50, priority: 2, archived: false }))
    .filter((m) => !m.acked);
  const bar = $("emergency-bar");
  if (!unacked.length) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = `<div class="emg-title">🚨 ${unacked.length} 条紧急消息待确认</div>` +
    unacked.map((m) => `<div class="emg-item" data-id="${m.id}">
      <span class="emg-text">${esc(m.title || m.app || "-")} — ${esc(m.message.slice(0, 60))}</span>
      <button class="danger emg-ack" data-receipt="${esc(m.receipt)}">确认</button>
    </div>`).join("");
}

// ---------- 列表 ----------
async function loadHistory() {
  const msgs = await invoke("history", {
    query: $("search").value.trim() || null,
    limit: 200,
    priority: state.priority,
    archived: state.view === "archive",
  });
  const list = $("list");
  if (!msgs.length) {
    list.innerHTML = `<div class="empty">
      <svg class="claw" viewBox="0 0 24 24"><g fill="currentColor"><path d="M5 3.2 C5.9 6 6.6 10.5 6.2 15.5 C6 18 5.4 20 4.9 20.8 C4.3 19.6 3.6 16.5 3.7 12.6 C3.8 8.6 4.4 5.2 5 3.2 Z"/><path d="M12 2 C13.1 5.4 13.9 10.6 13.5 16.4 C13.3 19.4 12.6 21.8 12 22.8 C11.3 21.4 10.5 17.7 10.6 13.2 C10.7 8.5 11.4 4.5 12 2 Z"/><path d="M19 3.2 C19.6 5.2 20.2 8.6 20.3 12.6 C20.4 16.5 19.7 19.6 19.1 20.8 C18.6 20 17.9 18 17.8 15.5 C17.4 10.5 18.1 6 19 3.2 Z"/></g></svg>
      <p>${state.view === "archive" ? "归档是空的" : "还没有消息"}</p>
      <p class="small">${state.view === "archive" ? "在消息页选中后归档的内容会出现在这里" : "从发送端 po-send 发一条试试"}</p>
    </div>`;
  } else {
    list.innerHTML = msgs.map((m) => {
      const flag = m.priority === 2 ? '<span class="flag f2">紧急</span>'
                 : m.priority === 1 ? '<span class="flag f1">高优</span>' : "";
      const title = m.title || m.app || "-";
      const sel = state.selected.has(m.id);
      const cb = state.selecting ? `<span class="cb"></span>` : "";
      const pcls = m.priority === 2 ? "p2" : m.priority === 1 ? "p1" : "";
      return `<div class="m ${pcls} ${state.selecting ? "selectable" : ""} ${sel ? "sel" : ""}"
                   data-id="${m.id}">
        <div class="m-top">${cb}${ico(m)}${flag}<span class="t">${esc(title)}</span>
          <time>${fmtTime(m.date)}</time></div>
        <pre>${esc(m.message).replace(/\n/g, "<br>")}</pre>
      </div>`;
    }).join("");
  }
  const scope = state.view === "archive" ? "归档" : "";
  $("count-label").textContent = `${scope}显示 ${msgs.length} 条`;
  fillIcons().catch(console.error);
  refreshEmergencyBar().catch(console.error);
}

function refreshBatchBar() {
  $("sel-count").textContent = `已选 ${state.selected.size} 条`;
  $("sel-archive").textContent = state.view === "archive" ? "恢复" : "归档";
  $("batch-bar").classList.toggle("hidden", !state.selecting);
}

function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  state.deleteArmed = false;
  $("select-btn").textContent = on ? "退出选择" : "选择";
  $("select-btn").classList.toggle("active-ghost", on);
  refreshBatchBar();
  loadHistory();
}

// ---------- 详情便签 ----------
function openDetail(m) {
  $("detail-flag").textContent =
    m.priority === 2 ? "!" : m.priority === 1 ? "↑" : "";
  $("detail-flag").style.display = m.priority === 2 || m.priority === 1 ? "" : "none";
  $("detail-title").textContent = m.title || m.app || "-";
  $("detail-time").textContent = fmtTime(m.date);
  const body = $("detail-body");
  if (m.html) { body.innerHTML = `<pre>${m.message}</pre>`; }
  else { body.innerHTML = `<pre>${esc(m.message)}</pre>`; }
  $("detail-meta").textContent =
    [m.app, fmtTime(m.date), m.acked ? "已确认" : null].filter(Boolean).join(" · ");
  const url = $("detail-url");
  if (m.url) { url.href = m.url; url.classList.remove("hidden"); }
  else { url.classList.add("hidden"); }
  const ack = $("detail-ack");
  if (m.priority === 2 && m.receipt && !m.acked) {
    ack.classList.remove("hidden"); ack.disabled = false; ack.textContent = "确认（全设备静默）";
  } else { ack.classList.add("hidden"); }
  $("detail-archive").textContent = m.archived ? "恢复到消息" : "归档";
  $("detail-note").dataset.id = m.id;
  $("detail-note").dataset.archived = m.archived ? "1" : "0";
  $("detail-overlay").classList.remove("hidden");
}

function closeDetail() { $("detail-overlay").classList.add("hidden"); }

// ---------- 状态栏 ----------
async function refreshStatus() {
  const st = await invoke("get_status");
  $("conn-dot").className = "dot " + (st.connected ? "on" : "off");
  $("device-label").textContent = st.configured
    ? `${st.device_name} · ${st.email}` : "未登录";
  loginView.classList.toggle("hidden", st.configured);
  mainView.classList.toggle("hidden", !st.configured);
  return st;
}

// ---------- 事件绑定 ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn"), errEl = $("login-error");
  errEl.classList.add("hidden");
  btn.disabled = true; btn.textContent = "登录中…";
  try {
    // 30s 超时保护：即使 IPC 异常也不会永久卡在登录中
    await Promise.race([
      invoke("login", {
        email: $("f-email").value.trim(),
        password: $("f-password").value,
        twofa: $("f-twofa").value.trim() || null,
        deviceName: $("f-device").value.trim(),
        send_token: $("f-token").value.trim() || null,
      }),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error("登录超时（30 秒）——请检查网络后重试；若反复出现请重启应用")), 30000)),
    ]);
    await refreshStatus();
    await loadHistory();
  } catch (err) {
    errEl.textContent = err === "2fa_required"
      ? "该账号开启了两步验证，请填写验证码后重试" : String(err);
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "登录并注册本机";
  }
});

// 标签页
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  const isSettings = t.dataset.view === "settings";
  const isSend = t.dataset.view === "send";
  state.view = isSettings || isSend ? "inbox" : t.dataset.view;
  showSettings(isSettings);
  showSend(isSend);
  if (!isSettings && !isSend) {
    state.selected.clear();
    setSelecting(false);
    loadHistory();
  }
}));

// 发送视图
let deviceOptions = null;
function showSend(on) {
  ["search"].forEach((id) => $(id).parentElement.classList.toggle("hidden", on));
  $("list").classList.toggle("hidden", on);
  $("emergency-bar").classList.toggle("hidden", on || $("emergency-bar").innerHTML === "");
  $("send-view").classList.toggle("hidden", !on);
  if (on && deviceOptions === null) {
    invoke("list_devices").then((devs) => {
      deviceOptions = devs;
      $("snd-device").innerHTML = '<option value="">全部设备</option>' +
        devs.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    }).catch(report);
  }
}

async function doSend() {
  const btn = $("snd-send"), res = $("snd-result");
  btn.disabled = true; res.textContent = "发送中…";
  try {
    const imgInput = $("snd-image");
    let imageB64 = null, imageName = null;
    if (imgInput.files[0]) {
      const buf = await imgInput.files[0].arrayBuffer();
      let raw = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000)
        raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      imageB64 = btoa(raw);
      imageName = imgInput.files[0].name;
    }
    await invoke("send_message", {
      message: $("snd-message").value,
      title: $("snd-title").value.trim() || null,
      html: $("snd-html").checked,
      priority: Number($("snd-priority").value),
      device: $("snd-device").value || null,
      url: $("snd-url").value.trim() || null,
      image_b64: imageB64,
      image_name: imageName,
    });
    res.textContent = `✓ 已发送 ${new Date().toLocaleTimeString()}`;
    $("snd-message").value = "";
    $("snd-image").value = "";
  } catch (err) { res.textContent = "⚠ " + err; }
  btn.disabled = false;
}

// 设置视图切换
function showSettings(on) {
  ["search", "priority-chips"].forEach((id) => $(id).parentElement.classList.toggle("hidden", on));
  $("list").classList.toggle("hidden", on);
  $("emergency-bar").classList.toggle("hidden", on || $("emergency-bar").innerHTML === "");
  $("settings-view").classList.toggle("hidden", !on);
  if (on) loadSettings();
}

async function loadSettings() {
  const st = await invoke("get_settings");
  $("set-device").textContent = st.device_name || "-";
  $("set-email").textContent = st.email || "-";
  $("set-version").textContent = "v" + st.version;
  $("set-toast").checked = st.toast;
  $("set-sound").checked = st.notify_sound;
  $("set-quiet").checked = st.quiet_enabled;
  $("set-quiet-start").value = st.quiet_start || "23:00";
  $("set-quiet-end").value = st.quiet_end || "08:00";
  $("set-token").value = st.send_token;
  $("set-user").value = st.send_user;
  const muted = new Set(st.muted_apps);
  const apps = await invoke("list_apps");
  const box = $("muted-list");
  if (!apps.length) { box.textContent = "暂无应用记录"; return; }
  box.innerHTML = apps.map((a) => `
    <label class="switch-row"><input type="checkbox" data-app="${esc(a)}"
      ${muted.has(a) ? "checked" : ""} /> 静音 ${esc(a)}</label>`).join("");
  box.querySelectorAll("input[data-app]").forEach((cb) =>
    cb.addEventListener("change", async () => {
      const cur = new Set([...box.querySelectorAll("input[data-app]:checked")].map((c) => c.dataset.app));
      await invoke("save_settings", { settings: { ...st, muted_apps: [...cur] } });
    }));
}

$("set-save").addEventListener("click", async () => {
  const btn = $("set-save");
  btn.disabled = true; btn.textContent = "保存中…";
  try {
    await invoke("save_settings", { settings: {
      send_token: $("set-token").value.trim(),
      send_user: $("set-user").value.trim(),
      toast: $("set-toast").checked,
      notify_sound: $("set-sound").checked,
      quiet_enabled: $("set-quiet").checked,
      quiet_start: $("set-quiet-start").value || "23:00",
      quiet_end: $("set-quiet-end").value || "08:00",
      muted_apps: [...document.querySelectorAll("#muted-list input[data-app]:checked")].map((c) => c.dataset.app),
    }});
    btn.textContent = "✓ 已保存";
  } catch (err) { report(err); btn.textContent = "保存"; }
  setTimeout(() => { btn.textContent = "保存"; btn.disabled = false; }, 2000);
});

$("set-quiet").addEventListener("change", () => {
  $("quiet-row").style.opacity = $("set-quiet").checked ? "1" : "0.4";
});

$("set-sendtest").addEventListener("click", async () => {
  const btn = $("set-sendtest");
  btn.disabled = true; btn.textContent = "发送中…";
  try {
    await invoke("send_test");
    btn.textContent = "✓ 已发送";
  } catch (err) { report(err); btn.textContent = "发送失败"; }
  setTimeout(() => { btn.textContent = "发送测试消息"; btn.disabled = false; }, 3000);
});

// 优先级筛选
$("priority-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
  chip.classList.add("active");
  state.priority = chip.dataset.p === "" ? null : Number(chip.dataset.p);
  loadHistory();
});

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 300);
});

// 选择模式
$("select-btn").addEventListener("click", () => setSelecting(!state.selecting));
$("sel-cancel").addEventListener("click", () => setSelecting(false));
$("sel-all").addEventListener("click", () => {
  document.querySelectorAll("#list .m").forEach((el) =>
    state.selected.add(el.dataset.id));   // 字符串 id：大整数不能用 Number
  refreshBatchBar(); loadHistory();
});

// 批量归档/删除（删除两步确认）
$("sel-archive").addEventListener("click", async () => {
  if (!state.selected.size) return;
  try {
    const ids = [...state.selected];
    await invoke("archive_messages", { ids, archived: state.view !== "archive" });
    state.selected.clear();
    await loadHistory();
  } catch (err) { report(err); }
});
$("sel-delete").addEventListener("click", async () => {
  if (!state.selected.size) return;
  if (!state.deleteArmed) {
    state.deleteArmed = true;
    $("sel-delete").textContent = `确认删除 ${state.selected.size} 条？`;
    setTimeout(() => {
      state.deleteArmed = false;
      $("sel-delete").textContent = "删除";
    }, 5000);
    return;
  }
  state.deleteArmed = false;
  $("sel-delete").textContent = "删除";
  try {
    await invoke("delete_messages", { ids: [...state.selected] });
    state.selected.clear();
    await loadHistory();
  } catch (err) { report(err); }
});

// 列表点击：选择模式切换勾选；否则开详情
$("list").addEventListener("click", async (e) => {
  const card = e.target.closest(".m");
  if (!card) return;
  const id = card.dataset.id;   // 字符串 id
  if (state.selecting) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    refreshBatchBar();
    card.classList.toggle("sel", state.selected.has(id));
    return;
  }
  try {
    const m = await invoke("get_message", { id });
    if (m) openDetail(m);
  } catch (err) { report(err); }
});

$("sync-btn").addEventListener("click", async () => {
  try { await invoke("sync_now"); await loadHistory(); } catch (err) { console.error(err); }
});

// 退出登录（两步确认）：清本地会话回到登录页；云端设备需到官网设备页删除
$("logout-btn").addEventListener("click", async () => {
  const btn = $("logout-btn");
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "确认退出？";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = "退出"; }, 4000);
    return;
  }
  delete btn.dataset.armed;
  btn.textContent = "退出";
  try {
    // 5 秒超时保护：即使 IPC 异常 UI 也不会永久冻结
    await Promise.race([
      invoke("logout"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("退出超时")), 5000)),
    ]);
    setSelecting(false);
    $("emergency-bar").classList.add("hidden");
    await refreshStatus();
  } catch (err) { report(err); await refreshStatus(); }
});

// 详情便签
$("detail-close").addEventListener("click", closeDetail);
$("detail-overlay").addEventListener("click", (e) => {
  if (e.target === $("detail-overlay")) closeDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});
$("detail-url").addEventListener("click", async (e) => {
  e.preventDefault();
  await invoke("open_url", { url: e.target.href });
});
$("detail-ack").addEventListener("click", async (e) => {
  const note = $("detail-note");
  const m = await invoke("get_message", { id: note.dataset.id });
  if (!m?.receipt) return;
  e.target.disabled = true; e.target.textContent = "确认中…";
  try {
    await invoke("ack", { receipt: m.receipt });
    e.target.textContent = "✓ 已确认";
    await loadHistory();
  } catch (err) {
    e.target.disabled = false; e.target.textContent = "确认失败，重试";
  }
});
$("detail-archive").addEventListener("click", async () => {
  const note = $("detail-note");
  await invoke("archive_messages", {
    ids: [note.dataset.id],
    archived: note.dataset.archived !== "1",
  });
  closeDetail();
  await loadHistory();
});
$("detail-delete").addEventListener("click", async () => {
  if (!$("detail-delete").dataset.armed) {
    $("detail-delete").dataset.armed = "1";
    $("detail-delete").textContent = "确认删除？";
    setTimeout(() => {
      delete $("detail-delete").dataset.armed;
      $("detail-delete").textContent = "删除";
    }, 3000);
    return;
  }
  delete $("detail-delete").dataset.armed;
  $("detail-delete").textContent = "删除";
  await invoke("delete_messages", { ids: [$("detail-note").dataset.id] });
  closeDetail();
  await loadHistory();
});

// 紧急横幅上的确认按钮（事件委托）
$("emergency-bar").addEventListener("click", async (e) => {
  const btn = e.target.closest(".emg-ack");
  if (!btn || btn.disabled) return;
  btn.disabled = true; btn.textContent = "确认中…";
  try {
    await invoke("ack", { receipt: btn.dataset.receipt });
    await loadHistory();
  } catch (err) { report(err); btn.disabled = false; btn.textContent = "确认"; }
});

// Rust 侧事件
listen("new-message", async () => {
  if (state.view === "inbox") await loadHistory();
  refreshEmergencyBar().catch(console.error);
});
listen("ws-status", (ev) => {
  const on = ev.payload === "connected";
  $("conn-dot").className = "dot " + (on ? "on" : "off");
  if (on) { $("view-hint").textContent = ""; }
});
listen("ws-error", (ev) => {
  // 连接问题可见化：持续显示直至恢复连接
  $("view-hint").textContent = "⚠ " + ev.payload;
});
listen("do-sync", loadHistory);
listen("navigate-latest", async (ev) => {
  if (state.view !== "inbox") {
    document.querySelector('.tab[data-view="inbox"]').click();
  }
  await loadHistory();
  const el = document.getElementById(`msg-${ev.payload}`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- 启动 ----------
(async () => {
  const st = await refreshStatus();
  if (st.configured) { await loadHistory(); await refreshEmergencyBar(); }
})();
