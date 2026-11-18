// cccodroid remote — minimal relay.
//
// Zero dependencies: Node's http/crypto/fs only, with a small WebSocket
// implementation (text frames, ping/pong, close, fragmentation). The relay only
// routes JSON envelopes between one agent and its paired clients; it never sees
// the pairing code or any plaintext.
//
// Protocol (JSON text frames):
//   agent  -> relay  {t:"open", room, codeHash, label?}
//   client -> relay  {t:"join", room, codeHash}
//   relay  -> client {t:"joined", peerId, label?}
//   relay  -> agent  {t:"peer", event:"join", peerId, label?}
//   client/agent     {t:"hello", peerId?, pub, mac}
//   client/agent     {t:"data", peerId?, iv, ct}
//   relay  -> peer   {t:"closed"} / {t:"peer", event:"leave", peerId}
//   relay  -> both   {t:"error", code, message}

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, ".."); // remote/
const WEB = path.join(ROOT, "web");
const MAX_FRAME = 256 * 1024;
const MAX_ROOMS = 1000;
const MAX_PEERS = 4;
const PING_MS = 25_000;
const RATE_WINDOW = 10_000;
const RATE_MAX = 80;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key) {
  return crypto.createHash("sha1").update(String(key) + GUID).digest("base64");
}

function sendFrame(sock, opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  sock.write(Buffer.concat([head, payload]));
}

function sendJSON(conn, obj) {
  if (conn.closed) return;
  const data = Buffer.from(JSON.stringify(obj), "utf8");
  if (data.length > MAX_FRAME) return;
  sendFrame(conn.sock, 0x1, data);
}

function closeConn(conn, code = 1000, reason = "") {
  if (conn.closed) return;
  conn.closed = true;
  const p = Buffer.alloc(2 + Buffer.byteLength(reason));
  p.writeUInt16BE(code, 0);
  p.write(reason, 2);
  try { sendFrame(conn.sock, 0x8, p); } catch {}
  try { conn.sock.end(); } catch {}
}

function parseFrames(conn, chunk, onMessage) {
  conn.buf = Buffer.concat([conn.buf, chunk]);
  while (!conn.closed) {
    const buf = conn.buf;
    if (buf.length < 2) return;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      len = hi * 0x100000000 + lo;
      off = 10;
    }
    if (len > MAX_FRAME) {
      closeConn(conn, 1009, "frame too large");
      return;
    }
    let mask = null;
    if (masked) {
      if (buf.length < off + 4) return;
      mask = buf.subarray(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    conn.buf = buf.subarray(off + len);

    if (opcode === 0x8) {
      closeConn(conn, 1000);
      return;
    }
    if (opcode === 0x9) {
      sendFrame(conn.sock, 0xa, payload);
      continue;
    }
    if (opcode === 0xa) {
      conn.alive = true;
      continue;
    }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode !== 0x0) {
        conn.frag = [payload];
        conn.fragOpcode = opcode;
      } else {
        conn.frag.push(payload);
      }
      if (!fin) continue;
      const whole = Buffer.concat(conn.frag);
      conn.frag = [];
      if (conn.fragOpcode === 0x1 || opcode === 0x1) {
        let msg;
        try { msg = JSON.parse(whole.toString("utf8")); } catch { continue; }
        onMessage(conn, msg);
      }
    }
  }
}

function rateOk(conn) {
  const now = Date.now();
  if (now - conn.rateStart > RATE_WINDOW) {
    conn.rateStart = now;
    conn.rateCount = 0;
  }
  conn.rateCount++;
  return conn.rateCount <= RATE_MAX;
}

export function createRelay({ log = () => {} } = {}) {
  /** roomId -> { room, codeHash, agent: conn, peers: Map<peerId, conn>, createdAt, label } */
  const rooms = new Map();

  function findRoomByConn(conn) {
    for (const room of rooms.values()) {
      if (room.agent === conn) return { room, role: "agent", peerId: null };
      for (const [peerId, c] of room.peers) if (c === conn) return { room, role: "client", peerId };
    }
    return null;
  }

  function closeRoom(room) {
    for (const peer of room.peers.values()) {
      sendJSON(peer, { t: "closed" });
      closeConn(peer, 1000, "room closed");
    }
    room.peers.clear();
    if (room.agent) closeConn(room.agent, 1000, "room closed");
    rooms.delete(room.room);
    log(`room closed: ${room.room}`);
  }

  function onClose(conn) {
    const found = findRoomByConn(conn);
    if (!found) return;
    const { room, role, peerId } = found;
    if (role === "agent") {
      closeRoom(room);
    } else {
      room.peers.delete(peerId);
      sendJSON(room.agent, { t: "peer", event: "leave", peerId });
      log(`peer left: ${room.room}/${peerId}`);
    }
  }

  function handleMessage(conn, msg) {
    if (!rateOk(conn)) {
      sendJSON(conn, { t: "error", code: "rate", message: "too many messages" });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;

    if (msg.t === "open") {
      if (findRoomByConn(conn)) return sendJSON(conn, { t: "error", code: "already", message: "connection already in a room" });
      const room = String(msg.room || "").trim();
      const codeHash = String(msg.codeHash || "").trim();
      if (!/^[a-f0-9]{16,128}$/i.test(room) || !/^[a-f0-9]{64}$/i.test(codeHash)) {
        return sendJSON(conn, { t: "error", code: "bad-open", message: "room/codeHash invalid" });
      }
      if (rooms.has(room)) return sendJSON(conn, { t: "error", code: "room-taken", message: "room already open" });
      if (rooms.size >= MAX_ROOMS) return sendJSON(conn, { t: "error", code: "busy", message: "too many rooms" });
      rooms.set(room, { room, codeHash, agent: conn, peers: new Map(), createdAt: Date.now(), label: String(msg.label || "").slice(0, 64) });
      conn.room = room;
      sendJSON(conn, { t: "opened", room });
      log(`room opened: ${room}`);
      return;
    }

    if (msg.t === "join") {
      if (findRoomByConn(conn)) return sendJSON(conn, { t: "error", code: "already", message: "connection already in a room" });
      const room = rooms.get(String(msg.room || "").trim());
      if (!room) return sendJSON(conn, { t: "error", code: "no-room", message: "room not found" });
      if (String(msg.codeHash || "").toLowerCase() !== String(room.codeHash).toLowerCase()) {
        return sendJSON(conn, { t: "error", code: "bad-code", message: "pairing code mismatch" });
      }
      if (room.peers.size >= MAX_PEERS) return sendJSON(conn, { t: "error", code: "full", message: "room full" });
      const peerId = crypto.randomBytes(6).toString("hex");
      room.peers.set(peerId, conn);
      conn.room = room.room;
      conn.peerId = peerId;
      sendJSON(conn, { t: "joined", peerId, label: room.label });
      sendJSON(room.agent, { t: "peer", event: "join", peerId });
      log(`peer joined: ${room.room}/${peerId}`);
      return;
    }

    const found = findRoomByConn(conn);
    if (!found) return sendJSON(conn, { t: "error", code: "no-room", message: "not in a room" });
    const { room, role } = found;

    // Both sides send hello/data; route to the other side.
    if (msg.t === "hello" || msg.t === "data") {
      let target;
      let out = { ...msg };
      if (role === "agent") {
        const peerId = String(msg.peerId || "");
        target = room.peers.get(peerId);
        if (!target) return sendJSON(conn, { t: "error", code: "no-peer", message: "peer not found" });
        out.peerId = undefined;
      } else {
        target = room.agent;
        out.peerId = conn.peerId;
      }
      if (!target) return sendJSON(conn, { t: "error", code: "no-peer", message: "agent offline" });
      sendJSON(target, out);
      return;
    }

    sendJSON(conn, { t: "error", code: "unknown", message: `unknown type: ${msg.t}` });
  }

  function attach(socket, head) {
    const conn = {
      sock: socket,
      buf: Buffer.alloc(0),
      frag: [],
      fragOpcode: 0,
      alive: true,
      closed: false,
      rateStart: Date.now(),
      rateCount: 0,
      room: null,
      peerId: null,
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      conn.alive = true;
      parseFrames(conn, chunk, handleMessage);
    });
    socket.on("close", () => {
      conn.closed = true;
      onClose(conn);
    });
    socket.on("error", () => {
      conn.closed = true;
      onClose(conn);
    });
    if (head && head.length) parseFrames(conn, head, handleMessage);
    return conn;
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || "/", "http://relay");
    if (url.pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
    );
    attach(socket, head);
  }

  return { rooms, handleMessage, onClose, closeRoom, attach, handleUpgrade };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  });
}

export function startRelay({ port = 3010, host = "127.0.0.1", log = console.log } = {}) {
  const relay = createRelay({ log });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://relay");
    if (url.pathname === "/health") {
      const body = JSON.stringify({
        ok: true,
        rooms: relay.rooms.size,
        peers: [...relay.rooms.values()].reduce((n, r) => n + r.peers.size, 0),
        uptime: process.uptime(),
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    let rel = url.pathname === "/" ? "/index.html" : url.pathname;
    if (rel === "/protocol.mjs") return serveStatic(res, path.join(ROOT, "..", "gateway", "gw", "remote-protocol.mjs"));
    if (!/^\/[A-Za-z0-9._/-]+$/.test(rel) || rel.includes("..")) {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    serveStatic(res, path.join(WEB, rel));
  });

  server.on("upgrade", relay.handleUpgrade);

  const timer = setInterval(() => {
    for (const room of relay.rooms.values()) {
      const conns = [room.agent, ...room.peers.values()].filter(Boolean);
      for (const c of conns) {
        if (c.closed) continue;
        if (!c.alive) {
          c.closed = true;
          try { c.sock.destroy(); } catch {}
          relay.onClose(c);
          continue;
        }
        c.alive = false;
        try { sendFrame(c.sock, 0x9, Buffer.alloc(0)); } catch {}
      }
    }
  }, PING_MS);
  timer.unref();

  server.listen(port, host, () => {
    log(`relay listening on http://${host}:${server.address().port}`);
  });

  return {
    server,
    relay,
    port: () => server.address().port,
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        for (const room of [...relay.rooms.values()]) relay.closeRoom(room);
        try { server.closeAllConnections?.(); } catch {}
        server.close(() => resolve());
      }),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  startRelay({ port: Number(arg("--port", 3010)), host: arg("--host", "127.0.0.1") });
}
