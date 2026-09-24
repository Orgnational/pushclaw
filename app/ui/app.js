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

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
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
    list.innerHTML = `<p class="muted" style="text-align:center;padding:40px 0">${
      state.view === "archive" ? "归档是空的" : "还没有消息 — 从发送端发一条试试"}</p>`;
  } else {
    list.innerHTML = msgs.map((m) => {
      const flag = m.priority === 2 ? "!" : m.priority === 1 ? "↑" : "";
      const title = m.title || m.app || "-";
      const sel = state.selected.has(m.id);
      const cb = state.selecting ? `<span class="cb"></span>` : "";
      return `<div class="m ${state.selecting ? "selectable" : ""} ${sel ? "sel" : ""}"
                   data-id="${m.id}">
        <time>${fmtTime(m.date)}</time>${cb}<span class="p">${flag}</span>
        <span class="t">${esc(title)}</span>
        <pre>${esc(m.message).replace(/\n/g, "<br>")}</pre>
      </div>`;
    }).join("");
  }
  const scope = state.view === "archive" ? "归档" : "";
  $("count-label").textContent = `${scope}显示 ${msgs.length} 条`;
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
  state.view = t.dataset.view;
  state.selected.clear();
  setSelecting(false);
  loadHistory();
}));

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
    state.selected.add(Number(el.dataset.id)));
  refreshBatchBar(); loadHistory();
});

// 批量归档/删除（删除两步确认）
$("sel-archive").addEventListener("click", async () => {
  if (!state.selected.size) return;
  const ids = [...state.selected];
  await invoke("archive_messages", { ids, archived: state.view !== "archive" });
  state.selected.clear();
  await loadHistory();
});
$("sel-delete").addEventListener("click", async () => {
  if (!state.selected.size) return;
  if (!state.deleteArmed) {
    state.deleteArmed = true;
    $("sel-delete").textContent = `确认删除 ${state.selected.size} 条？`;
    setTimeout(() => {
      state.deleteArmed = false;
      $("sel-delete").textContent = "删除";
    }, 3000);
    return;
  }
  state.deleteArmed = false;
  $("sel-delete").textContent = "删除";
  await invoke("delete_messages", { ids: [...state.selected] });
  state.selected.clear();
  await loadHistory();
});

// 列表点击：选择模式切换勾选；否则开详情
$("list").addEventListener("click", async (e) => {
  const card = e.target.closest(".m");
  if (!card) return;
  const id = Number(card.dataset.id);
  if (state.selecting) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    refreshBatchBar();
    card.classList.toggle("sel", state.selected.has(id));
    return;
  }
  const m = await invoke("get_message", { id });
  if (m) openDetail(m);
});

$("sync-btn").addEventListener("click", async () => {
  try { await invoke("sync_now"); await loadHistory(); } catch (err) { console.error(err); }
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
  const m = await invoke("get_message", { id: Number(note.dataset.id) });
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
    ids: [Number(note.dataset.id)],
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
  await invoke("delete_messages", { ids: [Number($("detail-note").dataset.id)] });
  closeDetail();
  await loadHistory();
});

// Rust 侧事件
listen("new-message", async () => { if (state.view === "inbox") await loadHistory(); });
listen("ws-status", (ev) => {
  $("conn-dot").className = "dot " + (ev.payload === "connected" ? "on" : "off");
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
  if (st.configured) await loadHistory();
})();
