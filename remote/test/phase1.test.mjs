// Phase 1 test: relay routing contract for agent -> client data.
//
// The relay routes client -> agent blindly, but an agent frame must name the peer
// (`peerId`) it is for. Phase 1 originally shipped without it: the PWA paired, showed
// "encrypted", and then never received ready/sessions/events. This test pins both halves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startRelay } from "../relay/server.mjs";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws connection failed"));
  });
}

function nextMsg(ws, pred = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", on);
      reject(new Error("timed out waiting for message"));
    }, timeout);
    function on(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!pred(msg)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", on);
      resolve(msg);
    }
    ws.addEventListener("message", on);
  });
}

test("phase1: agent data needs peerId; with it the client decrypts", async () => {
  const relay = startRelay({ port: 0, host: "127.0.0.1", log: () => {} });
  try {
    await sleep(50);
    const wsUrl = `ws://127.0.0.1:${relay.port()}/ws`;

    const code = randomCode();
    const codeHash = await sha256Hex(code);
    const room = randomBytes(16).toString("hex");
    const pairKey = await pairKeyFromCode(code);

    const agent = await openWs(wsUrl);
    const opened = nextMsg(agent, (m) => m.t === "opened" || m.t === "error");
    agent.send(JSON.stringify({ t: "open", room, codeHash, label: "phase1-agent" }));
    assert.equal((await opened).t, "opened");

    const client = await openWs(wsUrl);
    const joined = nextMsg(client, (m) => m.t === "joined" || m.t === "error");
    client.send(JSON.stringify({ t: "join", room, codeHash }));
    const joinedMsg = await joined;
    assert.equal(joinedMsg.t, "joined", JSON.stringify(joinedMsg));

    // 1) Without peerId the relay must refuse to guess: it answers the agent with no-peer.
    const denied = nextMsg(agent, (m) => m.t === "error");
    agent.send(JSON.stringify({ t: "data", iv: "AAAA", ct: "AAAA" }));
    assert.equal((await denied).code, "no-peer");

    // 2) Full handshake, then an agent -> client payload addressed by peerId arrives intact.
    const clientEcdh = await generateEcdh();
    const clientPub = b64url(clientEcdh.pubRaw);
    const clientMac = await hmacHex(pairKey, keyProofMessage("client", clientPub));
    const agentHelloPromise = nextMsg(agent, (m) => m.t === "hello");
    client.send(JSON.stringify({ t: "hello", pub: clientPub, mac: clientMac }));
    const agentHello = await agentHelloPromise;
    assert.equal(agentHello.peerId, joinedMsg.peerId);

    const agentEcdh = await generateEcdh();
    const agentPub = b64url(agentEcdh.pubRaw);
    const agentMac = await hmacHex(pairKey, keyProofMessage("agent", agentPub));
    const clientHelloPromise = nextMsg(client, (m) => m.t === "hello");
    agent.send(JSON.stringify({ t: "hello", peerId: agentHello.peerId, pub: agentPub, mac: agentMac }));
    await clientHelloPromise;

    const clientKey = await dataKeyFromShared(await deriveShared(clientEcdh.privateKey, unb64url(agentPub)), room);
    const agentKey = await dataKeyFromShared(await deriveShared(agentEcdh.privateKey, unb64url(clientPub)), room);

    const ready = JSON.stringify({ type: "ready", sessions: [{ id: "s-quant", title: "QuantLab" }] });
    const a2c = await encryptText(agentKey, ready, `${room}:a2c`);
    const gotPromise = nextMsg(client, (m) => m.t === "data");
    agent.send(JSON.stringify({ t: "data", peerId: agentHello.peerId, iv: a2c.iv, ct: a2c.ct }));
    const got = await gotPromise;
    const plain = await decryptText(clientKey, got.iv, got.ct, `${room}:a2c`);
    assert.deepEqual(JSON.parse(plain), JSON.parse(ready));

    // A frame for a peer that left is refused as well, instead of being broadcast.
    client.close();
    await sleep(100);
    const gone = nextMsg(agent, (m) => m.t === "error");
    agent.send(JSON.stringify({ t: "data", peerId: agentHello.peerId, iv: a2c.iv, ct: a2c.ct }));
    assert.equal((await gone).code, "no-peer");
  } finally {
    await relay.close();
  }
});
