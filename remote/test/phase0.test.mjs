// Phase 0 test: relay + pairing + E2E round-trip, all in Node.
// Run: node --test remote/test/phase0.test.mjs

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

async function makeAgent(wsUrl, room, codeHash, label) {
  const ws = await openWs(wsUrl);
  const opened = nextMsg(ws, (m) => m.t === "opened" || m.t === "error");
  ws.send(JSON.stringify({ t: "open", room, codeHash, label }));
  const res = await opened;
  assert.equal(res.t, "opened");
  return ws;
}

async function makeClient(wsUrl, room, code, codeHash) {
  const ws = await openWs(wsUrl);
  const joined = nextMsg(ws, (m) => m.t === "joined" || m.t === "error");
  ws.send(JSON.stringify({ t: "join", room, codeHash }));
  const res = await joined;
  assert.equal(res.t, "joined", JSON.stringify(res));
  return { ws, peerId: res.peerId, code };
}

test("phase0: pairing, key exchange, encrypted round-trip", async () => {
  const relay = startRelay({ port: 0, host: "127.0.0.1", log: () => {} });
  try {
    await sleep(50);
    const wsUrl = `ws://127.0.0.1:${relay.port()}/ws`;

    const code = randomCode();
    const codeHash = await sha256Hex(code);
    const room = randomBytes(16).toString("hex");
    const pairKey = await pairKeyFromCode(code);

  const agent = await makeAgent(wsUrl, room, codeHash, "phase0-agent");
  // Register before the client joins: the relay notifies the agent immediately.
  const joinNoticePromise = nextMsg(agent, (m) => m.t === "peer" && m.event === "join");
  const client = await makeClient(wsUrl, room, code, codeHash);

  // Client hello
  const clientEcdh = await generateEcdh();
  const clientPub = b64url(clientEcdh.pubRaw);
  const clientMac = await hmacHex(pairKey, keyProofMessage("client", clientPub));

  // Agent sees peer join first
  const joinNotice = await joinNoticePromise;
  assert.equal(joinNotice.peerId, client.peerId);

  const agentHelloPromise = nextMsg(agent, (m) => m.t === "hello");
  client.ws.send(JSON.stringify({ t: "hello", pub: clientPub, mac: clientMac }));
  const agentHello = await agentHelloPromise;
  assert.equal(agentHello.peerId, client.peerId);
  const wantClient = await hmacHex(pairKey, keyProofMessage("client", agentHello.pub));
  assert.equal(wantClient, agentHello.mac);

  const agentEcdh = await generateEcdh();
  const agentPub = b64url(agentEcdh.pubRaw);
  const agentMac = await hmacHex(pairKey, keyProofMessage("agent", agentPub));

  const clientHelloPromise = nextMsg(client.ws, (m) => m.t === "hello");
  agent.send(JSON.stringify({ t: "hello", peerId: client.peerId, pub: agentPub, mac: agentMac }));
  const clientHello = await clientHelloPromise;
  assert.equal(clientHello.pub, agentPub);

  // keys
  const clientShared = await deriveShared(clientEcdh.privateKey, unb64url(agentPub));
  const agentShared = await deriveShared(agentEcdh.privateKey, unb64url(clientPub));
  const clientKey = await dataKeyFromShared(clientShared, room);
  const agentKey = await dataKeyFromShared(agentShared, room);

  // client -> agent
  const toAgent = JSON.stringify({ type: "text", text: "hello from client" });
  const c2a = await encryptText(clientKey, toAgent, `${room}:c2a`);
  const agentDataPromise = nextMsg(agent, (m) => m.t === "data");
  client.ws.send(JSON.stringify({ t: "data", iv: c2a.iv, ct: c2a.ct }));
  const gotByAgent = await agentDataPromise;
  assert.equal(gotByAgent.peerId, client.peerId);
  const plainAgent = await decryptText(agentKey, gotByAgent.iv, gotByAgent.ct, `${room}:c2a`);
  assert.equal(plainAgent, toAgent);

  // agent -> client
  const toClient = JSON.stringify({ type: "text", text: "reply from agent" });
  const a2c = await encryptText(agentKey, toClient, `${room}:a2c`);
  const clientDataPromise = nextMsg(client.ws, (m) => m.t === "data");
  agent.send(JSON.stringify({ t: "data", peerId: client.peerId, iv: a2c.iv, ct: a2c.ct }));
  const gotByClient = await clientDataPromise;
  const plainClient = await decryptText(clientKey, gotByClient.iv, gotByClient.ct, `${room}:a2c`);
  assert.equal(plainClient, toClient);

  // Wrong code is rejected
  const bad = await openWs(wsUrl);
  const badRes = nextMsg(bad, (m) => m.t === "error" || m.t === "joined");
  bad.send(JSON.stringify({ t: "join", room, codeHash: await sha256Hex(randomCode()) }));
  const badMsg = await badRes;
  assert.equal(badMsg.t, "error");
  assert.equal(badMsg.code, "bad-code");

  // Peer leave is announced
  const leavePromise = nextMsg(agent, (m) => m.t === "peer" && m.event === "leave");
  client.ws.close();
  const leave = await leavePromise;
  assert.equal(leave.peerId, client.peerId);

  agent.close();
  bad.close();
  } finally {
    await relay.close();
  }
});
