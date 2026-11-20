// Relay frame limits: each frame is capped at MAX_FRAME, but so must a whole (fragmented)
// message — otherwise a client streams continuation frames without FIN and the relay's
// fragment buffer grows without bound. A normal fragmented message must still assemble.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { startRelay } from "../relay/server.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function maskedFrame(opcode, payload, fin = true) {
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  let head;
  if (body.length < 126) {
    head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
  } else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, mask, body]);
}

// Minimal raw WebSocket client so the test controls fragmentation (undici's WebSocket does not).
function openRaw(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    const frames = [];
    const waiters = [];

    function pump() {
      if (!upgraded) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        buf = buf.subarray(i + 4);
        upgraded = true;
        resolve(api);
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        const len0 = buf[1] & 0x7f;
        let off = 2, len = len0;
        if (len0 === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len0 === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        frames.push({ op, payload: Buffer.from(buf.subarray(off, off + len)) });
        buf = buf.subarray(off + len);
        const w = waiters.shift();
        if (w) w();
      }
    }

    const api = {
      send: (opcode, payload, fin = true) => sock.write(maskedFrame(opcode, payload, fin)),
      text: (obj) => sock.write(maskedFrame(0x1, Buffer.from(JSON.stringify(obj)), true)),
      nextFrame: () => {
        const f = frames.shift();
        if (f) return Promise.resolve(f);
        if (closed) return Promise.resolve(null);
        return new Promise((res) => waiters.push(() => res(frames.shift() || null)));
      },
      close: () => sock.destroy(),
    };

    sock.on("error", reject);
    sock.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      sock.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
    sock.on("close", () => {
      closed = true;
      for (const w of waiters.splice(0)) w();
    });
  });
}

test("relay: fragmented messages assemble, and the total is capped at MAX_FRAME", { timeout: 10_000 }, async () => {
  const relay = startRelay({ port: 0, host: "127.0.0.1", log: () => {} });
  try {
    await sleep(50);
    const c = await openRaw(relay.port());
    try {
      c.text({ t: "open", room: randomBytes(8).toString("hex"), codeHash: randomBytes(32).toString("hex") });
      assert.equal(JSON.parse((await c.nextFrame()).payload.toString()).t, "opened");

      // Under the cap: two fragments must be joined and handled as one message.
      const json = Buffer.from(JSON.stringify({ t: "data", iv: "AAAA", ct: "AAAA" }));
      c.send(0x1, json.subarray(0, 10), false);
      c.send(0x0, json.subarray(10), true);
      const err = JSON.parse((await c.nextFrame()).payload.toString());
      assert.equal(err.t, "error");
      assert.equal(err.code, "no-peer");

      // Over the cap without FIN: 200 KB + 200 KB must close with 1009, not buffer forever.
      c.send(0x1, Buffer.alloc(200_000, 0x61), false);
      c.send(0x0, Buffer.alloc(200_000, 0x61), false);
      const closed = await c.nextFrame();
      assert.ok(closed, "relay should send a close frame");
      assert.equal(closed.op, 0x8);
      assert.equal(closed.payload.readUInt16BE(0), 1009);
    } finally {
      c.close();
    }
  } finally {
    await relay.close();
  }
});
