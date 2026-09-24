// Pushover Toolkit 前端：全部逻辑通过 invoke 调 Rust 命令 + listen 订阅事件。
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const loginView = $("login-view");
const mainView = $("main-view");

function fmtTime(unix) {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function renderBody(m) {
  if (m.html) {
    // html 消息按发送方原始 HTML 渲染（私有通道，发信人可信）
    const pre = document.createElement("pre");
    pre.innerHTML = m.message;
    return pre.outerHTML;
  }
  return `<pre>${esc(m.message).replace(/\n/g, "<br>")}</pre>`;
}

function renderMessage(m) {
  const flag = m.priority === 2 ? "!" : m.priority === 1 ? "↑" : "";
  const title = m.title || m.app || "-";
  const titleHtml = m.url
    ? `<a href="#" data-url="${esc(m.url)}">${esc(title)}</a>`
    : esc(title);
  const ackBtn = m.priority === 2 && m.receipt && !m.acked
    ? `<button class="ack" data-receipt="${esc(m.receipt)}">确认（全设备静默）</button>`
    : m.acked ? `<span class="muted small"> ✓ 已确认</span>` : "";
  return `<div class="m" id="msg-${m.id}">
    <time>${fmtTime(m.date)}</time>
    <span class="p">${flag}</span><span class="t">${titleHtml}</span>
    ${renderBody(m)}${ackBtn}
  </div>`;
}

async function loadHistory() {
  const q = $("search").value.trim();
  const msgs = await invoke("history", { query: q || null, limit: 200 });
  $("list").innerHTML = msgs.length
    ? msgs.map(renderMessage).join("")
    : `<p class="muted" style="text-align:center;padding:40px 0">${
        q ? "没有匹配的消息" : "还没有消息 — 从发送端发一条试试"}</p>`;
  $("count-label").textContent = `显示 ${msgs.length} 条`;
}

async function refreshStatus() {
  const st = await invoke("get_status");
  $("conn-dot").className = "dot " + (st.connected ? "on" : "off");
  $("device-label").textContent = st.configured
    ? `${st.device_name} · ${st.email}`
    : "未登录";
  loginView.classList.toggle("hidden", st.configured);
  mainView.classList.toggle("hidden", !st.configured);
  return st;
}

// ---------- 事件绑定 ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  const errEl = $("login-error");
  errEl.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "登录中…";
  try {
    await invoke("login", {
      email: $("f-email").value.trim(),
      password: $("f-password").value,
      twofa: $("f-twofa").value.trim() || null,
      deviceName: $("f-device").value.trim(),
    });
    await refreshStatus();
    await loadHistory();
  } catch (err) {
    errEl.textContent = err === "2fa_required"
      ? "该账号开启了两步验证，请填写验证码后重试"
      : String(err);
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "登录并注册本机";
  }
});

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 300);
});

$("sync-btn").addEventListener("click", async () => {
  try {
    await invoke("sync_now");
    await loadHistory();
  } catch (err) {
    console.error(err);
  }
});

// 事件委托：链接与确认按钮
$("list").addEventListener("click", async (e) => {
  const urlEl = e.target.closest("a[data-url]");
  if (urlEl) {
    e.preventDefault();
    await invoke("open_url", { url: urlEl.dataset.url });
    return;
  }
  const ackEl = e.target.closest("button.ack");
  if (ackEl && !ackEl.disabled) {
    ackEl.disabled = true;
    ackEl.textContent = "确认中…";
    try {
      await invoke("ack", { receipt: ackEl.dataset.receipt });
      ackEl.textContent = "✓ 已确认";
    } catch (err) {
      ackEl.disabled = false;
      ackEl.textContent = "确认失败，重试";
      console.error(err);
    }
  }
});

// Rust 侧事件
listen("new-message", async () => { await loadHistory(); });
listen("ws-status", async (ev) => {
  const on = ev.payload === "connected";
  $("conn-dot").className = "dot " + (on ? "on" : "off");
});
listen("do-sync", loadHistory);
listen("navigate-latest", async (ev) => {
  const id = ev.payload;
  const el = document.getElementById(`msg-${id}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    location.hash = `msg-${id}`;
  }
  await loadHistory();
});

// ---------- 启动 ----------
(async () => {
  const st = await refreshStatus();
  if (st.configured) await loadHistory();
})();
