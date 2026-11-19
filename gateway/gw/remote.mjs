// Remote bridge: the gateway connects OUT to the relay, pairs with a code and
// forwards a small command/event surface to the remote PWA.
//
// This module is deliberately separate from access.mjs: remote clients never
// touch the loopback HTTP API. The bridge calls queue/sessions/run internals
// in-process and only forwards whitelisted events.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, LIVE, log } from "./config.mjs";
import { onPublish } from "./bus.mjs";
import { enqueue, precheckChat, snapshot, abortRun } from "./queue.mjs";
import { runList, runOfSession } from "./runs.mjs";
import { findSessionFile, listSessions } from "./sessions.mjs";
import { readSessionPage } from "./transcript.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { connectWs } from "./wsclient.mjs";
import { eventSessionOf, wantsEvent } from "./remote-filter.mjs";
import { packHistory } from "./remote-history.mjs";
import * as P from "./remote-protocol.mjs";

const STATE_FILE = path.join(CFG.home, "ccapp-remote.json");
const DEFAULT_RELAY = process.env.CCAPP_REMOTE_RELAY || "wss://api.r01omzmfm.nyat.app:42965/ws";

const EVENT_WHITELIST = new Set([
  "delta", "thinking_delta", "tool_use", "tool_result", "assistant_text",
  "phase", "run_end", "error", "session_gone", "usage", "compacting", "compacted", "discard_partial",
]);

const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);

let state = loadState();
let ws = null;
let pairKey = null;
// 每个 peer 一份握手/密钥/筛选状态：中继一房间最多 4 台，各设备互不影响
// { dataKey, ecdh, watch: sessionId|null, at }
const peers = new Map();
let lastPeer = null;   // 最近完成握手的一台，只给设置页的兼容字段用
let reconnectTimer = null;
let backoff = 2000;

const SID_OK = /^[A-Za-z0-9_-]{1,80}$/;

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      enabled: !!s.enabled,
      relay: typeof s.relay === "string" && /^wss?:\/\//.test(s.relay) ? s.relay : DEFAULT_RELAY,
      room: /^[a-f0-9]{16,64}$/.test(String(s.room || "")) ? String(s.room) : "",
      code: P.normalizeCode(s.code || "").length === P.CODE_LEN ? P.normalizeCode(s.code) : "",
      createdAt: Number(s.createdAt) || 0,
    };
  } catch {
    return { enabled: false, relay: DEFAULT_RELAY, room: "", code: "", createdAt: 0 };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
  } catch (e) {
    log(`[remote] 保存状态失败: ${e.message}`);
  }
}

function relayHttpUrl(relay) {
  const u = new URL(relay);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

function pairingUrl() {
  if (!state.room || !state.code) return "";
  return `${relayHttpUrl(state.relay)}/#room=${state.room}&code=${state.code}`;
}

export function remoteStatus() {
  const ready = [...peers.entries()]
    .filter(([, p]) => p.dataKey)
    .map(([id, p]) => ({ peerId: id, at: p.at, watch: p.watch }));
  return {
    enabled: state.enabled,
    relay: state.relay,
    room: state.room,
    code: state.code,
    url: pairingUrl(),
    connected: !!ws,
    peers: ready,
    peer: lastPeer,          // 兼容：最近一台已握手设备
    createdAt: state.createdAt,
  };
}

function sessionsCompact() {
  let list = [];
  try { list = listSessions(50); } catch { list = []; }
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({
    id: s.id,
    title: clip(String(s.title || ""), 120),
    updatedAt: Number(s.mtime) || 0,
    project: s.cwd ? path.basename(String(s.cwd)) : null,
    current: !!s.currentProject,
    pinned: !!s.pinned,
  }));
}

function markLastPeer(pid) {
  if (pid) { lastPeer = pid; return; }
  const ready = [...peers.entries()].filter(([, p]) => p.dataKey).map(([id]) => id);
  lastPeer = ready.length ? ready[ready.length - 1] : null;
}

async function sendTo(pid, obj) {
  const p = peers.get(pid);
  if (!ws || !p || !p.dataKey) return;
  try {
    const text = JSON.stringify(obj);
    // 中继单帧 256 KB，密文 base64 后还要膨胀：太大就换成一句错误发出去，别让中继把整条连接断掉
    if (P.plainBytes(text) > P.MAX_PLAIN_BYTES) {
      if (obj && obj.type !== "error") await sendTo(pid, { type: "error", message: "payload too large" });
      return;
    }
    const { iv, ct } = await P.encryptText(p.dataKey, text, `${state.room}:a2c`);
    ws.send(JSON.stringify({ t: "data", peerId: pid, iv, ct }));
  } catch (e) {
    log(`[remote] 发送失败: ${e.message}`);
  }
}

/** 一页会话历史：和 /api/session/:id 一样从尾部倒读。正在生成的那一轮走事件总线实时推，
 *  这里按 startedAt 剔掉，免得手机端同一轮画两遍。cursor 是这一页最早一行的字节偏移，
 *  0 = 到头了；下次带 before=cursor 往前翻。 */
async function historyPage(sid, cmd) {
  const limit = Math.max(1, Math.min(100, parseInt(cmd.limit, 10) || 40));
  const before = cmd.before == null || cmd.before === "" ? null : Math.max(0, Number(cmd.before) || 0);
  const found = findSessionFile(sid);
  if (!found) return { type: "history", sessionId: sid, items: [], cursor: 0, missing: true };
  const live = runOfSession(sid);
  const page = await readSessionPage(found.file, {
    before, limit,
    excludeFrom: live && Number.isFinite(live.startedAt) ? live.startedAt : 0,
  });
  return {
    type: "history", sessionId: sid,
    items: packHistory(page.items),
    cursor: page.cursor,
    size: page.size,
    live: !!live,
  };
}

async function handleCommand(pid, cmd) {
  if (!cmd || typeof cmd !== "object") return;
  if (cmd.cmd === "list") return sendTo(pid, { type: "sessions", sessions: sessionsCompact() });
  if (cmd.cmd === "history") {
    const sid = cmd.sessionId == null ? "" : String(cmd.sessionId);
    if (!SID_OK.test(sid)) return sendTo(pid, { type: "error", message: "bad sessionId" });
    let reply;
    try { reply = await historyPage(sid, cmd); }
    catch (e) {
      log(`[remote] 读历史失败: ${e.message}`);
      return sendTo(pid, { type: "error", message: "history failed" });
    }
    return sendTo(pid, reply);
  }
  if (cmd.cmd === "watch") {
    const p = peers.get(pid);
    if (!p) return;
    const sid = cmd.sessionId == null || cmd.sessionId === "" ? null : String(cmd.sessionId);
    if (sid !== null && !SID_OK.test(sid)) return sendTo(pid, { type: "error", message: "bad sessionId" });
    p.watch = sid;
    log(sid ? `[remote] 设备 ${pid} 只收会话 ${sid} 的事件` : `[remote] 设备 ${pid} 收全部会话的事件`);
    return sendTo(pid, { type: "watching", sessionId: sid });
  }
  if (cmd.cmd === "send") {
    const text = String(cmd.text || "").trim();
    if (!text) return sendTo(pid, { type: "error", message: "empty message" });
    const sessionId = cmd.sessionId ? String(cmd.sessionId) : null;
    // 和 /api/chat 共用同一套校验：接口没了 / 没填 Key / 队列满 / 消息太长 / 会话号格式错都在这里挡
    const bad = precheckChat({ message: text, sessionId });
    if (bad) return sendTo(pid, { type: "error", code: bad.body.error, message: bad.body.message || bad.body.error });
    let item;
    try {
      item = enqueue({ message: text, sessionId, cid: cmd.cid ? String(cmd.cid).slice(0, 64) : null });
    } catch (e) {
      log(`[remote] 入队失败: ${e.message}`);
      return sendTo(pid, { type: "error", message: `enqueue failed: ${e.message}` });
    }
    return sendTo(pid, { type: "queued", id: item.id, sessionId: item.sessionId || null, injected: !!item.injected });
  }
  if (cmd.cmd === "stop") {
    const killed = runList().map((r) => abortRun(r)).some(Boolean);
    return sendTo(pid, { type: "stopped", killed });
  }
  if (cmd.cmd === "state") {
    const snap = snapshot();
    return sendTo(pid, { type: "state", queue: (snap.queue || []).length, runs: runList().length });
  }
  return sendTo(pid, { type: "error", message: "unknown command" });
}

function trimEvent(ev) {
  const out = { ...ev };
  if (out.type === "tool_use" && out.input !== undefined) {
    out.input = clip(typeof out.input === "string" ? out.input : JSON.stringify(out.input), 4000);
  }
  if (out.type === "tool_result" && out.content !== undefined) {
    out.content = clip(typeof out.content === "string" ? out.content : JSON.stringify(out.content), 4000);
  }
  if (out.type === "assistant_text" && out.text) out.text = clip(out.text, 8000);
  if ((out.type === "delta" || out.type === "thinking_delta") && out.text) out.text = clip(out.text, 4000);
  return out;
}

function handleRelay(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "opened") {
    backoff = 2000;
    log(`[remote] 房间已打开: ${state.room}`);
    return;
  }
  if (msg.t === "peer" && msg.event === "join") {
    const pid = String(msg.peerId || "");
    if (!pid) return;
    peers.set(pid, { dataKey: null, ecdh: null, watch: null, at: Date.now() });
    log(`[remote] 远程端已加入: ${pid}（共 ${peers.size} 台）`);
    return;
  }
  if (msg.t === "peer" && msg.event === "leave") {
    const pid = String(msg.peerId || "");
    peers.delete(pid);
    if (lastPeer === pid) markLastPeer(null);
    log(`[remote] 远程端已离开: ${pid || "?"}（剩 ${peers.size} 台）`);
    return;
  }
  if (msg.t === "hello") {
    const pid = String(msg.peerId || "");
    if (!pid) return;
    (async () => {
      const pub = String(msg.pub || "");
      const want = await P.hmacHex(pairKey, P.keyProofMessage("client", pub));
      if (want !== String(msg.mac || "")) {
        log("[remote] 配对码校验失败，拒绝该连接");
        return;
      }
      // 中继保证先发 peer join 再转发 hello；join 没到或这期间已离开就别再复活一条幽灵 peer
      const peer = peers.get(pid);
      if (!peer) return;
      const ecdh = await P.generateEcdh();
      const myPub = P.b64url(ecdh.pubRaw);
      const mac = await P.hmacHex(pairKey, P.keyProofMessage("agent", myPub));
      if (!ws) return;
      ws.send(JSON.stringify({ t: "hello", peerId: pid, pub: myPub, mac }));
      const shared = await P.deriveShared(ecdh.privateKey, P.unb64url(pub));
      const dataKey = await P.dataKeyFromShared(shared, state.room);
      if (!ws || peers.get(pid) !== peer) return;
      peer.ecdh = ecdh;
      peer.dataKey = dataKey;
      peer.at = Date.now();
      markLastPeer(pid);
      log(`[remote] 端到端加密已建立: ${pid}（共 ${peers.size} 台）`);
      await sendTo(pid, { type: "ready", sessions: sessionsCompact() });
    })().catch((e) => log(`[remote] 握手失败: ${e.message}`));
    return;
  }
  if (msg.t === "data") {
    const pid = String(msg.peerId || "");
    const peer = peers.get(pid);
    if (!peer || !peer.dataKey) return;
    (async () => {
      const text = await P.decryptText(peer.dataKey, msg.iv, msg.ct, `${state.room}:c2a`);
      let cmd;
      try { cmd = JSON.parse(text); } catch { return; }
      await handleCommand(pid, cmd);
    })().catch((e) => log(`[remote] 命令处理失败: ${e.message}`));
    return;
  }
  if (msg.t === "closed") {
    log("[remote] 房间被关闭");
    return;
  }
  if (msg.t === "error") {
    log(`[remote] 中继错误: ${msg.code || ""} ${msg.message || ""}`);
    return;
  }
}

async function connect() {
  if (!LIVE || !state.enabled || !state.room || !state.code || ws) return;
  pairKey = await P.pairKeyFromCode(state.code);
  const codeHash = await P.sha256Hex(P.normalizeCode(state.code));
  log(`[remote] 连接中继 ${state.relay}`);
  ws = connectWs(state.relay, {
    onOpen: () => {
      if (!ws) return;
      ws.send(JSON.stringify({ t: "open", room: state.room, codeHash, label: "cccroid" }));
    },
    onMessage: (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handleRelay(msg);
    },
    onClose: () => {
      if (!ws) return;
      ws = null;
      peers.clear();
      lastPeer = null;
      log("[remote] 连接断开，稍后重连");
      scheduleReconnect();
    },
    onError: (e) => log(`[remote] 连接错误: ${e.message || e}`),
  });
}

function scheduleReconnect() {
  if (!state.enabled || reconnectTimer) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((e) => log(`[remote] 重连失败: ${e.message}`));
  }, wait);
  reconnectTimer.unref?.();
}

export async function enableRemote({ relay, newCode = false } = {}) {
  if (relay && /^wss?:\/\//.test(String(relay))) state.relay = String(relay);
  if (newCode || !state.room || !state.code) {
    state.room = crypto.randomBytes(16).toString("hex");
    state.code = P.randomCode();
    state.createdAt = Date.now();
  }
  state.enabled = true;
  saveState();
  if (!ws) await connect();
  log(`[remote] 配对链接: ${pairingUrl()}`);
  return remoteStatus();
}

export function disableRemote() {
  state.enabled = false;
  saveState();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    const old = ws;
    ws = null;
    try { old.close(); } catch {}
  }
  peers.clear();
  lastPeer = null;
  log("[remote] 已停用");
  return remoteStatus();
}

export function startRemote() {
  if (!LIVE) return;
  if (!state.enabled) {
    log("[remote] 未启用（可在设置里开启远程）");
    return;
  }
  log(`[remote] 配对链接: ${pairingUrl()}`);
  connect().catch((e) => log(`[remote] 启动失败: ${e.message}`));
}

export async function routeRemote(req, res, u, p) {
  if (p === "/api/remote/status" && req.method === "GET") {
    return sendJson(res, 200, remoteStatus());
  }
  if (p === "/api/remote/enable" && req.method === "POST") {
    let b = {};
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const st = await enableRemote({ relay: b.relay, newCode: !!b.newCode });
    return sendJson(res, 200, st);
  }
  if (p === "/api/remote/disable" && req.method === "POST") {
    return sendJson(res, 200, disableRemote());
  }
  if (p === "/api/remote/reset" && req.method === "POST") {
    let b = {};
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const st = await enableRemote({ relay: b.relay, newCode: true });
    return sendJson(res, 200, st);
  }
  return NEXT;
}

// Forward a small, trimmed subset of gateway events to every paired peer that
// watches their session. A peer that picked a session only gets that session's
// events; events whose origin can't be resolved are forwarded (fail-open).
onPublish((ev) => {
  if (!ws || !peers.size || !ev || !EVENT_WHITELIST.has(ev.type)) return;
  const trimmed = trimEvent(ev);
  const sid = eventSessionOf(ev, runList());
  for (const [pid, p] of peers) {
    if (!p.dataKey || !wantsEvent(p.watch, sid)) continue;
    sendTo(pid, { type: "event", ev: trimmed }).catch(() => {});
  }
});
