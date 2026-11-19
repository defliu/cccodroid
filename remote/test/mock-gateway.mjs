// Mock gateway agent for Phase 1 PWA testing.
// Implements the same wire messages as gateway/gw/remote.mjs (ready/sessions/
// queued/stopped/watching/event) without needing the Android runtime.
//
// Multi-device and session filtering are mirrored here so the PWA can be
// exercised in a browser: every peer keeps its own key and its own `watch`.
//
// Usage: node remote/test/mock-gateway.mjs [ws://127.0.0.1:3012/ws]

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  b64url,
  unb64url,
  randomCode,
  sha256Hex,
  pairKeyFromCode,
  hmacHex,
  generateEcdh,
  deriveShared,
  dataKeyFromShared,
  encryptText,
  decryptText,
  keyProofMessage,
} from "../protocol.mjs";
import { packHistory } from "../../gateway/gw/remote-history.mjs";

const wsUrl = process.argv[2] || "ws://127.0.0.1:3012/ws";
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-gateway.out");

const code = randomCode();
const room = randomBytes(16).toString("hex");
const codeHash = await sha256Hex(code);
const pairKey = await pairKeyFromCode(code);

const sessions = [
  { id: "s-quant", title: "QuantLab 日常会话", updatedAt: Date.now(), project: "QuantLab", current: true },
  { id: "s-notes", title: "笔记整理", updatedAt: Date.now() - 86400e3, project: "notes" },
];

// Phase 2 C：假历史（旧 → 新），用来在浏览器里验证「进入会话先看到最近消息」与顶部翻页。
// cursor 就是「还剩多少条更老的」——和真实桥接的字节偏移语义不同，但 0 = 到头、before 往前翻一致。
function synthHistory(sid, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = i % 17;
    if (k === 3) out.push({ role: "tool_use", id: `${sid}-t${i}`, name: "Bash", input: "{\"command\":\"npm test\"}" });
    else if (k === 4) out.push({ role: "tool_result", id: `${sid}-t${i - 1}`, ok: true, text: `ok（第 ${i + 1} 条）` });
    else if (i % 5 === 0) out.push({ role: "user", text: `[${sid}] 历史问题 #${i + 1}：构建为什么失败？` });
    else out.push({ role: "assistant", text: `[${sid}] 历史回答 #${i + 1}：构建失败是因为……（mock 历史）` });
  }
  return out;
}
const histories = new Map([
  ["s-quant", synthHistory("s-quant", 95)],
  ["s-notes", synthHistory("s-notes", 60)],
]);

let ws = null;
const peers = new Map();   // peerId → { dataKey, ecdh, watch }

async function sendTo(pid, obj) {
  const p = peers.get(pid);
  if (!ws || !p || !p.dataKey) return;
  const { iv, ct } = await encryptText(p.dataKey, JSON.stringify(obj), `${room}:a2c`);
  ws.send(JSON.stringify({ t: "data", peerId: pid, iv, ct }));
}

// 和网关同一条规则：有筛选且归属已知且不等才丢，判定不出的照发
async function evTo(pid, ev) {
  const p = peers.get(pid);
  if (!p || !p.dataKey) return;
  const sid = ev.sessionId || null;
  if (p.watch && sid && sid !== p.watch) return;
  await sendTo(pid, { type: "event", ev });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function simulateTurn(pid, sessionId, text) {
  const other = sessionId === "s-quant" ? "s-notes" : "s-quant";
  await evTo(pid, { type: "phase", phase: "text" });
  for (const piece of [`收到：`, text, "\n", "这是 mock 网关的流式回复。\n"]) {
    await evTo(pid, { type: "delta", text: piece, sessionId });
    await sleep(120);
  }
  // 另一个会话同时也在跑：选了会话的设备不该看到这段
  await evTo(pid, { type: "delta", text: `[${other}] 后台会话的输出\n`, sessionId: other });
  await evTo(pid, { type: "tool_use", name: "Bash", input: "{\"command\":\"echo hi\"}", sessionId });
  await sleep(150);
  await evTo(pid, { type: "tool_result", name: "Bash", ok: true, content: "hi", sessionId });
  await sleep(150);
  await evTo(pid, { type: "run_end", sessionId });
}

const conn = new WebSocket(wsUrl);
ws = conn;
conn.onopen = () => conn.send(JSON.stringify({ t: "open", room, codeHash, label: "mock-gateway" }));
conn.onmessage = async (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.t === "opened") {
    fs.writeFileSync(outFile, `ROOM=${room}\nCODE=${code}\n`);
    console.log(`ROOM=${room}`);
    console.log(`CODE=${code}`);
  } else if (m.t === "peer" && m.event === "join") {
    peers.set(m.peerId, { dataKey: null, ecdh: null, watch: null });
    console.log("peer joined", m.peerId, `(${peers.size})`);
  } else if (m.t === "peer" && m.event === "leave") {
    peers.delete(m.peerId);
    console.log("peer left", m.peerId, `(${peers.size})`);
  } else if (m.t === "hello") {
    const pid = m.peerId;
    if (!pid) return;
    const want = await hmacHex(pairKey, keyProofMessage("client", m.pub));
    if (want !== m.mac) return console.log("bad client proof");
    const peer = peers.get(pid) || { dataKey: null, ecdh: null, watch: null };
    peer.ecdh = await generateEcdh();
    const pub = b64url(peer.ecdh.pubRaw);
    const mac = await hmacHex(pairKey, keyProofMessage("agent", pub));
    conn.send(JSON.stringify({ t: "hello", peerId: pid, pub, mac }));
    const shared = await deriveShared(peer.ecdh.privateKey, unb64url(m.pub));
    peer.dataKey = await dataKeyFromShared(shared, room);
    peers.set(pid, peer);
    await sendTo(pid, { type: "ready", sessions });
  } else if (m.t === "data") {
    const peer = peers.get(m.peerId);
    if (!peer || !peer.dataKey) return;
    const text = await decryptText(peer.dataKey, m.iv, m.ct, `${room}:c2a`);
    let cmd;
    try { cmd = JSON.parse(text); } catch { return; }
    if (cmd.cmd === "list") await sendTo(m.peerId, { type: "sessions", sessions });
    else if (cmd.cmd === "history") {
      const sid = String(cmd.sessionId || "");
      const all = histories.get(sid);
      const limit = Math.max(1, Math.min(100, parseInt(cmd.limit, 10) || 40));
      if (!all) {
        await sendTo(m.peerId, { type: "history", sessionId: sid, items: [], cursor: 0, missing: true });
      } else {
        const end = cmd.before == null ? all.length : Math.max(0, Math.min(all.length, Number(cmd.before) || 0));
        const start = Math.max(0, end - limit);
        console.log("history", m.peerId, sid, `#${start}-${end}`);
        await sendTo(m.peerId, { type: "history", sessionId: sid, items: packHistory(all.slice(start, end)), cursor: start, size: all.length });
      }
    } else if (cmd.cmd === "watch") {
      peer.watch = cmd.sessionId || null;
      console.log("watch", m.peerId, peer.watch || "(all)");
      await sendTo(m.peerId, { type: "watching", sessionId: peer.watch });
    } else if (cmd.cmd === "send") {
      await sendTo(m.peerId, { type: "queued", id: "mock-" + Date.now(), sessionId: cmd.sessionId || null, injected: false });
      simulateTurn(m.peerId, cmd.sessionId || "s-quant", String(cmd.text || ""));
    } else if (cmd.cmd === "stop") {
      await sendTo(m.peerId, { type: "stopped", killed: true });
    }
  }
};
setInterval(() => {}, 1 << 30);
