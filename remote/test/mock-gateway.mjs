// Mock gateway agent for Phase 1 PWA testing.
// Implements the same wire messages as gateway/gw/remote.mjs (ready/sessions/
// queued/stopped/event) without needing the Android runtime.
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

let ws = null;
let dataKey = null;
let ecdh = null;
let peerId = null;

async function sendData(obj) {
  if (!dataKey) return;
  const { iv, ct } = await encryptText(dataKey, JSON.stringify(obj), `${room}:a2c`);
  ws.send(JSON.stringify({ t: "data", peerId, iv, ct }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function simulateTurn(text) {
  await sendData({ type: "event", ev: { type: "phase", phase: "text" } });
  for (const piece of [`收到：`, text, "\n", "这是 mock 网关的流式回复。\n"]) {
    await sendData({ type: "event", ev: { type: "delta", text: piece } });
    await sleep(120);
  }
  await sendData({ type: "event", ev: { type: "tool_use", name: "Bash", input: "{\"command\":\"echo hi\"}" } });
  await sleep(150);
  await sendData({ type: "event", ev: { type: "tool_result", name: "Bash", ok: true, content: "hi" } });
  await sleep(150);
  await sendData({ type: "event", ev: { type: "run_end", sessionId: "s-quant" } });
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
    peerId = m.peerId;
    console.log("peer joined", peerId);
  } else if (m.t === "hello") {
    const want = await hmacHex(pairKey, keyProofMessage("client", m.pub));
    if (want !== m.mac) return console.log("bad client proof");
    ecdh = await generateEcdh();
    const pub = b64url(ecdh.pubRaw);
    const mac = await hmacHex(pairKey, keyProofMessage("agent", pub));
    conn.send(JSON.stringify({ t: "hello", peerId: m.peerId, pub, mac }));
    const shared = await deriveShared(ecdh.privateKey, unb64url(m.pub));
    dataKey = await dataKeyFromShared(shared, room);
    peerId = m.peerId;
    await sendData({ type: "ready", sessions });
  } else if (m.t === "data") {
    if (!dataKey) return;
    const text = await decryptText(dataKey, m.iv, m.ct, `${room}:c2a`);
    let cmd;
    try { cmd = JSON.parse(text); } catch { return; }
    if (cmd.cmd === "list") await sendData({ type: "sessions", sessions });
    else if (cmd.cmd === "send") {
      await sendData({ type: "queued", id: "mock-" + Date.now(), sessionId: cmd.sessionId || null, injected: false });
      simulateTurn(String(cmd.text || ""));
    } else if (cmd.cmd === "stop") {
      await sendData({ type: "stopped", killed: true });
    }
  }
};
setInterval(() => {}, 1 << 30);
