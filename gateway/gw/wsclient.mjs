// Minimal WebSocket client (no deps) for the remote bridge.
// The gateway runs on a bundled Node that may predate the global WebSocket,
// so this implements the RFC 6455 client handshake and framing directly.
//
// Usage:
//   const ws = connectWs("wss://host:port/ws", { onOpen, onMessage, onClose, onError });
//   ws.send("text"); ws.close();

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 1 << 20; // 1 MiB

function encodeFrame(opcode, payload) {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export function connectWs(rawUrl, { onOpen, onMessage, onClose, onError, headers = {} } = {}) {
  const url = new URL(rawUrl);
  const isTls = url.protocol === "wss:" || url.protocol === "https:";
  const key = crypto.randomBytes(16).toString("base64");
  const expected = crypto.createHash("sha1").update(key + GUID).digest("base64");
  const port = Number(url.port || (isTls ? 443 : 80));
  const req = (isTls ? https : http).request({
    host: url.hostname,
    port,
    path: url.pathname + url.search,
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
      ...headers,
    },
  });

  let socket = null;
  let closed = false;
  let buf = Buffer.alloc(0);
  let frag = [];
  let fragOpcode = 0;
  let alive = true;
  let pingTimer = null;

  const state = {
    send(text) {
      if (closed || !socket) return false;
      try {
        socket.write(encodeFrame(0x1, Buffer.from(String(text), "utf8")));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      try {
        if (socket) {
          const p = Buffer.alloc(2);
          p.writeUInt16BE(1000, 0);
          socket.write(encodeFrame(0x8, p));
          socket.end();
        }
      } catch {}
      try { onClose && onClose(); } catch {}
    },
    get open() {
      return !!socket && !closed;
    },
  };

  req.on("upgrade", (res, sock, head) => {
    const accept = res.headers["sec-websocket-accept"];
    if (accept !== expected) {
      try { sock.destroy(); } catch {}
      try { onError && onError(new Error("bad websocket accept")); } catch {}
      return;
    }
    socket = sock;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      alive = true;
      buf = Buffer.concat([buf, chunk]);
      parse();
    });
    socket.on("close", () => {
      if (!closed) {
        closed = true;
        clearInterval(pingTimer);
        try { onClose && onClose(); } catch {}
      }
    });
    socket.on("error", (e) => {
      try { onError && onError(e); } catch {}
    });
    if (head && head.length) {
      buf = Buffer.concat([buf, head]);
      parse();
    }
    pingTimer = setInterval(() => {
      if (closed) return;
      if (!alive) {
        try { socket.destroy(); } catch {}
        return;
      }
      alive = false;
      try { socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch {}
    }, 25000);
    pingTimer.unref?.();
    try { onOpen && onOpen(); } catch {}
  });

  req.on("response", (res) => {
    try { onError && onError(new Error("upgrade refused: HTTP " + res.statusCode)); } catch {}
    try { res.resume(); } catch {}
  });
  req.on("error", (e) => {
    try { onError && onError(e); } catch {}
  });
  req.end();

  function parse() {
    while (!closed) {
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
        len = buf.readUInt32BE(2) * 0x100000000 + buf.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_FRAME) {
        state.close();
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
      buf = buf.subarray(off + len);

      if (opcode === 0x8) {
        state.close();
        return;
      }
      if (opcode === 0x9) {
        try { socket.write(encodeFrame(0xa, payload)); } catch {}
        continue;
      }
      if (opcode === 0xa) {
        alive = true;
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          frag = [payload];
          fragOpcode = opcode;
        } else {
          frag.push(payload);
        }
        if (!fin) continue;
        const whole = Buffer.concat(frag);
        frag = [];
        if (fragOpcode === 0x1 || opcode === 0x1) {
          try { onMessage && onMessage(whole.toString("utf8")); } catch {}
        }
      }
    }
  }

  return state;
}
