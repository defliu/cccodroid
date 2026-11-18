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
  retry: null,
  sessions: [],
};

function setStatus(text, kind) {
  ui.state.textContent = text;
  ui.dot.className = "dot" + (kind ? " " + kind : "");
}

function logLine(text, cls = "sys") {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.textContent = text;
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
  if (prev && [...ui.session.options].some((o) => o.value === prev)) ui.session.value = prev;
  else {
    const cur = state.sessions.find((s) => s.current);
    if (cur) ui.session.value = cur.id;
  }
}

async function sendCmd(obj) {
  if (!state.connected || !state.dataKey) return;
  const payload = JSON.stringify(obj);
  const { iv, ct } = await encryptText(state.dataKey, payload, `${state.room}:c2a`);
  state.ws.send(JSON.stringify({ t: "data", iv, ct }));
}

async function connect() {
  if (state.ws) return;
  state.manualClose = false;
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
        setStatus("已加密连接", "ok");
        setInputs(true);
        ui.connect.disabled = true;
        ui.disconnect.disabled = false;
        ui.room.disabled = true;
        ui.code.disabled = true;
        logLine("通道已建立（端到端加密）", "sys");
        await sendCmd({ cmd: "list" });
      } else if (msg.t === "data") {
        if (!state.dataKey) return;
        const text = await decryptText(state.dataKey, msg.iv, msg.ct, `${state.room}:a2c`);
        let payload;
        try { payload = JSON.parse(text); } catch { payload = { type: "text", text }; }
        handlePayload(payload);
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
    setInputs(false);
    ui.connect.disabled = false;
    ui.disconnect.disabled = true;
    ui.room.disabled = false;
    ui.code.disabled = false;
    if (state.manualClose) {
      setStatus("已断开");
      return;
    }
    setStatus("连接断开，2 秒后重连…", "bad");
    clearTimeout(state.retry);
    state.retry = setTimeout(() => { if (!state.manualClose) connect(); }, 2000);
  };

  ws.onerror = () => setStatus("连接失败", "bad");
}

function handlePayload(p) {
  if (!p || typeof p !== "object") return;
  switch (p.type) {
    case "ready":
      renderSessions(p.sessions, false);
      logLine(`已连接网关（${(p.sessions || []).length} 个会话）`, "sys");
      break;
    case "sessions":
      renderSessions(p.sessions, true);
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
  await sendCmd({ cmd: "send", text, sessionId, cid: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  logLine(text, "me");
  ui.text.value = "";
  streamEl = null;
}

function disconnect() {
  state.manualClose = true;
  clearTimeout(state.retry);
  if (state.ws) state.ws.close();
}

ui.connect.addEventListener("click", () => { connect(); });
ui.disconnect.addEventListener("click", disconnect);
ui.send.addEventListener("click", send);
ui.stop.addEventListener("click", () => sendCmd({ cmd: "stop" }));
ui.refresh.addEventListener("click", () => sendCmd({ cmd: "list" }));
ui.text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

parseHash();
setInputs(false);
setStatus("未连接");
