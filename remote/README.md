# cccodroid remote (Phase 0)

Outbound, end-to-end-encrypted remote channel for cccodroid. The phone-side
gateway will connect **out** to this relay (Phase 1); remote clients (PWA) pair
with a code and exchange AES-GCM messages. The relay only forwards opaque
ciphertext — it never sees the pairing code or any plaintext.

```
gateway (phone) ──WSS──▶ relay (this dir) ◀──WSS── PWA / browser
```

## What is here

| Path | Purpose |
|---|---|
| `protocol.mjs` | Shared crypto/pairing helpers (Node + browser, no deps) |
| `relay/server.mjs` | Minimal relay: HTTP static + WebSocket + rooms (zero deps) |
| `web/` | Phase 0 PWA: join, handshake, send/receive |
| `test/phase0.test.mjs` | Relay + pairing + E2E round-trip test |
| `test/demo-agent.mjs` | Manual demo agent (opens a room, echoes messages) |

## Run

```bash
# relay (port 3010, loopback)
node remote/relay/server.mjs --port 3010 --host 127.0.0.1

# test
node --test remote/test/phase0.test.mjs

# demo agent for the PWA
node remote/test/demo-agent.mjs ws://127.0.0.1:3010/ws
# -> prints ROOM=… CODE=…
# open http://127.0.0.1:3010/ and pair with those values
```

## Pairing and crypto

1. Agent creates a room with `sha256(pairCode)`; the relay stores only the hash.
2. Client sends `join` with the same hash.
3. Both derive `pairKey = HKDF(pairCode, "pair-key")` and authenticate their
   ephemeral P-256 public keys with `HMAC(pairKey, "client:<pub>")` /
   `"agent:<pub>"`. The relay cannot forge these (it only knows the hash).
4. `ECDH(P-256) -> HKDF(roomId) -> AES-256-GCM`. AAD binds `roomId` and
   direction (`c2a` / `a2c`), so ciphertext cannot be replayed across rooms or
   directions.
5. The relay routes `hello` / `data` envelopes and never decrypts them.

## Wire protocol (JSON text frames)

```
agent  → relay  {t:"open", room, codeHash, label?}
client → relay  {t:"join", room, codeHash}
relay  → client {t:"joined", peerId, label?}
relay  → agent  {t:"peer", event:"join"|"leave", peerId}
client/agent    {t:"hello", peerId?, pub, mac}
client/agent    {t:"data",  peerId?, iv, ct}
relay  → peer   {t:"closed"}
relay  → both   {t:"error", code, message}
```

## Public endpoint (SakuraFrp)

The relay is exposed through a second free SakuraFrp tunnel:

```
https://api.r01omzmfm.nyat.app:42965/health
```

- tunnel id `29898220` (name `ccc_remote`, node #33)
- subdomain binding `api` → tunnel (CNAME on `r01omzmfm.nyat.app`)
- `auto_https = auto` — frpc terminates TLS with the ZeroSSL cert for
  `*.r01omzmfm.nyat.app` and forwards to `127.0.0.1:3010`

Start the tunnel client (token is the SakuraFrp access key; keep it out of the repo):

```bash
frpc -f <访问密钥>:29898220
```

## Security notes (Phase 0)

- Relay keeps no state on disk; rooms disappear when the agent disconnects.
- Limits: 256 KB frames, 80 msgs/10 s per socket, 4 peers/room, 1000 rooms.
- The public endpoint is HTTPS with a valid cert; WebSocket uses WSS.
- Phase 1 will add: device revocation, session list/chat mapping, reconnect
  semantics, and the gateway-side `gw/remote.mjs` bridge.
