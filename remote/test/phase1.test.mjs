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

test("phase1: agent data needs peerId; with it the client decrypts", async () => {  const relay = startRelay({ port: 0, host: "127.0.0.1", log: () => {} });
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

// Phase 2 A/B: the relay already routes per peer; the bridge relies on the same
// contract for several devices at once. Two peers, two key pairs: client frames
// arrive stamped with the sender's peerId, agent frames go only where addressed,
// and one peer leaving doesn't disturb the other.
test("phase2: two peers route independently in one room", async () => {
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
    agent.send(JSON.stringify({ t: "open", room, codeHash, label: "phase2-agent" }));
    assert.equal((await opened).t, "opened");

    async function joinClient() {
      const ws = await openWs(wsUrl);
      const joined = nextMsg(ws, (m) => m.t === "joined" || m.t === "error");
      ws.send(JSON.stringify({ t: "join", room, codeHash }));
      const j = await joined;
      assert.equal(j.t, "joined", JSON.stringify(j));
      const ecdh = await generateEcdh();
      const pub = b64url(ecdh.pubRaw);
      const mac = await hmacHex(pairKey, keyProofMessage("client", pub));
      return { ws, peerId: j.peerId, ecdh, pub, mac };
    }

    async function handshake(c) {
      const atAgent = nextMsg(agent, (m) => m.t === "hello" && m.peerId === c.peerId);
      c.ws.send(JSON.stringify({ t: "hello", pub: c.pub, mac: c.mac }));
      await atAgent;

      const agentEcdh = await generateEcdh();
      const agentPub = b64url(agentEcdh.pubRaw);
      const agentMac = await hmacHex(pairKey, keyProofMessage("agent", agentPub));
      const atClient = nextMsg(c.ws, (m) => m.t === "hello");
      agent.send(JSON.stringify({ t: "hello", peerId: c.peerId, pub: agentPub, mac: agentMac }));
      const h = await atClient;

      c.clientKey = await dataKeyFromShared(await deriveShared(c.ecdh.privateKey, unb64url(h.pub)), room);
      c.agentKey = await dataKeyFromShared(await deriveShared(agentEcdh.privateKey, unb64url(c.pub)), room);
    }

    const joinA = nextMsg(agent, (m) => m.t === "peer" && m.event === "join");
    const A = await joinClient();
    assert.equal((await joinA).peerId, A.peerId);
    const joinB = nextMsg(agent, (m) => m.t === "peer" && m.event === "join");
    const B = await joinClient();
    assert.equal((await joinB).peerId, B.peerId);
    assert.notEqual(A.peerId, B.peerId);

    await handshake(A);
    await handshake(B);

    // client -> agent: the relay stamps the source peer, so each command can
    // be answered with the right key.
    const cmdA = JSON.stringify({ cmd: "list" });
    const encA = await encryptText(A.clientKey, cmdA, `${room}:c2a`);
    const gotA = nextMsg(agent, (m) => m.t === "data" && m.peerId === A.peerId);
    A.ws.send(JSON.stringify({ t: "data", iv: encA.iv, ct: encA.ct }));
    const atA = await gotA;
    assert.equal(await decryptText(A.agentKey, atA.iv, atA.ct, `${room}:c2a`), cmdA);

    const cmdB = JSON.stringify({ cmd: "watch", sessionId: "s-notes" });
    const encB = await encryptText(B.clientKey, cmdB, `${room}:c2a`);
    const gotB = nextMsg(agent, (m) => m.t === "data" && m.peerId === B.peerId);
    B.ws.send(JSON.stringify({ t: "data", iv: encB.iv, ct: encB.ct }));
    const atB = await gotB;
    assert.equal(await decryptText(B.agentKey, atB.iv, atB.ct, `${room}:c2a`), cmdB);

    // agent -> client: addressed frames reach their peer with that peer's key,
    // and the other peer sees nothing.
    const seenByA = [];
    const seenByB = [];
    A.ws.addEventListener("message", (ev) => { try { if (JSON.parse(ev.data).t === "data") seenByA.push(ev.data); } catch {} });
    B.ws.addEventListener("message", (ev) => { try { if (JSON.parse(ev.data).t === "data") seenByB.push(ev.data); } catch {} });

    const forB = JSON.stringify({ type: "queued", id: "q-b", sessionId: "s-notes" });
    const encForB = await encryptText(B.agentKey, forB, `${room}:a2c`);
    const bPromise = nextMsg(B.ws, (m) => m.t === "data");
    agent.send(JSON.stringify({ t: "data", peerId: B.peerId, iv: encForB.iv, ct: encForB.ct }));
    const bGot = await bPromise;
    assert.equal(await decryptText(B.clientKey, bGot.iv, bGot.ct, `${room}:a2c`), forB);
    await sleep(100);
    assert.equal(seenByA.length, 0, "peer A must not receive a frame addressed to B");

    const forA = JSON.stringify({ type: "event", ev: { type: "delta", text: "hi" } });
    const encForA = await encryptText(A.agentKey, forA, `${room}:a2c`);
    const aPromise = nextMsg(A.ws, (m) => m.t === "data");
    agent.send(JSON.stringify({ t: "data", peerId: A.peerId, iv: encForA.iv, ct: encForA.ct }));
    const aGot = await aPromise;
    assert.equal(await decryptText(A.clientKey, aGot.iv, aGot.ct, `${room}:a2c`), forA);
    assert.equal(seenByB.length, 1, "peer B only sees its own frame");

    // One device leaving leaves the other reachable.
    const leaveP = nextMsg(agent, (m) => m.t === "peer" && m.event === "leave" && m.peerId === A.peerId);
    A.ws.close();
    await leaveP;
    const goneP = nextMsg(agent, (m) => m.t === "error" && m.code === "no-peer");
    agent.send(JSON.stringify({ t: "data", peerId: A.peerId, iv: encForA.iv, ct: encForA.ct }));
    await goneP;

    const stillB = nextMsg(B.ws, (m) => m.t === "data");
    agent.send(JSON.stringify({ t: "data", peerId: B.peerId, iv: encForB.iv, ct: encForB.ct }));
    const still = await stillB;
    assert.equal(await decryptText(B.clientKey, still.iv, still.ct, `${room}:a2c`), forB);
    B.ws.close();
  } finally {
    await relay.close();
  }
});
