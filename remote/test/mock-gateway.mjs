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

// ── Phase 2 D：权限卡 ──────────────────────────────────────────────
// 发「perm」触发一张待答的卡片；发「perm timeout」触发一张 1.5 秒后超时的卡片。
const pendingPerms = new Map();   // id → { sessionId, card }
let permN = 0;

async function askPerm(pid, sessionId, { expires = false } = {}) {
  const id = "mock-perm-" + (++permN);
  const card = {
    type: "perm_request", id, tool: "Bash",
    input: { command: "npm run build && rm -rf .cache", description: "构建并清理缓存" },
    sessionId, runId: "mock-run", at: Date.now(),
    rules: ["Bash(npm run build:*)"], canAlways: true,
  };
  pendingPerms.set(id, { sessionId, card });
  await evTo(pid, card);
  if (expires) {
    setTimeout(() => {
      if (!pendingPerms.delete(id)) return;
      evTo(pid, { type: "perm_resolved", id, behavior: "deny", expired: true, sessionId }).catch(() => {});
    }, 1500);
  }
}

// ── Phase 2 E：假文件系统 ──────────────────────────────────────────
// 1×1 PNG，用来验证 blob 分片 + 图片预览
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const vfs = new Map([
  ["/work", { dir: true }],
  ["/work/README.md", { text: "# Mock 工作区\n\n这是 mock 网关给出的假文件。\n\n" + "- 示例条目\n".repeat(40) }],
  ["/work/src", { dir: true }],
  ["/work/src/app.js", { text: "export const hello = 'mock';\n".repeat(4000) }],
  ["/work/notes.txt", { text: "笔记\n".repeat(10) }],
  ["/work/logo.png", { b64: PNG_B64 }],
  ["/projects", { dir: true }],
  ["/projects/s-quant", { dir: true }],
  ["/projects/s-quant/session.jsonl", { text: "{\"type\":\"user\",\"message\":\"mock\"}\n".repeat(20) }],
]);
const ROOTS = [{ name: "工作区（mock）", path: "/work" }, { name: "项目记录（mock）", path: "/projects" }];

function vfsSize(v) {
  if (!v) return 0;
  if (v.text != null) return Buffer.byteLength(v.text, "utf8");
  if (v.b64) return Buffer.from(v.b64, "base64").length;
  return 0;
}

function vfsEntries(dir) {
  const prefix = dir.replace(/\/+$/, "") + "/";
  const out = new Map();
  for (const [k, v] of vfs) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    if (!rest) continue;
    const name = rest.split("/")[0];
    const isDir = rest.includes("/") || !!v.dir;
    out.set(name, {
      name, dir: isDir, size: isDir ? 0 : vfsSize(v), mtime: 0,
      kind: isDir ? "dir" : name.endsWith(".png") ? "image" : "text",
    });
  }
  return [...out.values()].sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}

const mockRead = async (pid, cmd) => {
  const file = String(cmd.path || "");
  const v = vfs.get(file);
  if (!v || v.dir) return sendTo(pid, { type: "read", path: file, error: "not found" });
  if (v.b64) return sendTo(pid, { type: "read", path: file, binary: true, size: vfsSize(v), offset: 0, mime: "image/png", kind: "image" });
  const buf = Buffer.from(v.text || "", "utf8");
  const off = Math.max(0, Math.min(buf.length, Number(cmd.offset) || 0));
  const n = Math.min(48000, buf.length - off);
  return sendTo(pid, {
    type: "read", path: file, data: buf.subarray(off, off + n).toString("utf8"),
    size: buf.length, offset: off, next: off + n, eof: off + n >= buf.length, mime: "text/plain",
  });
};

const mockBlob = async (pid, cmd) => {
  const file = String(cmd.path || "");
  const v = vfs.get(file);
  if (!v || v.dir) return sendTo(pid, { type: "blob", path: file, error: "not found" });
  if (!v.b64) return sendTo(pid, { type: "blob", path: file, error: "not a binary file" });
  const buf = Buffer.from(v.b64, "base64");
  const off = Math.max(0, Math.min(buf.length, Number(cmd.offset) || 0));
  const n = Math.min(90000, buf.length - off);
  return sendTo(pid, {
    type: "blob", path: file, mime: "image/png", size: buf.length, offset: off,
    next: off + n < buf.length ? off + n : null, chunk: buf.subarray(off, off + n).toString("base64"),
  });
};

const mockLs = async (pid, cmd) => {
  const raw = cmd.path == null || cmd.path === "" ? "/work" : String(cmd.path);
  const dir = raw.replace(/\/+$/, "") || "/";
  const ok = dir === "/work" || dir === "/projects" || dir.startsWith("/work/") || dir.startsWith("/projects/");
  if (!ok) return sendTo(pid, { type: "ls", path: "", entries: [], roots: ROOTS, error: "forbidden" });
  const v = vfs.get(dir);
  if (!v || !v.dir) return sendTo(pid, { type: "ls", path: dir, entries: [], roots: ROOTS, error: "not found" });
  const parent = dir === "/work" || dir === "/projects" ? null : dir.replace(/\/[^/]+$/, "");
  return sendTo(pid, { type: "ls", path: dir, parent, roots: ROOTS, entries: vfsEntries(dir), truncated: false });
};

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
      const items = [...pendingPerms.values()]
        .filter((x) => !peer.watch || !x.sessionId || x.sessionId === peer.watch)
        .map((x) => x.card);
      await sendTo(m.peerId, { type: "perms", items });
    } else if (cmd.cmd === "perm") {
      const id = String(cmd.id || "");
      const ent = pendingPerms.get(id);
      if (!ent) {
        await sendTo(m.peerId, { type: "perm_ack", id, ok: false, gone: true });
      } else {
        pendingPerms.delete(id);
        console.log("perm", m.peerId, id, cmd.behavior, cmd.always ? "(always)" : "", cmd.interrupt ? "(interrupt)" : "");
        await sendTo(m.peerId, { type: "perm_ack", id, ok: true });
        await evTo(m.peerId, {
          type: "perm_resolved", id, behavior: cmd.behavior === "allow" ? "allow" : "deny",
          ...(cmd.always ? { always: true } : {}), ...(cmd.interrupt ? { interrupt: true } : {}),
          sessionId: ent.sessionId,
        });
      }
    } else if (cmd.cmd === "ls") {
      await mockLs(m.peerId, cmd);
    } else if (cmd.cmd === "read") {
      await mockRead(m.peerId, cmd);
    } else if (cmd.cmd === "blob") {
      await mockBlob(m.peerId, cmd);
    } else if (cmd.cmd === "send") {
      await sendTo(m.peerId, { type: "queued", id: "mock-" + Date.now(), sessionId: cmd.sessionId || null, injected: false });
      const text = String(cmd.text || "");
      // Phase 2 D：发「perm」出一张权限卡，「perm timeout」测超时呈现；其余走正常的流式回复
      if (/perm/i.test(text)) await askPerm(m.peerId, cmd.sessionId || "s-quant", { expires: /timeout/i.test(text) });
      else await simulateTurn(m.peerId, cmd.sessionId || "s-quant", text);
    } else if (cmd.cmd === "stop") {
      await sendTo(m.peerId, { type: "stopped", killed: true });
    }
  }
};
setInterval(() => {}, 1 << 30);
