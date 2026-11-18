// Demo agent for manual PWA testing.
// Opens a room on the relay, prints ROOM/CODE, completes the E2E handshake and
// echoes any text it receives.
//
// Usage: node remote/test/demo-agent.mjs [ws://127.0.0.1:3012/ws]

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
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "demo-agent.out");

const code = randomCode();
const room = randomBytes(16).toString("hex");
const codeHash = await sha256Hex(code);
const pairKey = await pairKeyFromCode(code);

let ecdh = null;
let dataKey = null;
let peerId = null;

const ws = new WebSocket(wsUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({ t: "open", room, codeHash, label: "demo-agent" }));
};
ws.onmessage = async (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.t === "opened") {
    fs.writeFileSync(outFile, `ROOM=${room}\nCODE=${code}\n`);
    console.log(`ROOM=${room}`);
    console.log(`CODE=${code}`);
  } else if (m.t === "peer" && m.event === "join") {
    peerId = m.peerId;
    console.log(`peer joined: ${peerId}`);
  } else if (m.t === "hello") {
    const want = await hmacHex(pairKey, keyProofMessage("client", m.pub));
    if (want !== m.mac) {
      console.log("bad client key proof");
      return;
    }
    ecdh = await generateEcdh();
    const pub = b64url(ecdh.pubRaw);
    const mac = await hmacHex(pairKey, keyProofMessage("agent", pub));
    ws.send(JSON.stringify({ t: "hello", peerId: m.peerId, pub, mac }));
    const shared = await deriveShared(ecdh.privateKey, unb64url(m.pub));
    dataKey = await dataKeyFromShared(shared, room);
    peerId = m.peerId;
    console.log("handshake complete");
  } else if (m.t === "data") {
    if (!dataKey) return;
    const text = await decryptText(dataKey, m.iv, m.ct, `${room}:c2a`);
    console.log("client says:", text);
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { text: String(text) }; }
    const reply = JSON.stringify({ type: "text", text: `echo: ${payload.text ?? ""}`, at: Date.now() });
    const { iv, ct } = await encryptText(dataKey, reply, `${room}:a2c`);
    ws.send(JSON.stringify({ t: "data", peerId, iv, ct }));
  } else if (m.t === "peer" && m.event === "leave") {
    console.log("peer left");
  } else if (m.t === "error") {
    console.log("relay error:", m.code, m.message);
  }
};
ws.onclose = () => console.log("relay closed");
setInterval(() => {}, 1 << 30);
