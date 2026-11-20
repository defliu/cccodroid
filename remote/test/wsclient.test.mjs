// Tests the zero-dependency WebSocket client used by the gateway bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startRelay } from "../relay/server.mjs";
import { connectWs } from "../../gateway/gw/wsclient.mjs";
import { sha256Hex, randomCode } from "../protocol.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("wsclient: handshake, text frames and close", async () => {
  const relay = startRelay({ port: 0, host: "127.0.0.1", log: () => {} });
  try {
    await sleep(50);
    const url = `ws://127.0.0.1:${relay.port()}/ws`;
    const code = randomCode();
    const codeHash = await sha256Hex(code);
    const room = randomBytes(16).toString("hex");

    const messages = [];
    let closed = false;
    const ws = connectWs(url, {
      onMessage: (raw) => messages.push(JSON.parse(raw)),
      onClose: () => { closed = true; },
      onError: () => {},
    });

    for (let i = 0; i < 50 && !ws.open; i++) await sleep(20);
    assert.equal(ws.open, true, "socket should be open");

    ws.send(JSON.stringify({ t: "open", room, codeHash, label: "test" }));
    for (let i = 0; i < 50 && !messages.some((m) => m.t === "opened"); i++) await sleep(20);
    assert.ok(messages.some((m) => m.t === "opened" && m.room === room));

    ws.close();
    for (let i = 0; i < 50 && !closed; i++) await sleep(20);
    assert.equal(closed, true, "onClose should fire");
  } finally {
    await relay.close();
  }
});
