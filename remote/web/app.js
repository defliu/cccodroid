// cccodroid remote — Phase 1 PWA.
// Pairs with the gateway bridge, lists sessions, sends prompts and renders the
// gateway event stream. All payloads are AES-GCM encrypted end to end.

import {
  b64url,
  unb64url,
  normalizeCode,
  sha256Hex,
  pairKeyFromCode,
  hmacHex,
  generateEcdh,
  deriveShared,
  dataKeyFromShared,
  encryptText,
  decryptText,
  keyProofMessage,
  MAX_PLAIN_BYTES,
  plainBytes,
} from "/protocol.mjs";

const $ = (id) => document.getElementById(id);
const ui = {
  room: $("room"),
  code: $("code"),
  connect: $("connect"),
  disconnect: $("disconnect"),
  dot: $("dot"),
  state: $("state"),
  session: $("session"),
  refresh: $("refresh"),
  stop: $("stop"),
  log: $("log"),
  text: $("text"),
  send: $("send"),
};

const state = {
  ws: null,
  room: "",
  code: "",
  pairKey: null,
  ecdh: null,
  dataKey: null,
  peerId: null,
  connected: false,
  manualClose: false,
  fatal: false,
  retry: null,
  retryDelay: 2000,
  sessions: [],
  watch: undefined, // 已下发的会话筛选（null = 不过滤）；undefined = 这条连接还没下发过，ready 后重下
  pending: [],      // 密钥还没算完就到达的 data 帧（hello 先到、ready 紧随其后），算完再解
  history: { sessionId: null, cursor: 0, busy: false, tip: null, slot: null },   // 当前渲染的是哪个会话的历史
};

function setStatus(text, kind) {
  ui.state.textContent = text;
  ui.dot.className = "dot" + (kind ? " " + kind : "");
}

function mkLine(text, cls = "sys") {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.textContent = text;
  return el;
}

function logLine(text, cls = "sys") {
  const el = mkLine(text, cls);
  ui.log.appendChild(el);
  ui.log.scrollTop = ui.log.scrollHeight;
  return el;
}

function setInputs(enabled) {
  ui.text.disabled = !enabled;
  ui.send.disabled = !enabled;
  ui.stop.disabled = !enabled;
  ui.refresh.disabled = !enabled;
}

function parseHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (p.get("room")) ui.room.value = p.get("room");
  if (p.get("code")) ui.code.value = p.get("code");
}

function renderSessions(list, keep = true) {
  state.sessions = Array.isArray(list) ? list : [];
  const prev = keep ? ui.session.value : "";
  ui.session.innerHTML = "";
  const optNew = document.createElement("option");
  optNew.value = "";
  optNew.textContent = "新会话";
  ui.session.appendChild(optNew);
  for (const s of state.sessions) {
    const o = document.createElement("option");
    o.value = s.id;
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
    o.textContent = `${s.title || s.id.slice(0, 8)}${s.current ? " · 当前" : ""}${when ? " · " + when : ""}`;
    ui.session.appendChild(o);
  }
  // 「新会话」是用户明确的选择（watch = null）。列表刷新不能被「当前项目」的会话顶掉，
  // 否则筛选会在用户没动下拉框的情况下自己变严。只有首次拿到列表（keep=false）才自动选一个。
  if (prev && [...ui.session.options].some((o) => o.value === prev)) ui.session.value = prev;
  else if (!keep) {
    const cur = state.sessions.find((s) => s.current);
    if (cur) ui.session.value = cur.id;
  }
}

// ── 历史回放（Phase 2 C）：进入会话先补最近一页，顶部按钮往前翻 ──────────
let moreBtn = null;       // 「加载更早」，历史区最上面
let historyFirst = null;  // 已渲染历史里最老的一条，更早的页插在它前面

function clearHistoryView() {
  ui.log.innerHTML = "";
  streamEl = null;
  moreBtn = null;
  historyFirst = null;
}

function setHistorySession(sid) {
  clearHistoryView();
  state.history = { sessionId: sid || null, cursor: 0, busy: false, tip: null, slot: null };
  if (!sid) {
    logLine("新会话：只显示实时输出", "sys");
    return;
  }
  moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "ghost more hidden";
  moreBtn.textContent = "加载更早";
  moreBtn.addEventListener("click", () => requestHistory(false));
  ui.log.appendChild(moreBtn);
  const opt = [...ui.session.options].find((o) => o.value === sid);
  logLine(`会话历史：${opt ? opt.textContent : sid}`, "sys");
  state.history.tip = logLine("正在载入最近的消息…", "sys");
  state.history.slot = document.createComment("history");   // 历史都插在这个锚点前面
  ui.log.appendChild(state.history.slot);
  if (state.connected) requestHistory(true);
}

function requestHistory(reset) {
  const h = state.history;
  if (!h.sessionId || h.busy || !state.connected) return;
  if (!reset && h.cursor <= 0) return;
  h.busy = true;
  if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = "载入中…"; }
  sendCmd({ cmd: "history", sessionId: h.sessionId, before: reset ? null : h.cursor, limit: 40 });
}

function historyEl(it, names) {
  if (!it || typeof it !== "object") return null;
  if (it.role === "user") return it.text ? mkLine(it.text, "me") : null;
  if (it.role === "assistant") return it.text ? mkLine(it.text, "them") : null;
  if (it.role === "note") return it.text ? mkLine(it.text, "sys") : null;
  if (it.role === "tool_use") return mkLine(`🛠 ${it.name || "tool"}`, "tool");
  if (it.role === "tool_result") return mkLine(`${it.ok === false ? "✗" : "✓"} ${names.get(it.id) || "工具结果"}`, "tool");
  return null;
}

function handleHistory(p) {
  const h = state.history;
  if (!p || p.sessionId !== h.sessionId) return;   // 已经切到别的会话，旧回包丢掉
  h.busy = false;
  if (h.tip) { h.tip.remove(); h.tip = null; }
  if (moreBtn) { moreBtn.disabled = false; moreBtn.textContent = "加载更早"; }
  if (p.missing) {
    logLine("会话记录不在了（可能已被删除或移动）", "sys");
    h.cursor = 0;
    if (moreBtn) moreBtn.classList.add("hidden");
    return;
  }
  const items = Array.isArray(p.items) ? p.items : [];
  const names = new Map();   // tool_use id → 名字，同一页里的工具结果据此显示
  for (const it of items) if (it && it.role === "tool_use" && it.id) names.set(it.id, it.name);
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const el = historyEl(it, names);
    if (el) frag.appendChild(el);
  }
  const first = frag.firstChild;
  if (first) {
    const reset = historyFirst === null;
    const oldH = ui.log.scrollHeight;
    if (!reset && historyFirst.parentNode === ui.log) ui.log.insertBefore(frag, historyFirst);
    else ui.log.insertBefore(frag, h.slot || null);
    historyFirst = first;
    if (reset) ui.log.scrollTop = ui.log.scrollHeight;
    else ui.log.scrollTop += ui.log.scrollHeight - oldH;   // 往前翻：视野跟着插入的内容走，不跳到顶部
  } else if (historyFirst === null) {
    logLine("没有历史消息", "sys");
  }
  h.cursor = Number(p.cursor) || 0;
  if (moreBtn) moreBtn.classList.toggle("hidden", h.cursor <= 0);
}

async function sendCmd(obj) {
  if (!state.connected || !state.dataKey) return false;
  const payload = JSON.stringify(obj);
  // 中继单帧 256 KB，密文 base64 后还要膨胀；超了中继会直接 1009 断开，所以在发之前挡住
  if (plainBytes(payload) > MAX_PLAIN_BYTES) {
    logLine(`消息太长（${Math.round(plainBytes(payload) / 1024)} KB），超过了中继的单帧上限，请拆成几条发送`, "sys");
    return false;
  }
  const { iv, ct } = await encryptText(state.dataKey, payload, `${state.room}:c2a`);
  state.ws.send(JSON.stringify({ t: "data", iv, ct }));
  return true;
}

// 把下拉框的选择同步给网关：选了会话就只收这个会话的进度，「新会话」发 null 不过滤。
// 事件归属在网关侧解析（run_start/run_end 带会话号，中间事件靠 runId 映射），这里只管下发。
// 换会话时顺带清屏并载入那一页历史，免得把上一个会话的流式内容混在一起。
function pushWatch(force = false) {
  const sid = ui.session.value || null;
  if (!force && sid === state.watch) return;
  const changed = sid !== state.watch;
  state.watch = sid;
  if (changed || force) setHistorySession(sid);
  if (state.connected) sendCmd({ cmd: "watch", sessionId: sid });
}

async function onDataFrame(iv, ct) {
  const text = await decryptText(state.dataKey, iv, ct, `${state.room}:a2c`);
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { type: "text", text }; }
  handlePayload(payload);
}

async function drainPending() {
  const frames = state.pending;
  state.pending = [];
  for (const f of frames) {
    try { await onDataFrame(f.iv, f.ct); } catch (e) { logLine("处理失败：" + (e && e.message ? e.message : String(e)), "sys"); }
  }
}

async function connect(fresh = false) {
  if (state.ws) return;
  state.manualClose = false;
  state.fatal = false;
  if (fresh) { ui.log.innerHTML = ""; streamEl = null; state.retryDelay = 2000; }
  state.room = ui.room.value.trim().toLowerCase();
  state.code = normalizeCode(ui.code.value);
  if (!/^[a-f0-9]{16,64}$/.test(state.room)) return setStatus("房间号格式不对", "bad");
  if (state.code.length !== 26) return setStatus("配对码长度不对（26 位）", "bad");

  setStatus("连接中…");
  state.pairKey = await pairKeyFromCode(state.code);
  const codeHash = await sha256Hex(state.code);
  location.hash = `room=${encodeURIComponent(state.room)}&code=${encodeURIComponent(state.code)}`;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    setStatus("已连接中继，等待配对…");
    ws.send(JSON.stringify({ t: "join", room: state.room, codeHash }));
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try {
      if (msg.t === "joined") {
        state.peerId = msg.peerId;
        state.ecdh = await generateEcdh();
        const pub = b64url(state.ecdh.pubRaw);
        const mac = await hmacHex(state.pairKey, keyProofMessage("client", pub));
        ws.send(JSON.stringify({ t: "hello", pub, mac }));
        setStatus("已加入房间，握手中…");
      } else if (msg.t === "hello") {
        const pub = String(msg.pub || "");
        const want = await hmacHex(state.pairKey, keyProofMessage("agent", pub));
        if (want !== String(msg.mac || "")) {
          logLine("⚠️ 对方密钥校验失败，已断开", "sys");
          ws.close();
          return;
        }
        const shared = await deriveShared(state.ecdh.privateKey, unb64url(pub));
        state.dataKey = await dataKeyFromShared(shared, state.room);
        state.connected = true;
        state.retryDelay = 2000;
        setStatus("已加密连接", "ok");
        setInputs(true);
        ui.connect.disabled = true;
        ui.disconnect.disabled = false;
        ui.room.disabled = true;
        ui.code.disabled = true;
        logLine("通道已建立（端到端加密）", "sys");
        await drainPending();          // 先补上握手期间到达的 ready，再拉列表
        await sendCmd({ cmd: "list" });
      } else if (msg.t === "data") {
        if (!state.dataKey) {
          // hello 与 ready 几乎同时到达，密钥可能还没算完：先存着，握手完成再按序解开
          if (state.pending.length < 50) state.pending.push({ iv: msg.iv, ct: msg.ct });
          return;
        }
        await onDataFrame(msg.iv, msg.ct);
      } else if (msg.t === "peer" && msg.event === "join") {
        logLine("网关已上线", "sys");
      } else if (msg.t === "peer" && msg.event === "leave") {
        logLine("网关已离线", "sys");
      } else if (msg.t === "closed") {
        logLine("房间已关闭", "sys");
        ws.close();
      } else if (msg.t === "error") {
        logLine(`错误：${msg.code} ${msg.message || ""}`, "sys");
        setStatus("出错：" + (msg.code || "unknown"), "bad");
        // 配对码不对是永久的，重试多少次都一样；no-room 只是网关暂时不在线，照常退避重连
        if (msg.code === "bad-code") state.fatal = true;
        if (["bad-code", "no-room", "room-taken", "bad-open"].includes(msg.code)) ws.close();
      }
    } catch (e) {
      logLine("处理失败：" + (e && e.message ? e.message : String(e)), "sys");
    }
  };

  ws.onclose = () => {
    state.ws = null;
    state.connected = false;
    state.dataKey = null;
    state.watch = undefined;   // 新连接要重新下发筛选
    state.pending = [];
    state.history.busy = false;
    setInputs(false);
    ui.connect.disabled = false;
    ui.disconnect.disabled = true;
    ui.room.disabled = false;
    ui.code.disabled = false;
    if (state.manualClose) {
      setStatus("已断开");
      return;
    }
    if (state.fatal) {
      setStatus("配对码不对，已停止重试", "bad");
      return;
    }
    // 网关重启期间房间会短暂不存在（no-room）：退避重连，2 秒起、翻倍、封顶 30 秒，连上后重置
    const wait = state.retryDelay;
    state.retryDelay = Math.min(state.retryDelay * 2, 30_000);
    setStatus(`连接断开，${Math.round(wait / 1000)} 秒后重连…`, "bad");
    clearTimeout(state.retry);
    state.retry = setTimeout(() => { if (!state.manualClose && !state.fatal) connect(); }, wait);
  };

  ws.onerror = () => setStatus("连接失败", "bad");
}

function handlePayload(p) {
  if (!p || typeof p !== "object") return;
  switch (p.type) {
    case "ready":
      renderSessions(p.sessions, false);
      logLine(`已连接网关（${(p.sessions || []).length} 个会话）`, "sys");
      pushWatch();
      break;
    case "sessions":
      renderSessions(p.sessions, true);
      pushWatch();
      break;
    case "watching":
      if (p.sessionId) logLine("只显示所选会话的进度", "sys");
      break;
    case "history":
      handleHistory(p);
      break;
    case "queued":
      logLine(p.injected ? "已插入当前轮" : "已发送，等待执行", "sys");
      break;
    case "stopped":
      logLine(p.killed ? "已停止当前轮" : "没有正在跑的任务", "sys");
      break;
    case "state":
      logLine(`队列 ${p.queue} 条 · 运行中 ${p.runs} 轮`, "sys");
      break;
    case "error":
      logLine(`网关错误：${p.message || ""}`, "sys");
      break;
    case "event":
      renderEvent(p.ev);
      break;
    default:
      if (typeof p.text === "string") logLine(p.text, "them");
      else logLine(JSON.stringify(p), "sys");
  }
}

function renderEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  if (ev.type === "delta" || ev.type === "assistant_text") {
    appendStream(ev.text || "", "them");
  } else if (ev.type === "thinking_delta") {
    appendStream(ev.text || "", "think");
  } else if (ev.type === "tool_use") {
    appendStream(`\n🛠 ${ev.name || "tool"}\n`, "tool");
  } else if (ev.type === "tool_result") {
    appendStream(`\n${ev.ok === false ? "✗" : "✓"} ${ev.name || "tool"}\n`, "tool");
  } else if (ev.type === "phase") {
    if (ev.phase === "tool" && ev.name) appendStream(`\n[${ev.name}]\n`, "tool");
  } else if (ev.type === "run_end") {
    appendStream("\n— 本轮结束 —\n", "sys");
    sendCmd({ cmd: "list" });
  } else if (ev.type === "error") {
    appendStream(`\n⚠️ ${ev.message || "错误"}\n`, "sys");
  } else if (ev.type === "session_gone") {
    sendCmd({ cmd: "list" });
  }
}

let streamEl = null;
function appendStream(text, cls) {
  if (!text) return;
  if (!streamEl || streamEl.dataset.cls !== cls) {
    streamEl = logLine("", cls);
    streamEl.dataset.cls = cls;
  }
  streamEl.textContent += text;
  ui.log.scrollTop = ui.log.scrollHeight;
}

async function send() {
  const text = ui.text.value.trim();
  if (!text || !state.connected) return;
  const sessionId = ui.session.value || undefined;
  const ok = await sendCmd({ cmd: "send", text, sessionId, cid: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  if (!ok) return;          // 超长之类的发送失败：正文留在输入框里，别当成已发出
  logLine(text, "me");
  ui.text.value = "";
  streamEl = null;
}

function disconnect() {
  state.manualClose = true;
  clearTimeout(state.retry);
  if (state.ws) state.ws.close();
}

ui.connect.addEventListener("click", () => { connect(true); });
ui.disconnect.addEventListener("click", disconnect);
ui.send.addEventListener("click", send);
ui.stop.addEventListener("click", () => sendCmd({ cmd: "stop" }));
ui.refresh.addEventListener("click", () => sendCmd({ cmd: "list" }));
ui.session.addEventListener("change", () => pushWatch(true));
ui.text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

parseHash();
setInputs(false);
setStatus("未连接");
// 配对链接（#room=…&code=…）打开即连：网关设置页给的链接就是拿来一键进入的
if (ui.room.value.trim() && ui.code.value.trim()) connect(true);
