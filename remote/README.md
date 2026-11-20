# cccodroid remote (Phase 1 + Phase 2 A/B/C/D/E)

Outbound, end-to-end-encrypted remote control for cccodroid. The phone-side
gateway dials **out** to the relay; a remote device (PWA in a browser) pairs with
a code and drives sessions — list, chat, stop — over the encrypted channel. The
relay only forwards opaque ciphertext; it never sees the pairing code or any
plaintext.

```
phone gateway (gw/remote.mjs) ──WSS──▶ relay (remote/relay) ◀──WSS── PWA (remote/web)
```

## What is here

| Path | Purpose |
|---|---|
| `protocol.mjs` | Shared crypto/pairing helpers (Node + browser, no deps) |
| `relay/server.mjs` | Minimal relay: HTTP static + WebSocket + rooms (zero deps) |
| `web/` | Remote PWA: pair, session list, chat stream, stop, auto-reconnect |
| `test/phase0.test.mjs` | Relay + pairing + E2E round-trip test |
| `test/phase1.test.mjs` | Relay routing contract: agent frames must carry `peerId`; two peers route independently |
| `test/filter.test.mjs` | Event → session attribution and fail-open `watch` filtering |
| `test/history.test.mjs` | History payload shaping: field whitelist, per-item caps, page budget |
| `test/perm.test.mjs` | Permission-card shaping and answer validation (Phase 2 D) |
| `test/files.test.mjs` | Remote file policy: roots, traversal, secrets, read/blob limits (Phase 2 E) |
| `test/relay-limits.test.mjs` | Frame/message size caps (fragmented stream closes with 1009) |
| `test/mock-gateway.mjs` | Mock gateway bridge (multi-peer + `watch`) for browser-side integration testing |
| `test/demo-agent.mjs` | Manual demo agent (opens a room, echoes messages) |
| `phase1-test-report.md` | 9.1 联调记录（缺陷、清单结果、遗留项） |
| `phase2-acceptance.md` | Phase 2 A/B/C/D/E 验收记录：测试、mock 过滤、双设备联调、真机清单 |

Gateway side (not in this dir):

| Path | Purpose |
|---|---|
| `gateway/gw/remote.mjs` | Bridge: dials the relay, per-device handshake, command/event routing |
| `gateway/gw/remote-filter.mjs` | Pure helpers: event → session attribution, `watch` matching |
| `gateway/gw/remote-history.mjs` | History payload shaping (whitelist, caps, page budget) |
| `gateway/gw/remote-perm.mjs` | Permission-card shaping and remote-answer validation (D) |
| `gateway/gw/remote-files.mjs` | File roots / containment / read / blob helpers (E) |
| `gateway/gw/remote-protocol.mjs` | Node copy of `protocol.mjs` + `MAX_PLAIN_BYTES` |
| `gateway/web/app/10c-remote.js` | Settings → 远程控制 page (toggle, pairing link, status) |
| `/api/remote/status`, `/api/remote/enable`, `/api/remote/disable`, `/api/remote/reset` | Settings API |

## Run

```bash
# relay (port 3010, loopback)
node remote/relay/server.mjs --port 3010 --host 127.0.0.1

# tests (gateway + remote control; the apk CI workflow runs this)
node scripts/test.mjs

# remote control only
node --test remote/test/phase0.test.mjs remote/test/phase1.test.mjs remote/test/wsclient.test.mjs remote/test/relay-limits.test.mjs remote/test/filter.test.mjs remote/test/history.test.mjs remote/test/perm.test.mjs remote/test/files.test.mjs

# mock gateway for the PWA (prints ROOM=… CODE=… each start)
node remote/test/mock-gateway.mjs ws://127.0.0.1:3010/ws
# open http://127.0.0.1:3010/ and pair — or append #room=…&code=… to auto-connect
```

On the phone, the same thing is done from **设置 → 远程控制**: enable, then copy
the pairing link (`…/#room=…&code=…`) to the other device. The link carries the
code — treat it as a credential.

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
relay  → agent  {t:"opened"}
relay  → client {t:"joined", peerId, label?}
relay  → agent  {t:"peer", event:"join"|"leave", peerId}
client/agent    {t:"hello", peerId?, pub, mac}
client/agent    {t:"data",  peerId?, iv, ct}
relay  → peer   {t:"closed"}
relay  → both   {t:"error", code, message}
```

Routing rules (`relay/server.mjs`):

- client → agent: forwarded blindly to the room's agent, the relay stamps the
  sender's `peerId` so the agent knows which remote it came from.
- agent → client: **the agent must set `peerId`**. The relay looks the peer up;
  a missing or unknown `peerId` gets `{t:"error",code:"no-peer"}` and the frame
  is dropped. Phase 1 originally missed this on both the bridge and the mock
  gateway — the PWA paired, showed "encrypted", and never received anything.
  `test/phase1.test.mjs` pins both halves of the contract.

Size limit: the relay closes a socket with 1009 above 256 KB per frame. Base64url
ciphertext inflates ~4/3, so both ends cap plaintext at `MAX_PLAIN_BYTES`
(180 000 bytes, `remote-protocol.mjs`): the PWA refuses to send and keeps the
text in the box; the bridge replaces an oversized payload with an `error` frame
instead of losing the whole connection.

## Encrypted payloads

Direction `c2a`: `{cmd:"send"|"stop"|"list"|"state"|"watch"|"history"|"perm"|
"ls"|"read"|"blob", …}`; direction `a2c`: `{type:"ready"|"sessions"|"queued"|
"watching"|"history"|"perms"|"perm_ack"|"ls"|"read"|"blob"|"delta"|"tool_use"|
"tool_result"|"run_end"|"stopped"|"state"|"event"|"error", …}` — `ready` right
after handshake, `event` wraps whitelisted bus events (`assistant_text`,
`thinking_delta`, `perm_request`, …). The bridge reuses `precheckChat()` from
`gw/queue.mjs`, so remote sends hit the same provider / key / queue / length /
session-id checks as `POST /api/chat`.

### Per-session event filtering (Phase 2 A)

Each device sends `{cmd:"watch", sessionId}` — the selected session, or `null`
for "new session / no filter". The bridge acks with `{type:"watching",
sessionId}` and then forwards only events that belong to that session.

Attribution (`gw/remote-filter.mjs`): `ev.sessionId` → `session_gone`'s `ev.id`
→ `runList()` lookup by `ev.runId` (events mid-run only carry `runId`). The rule
is **fail-open**: when the device has a filter and the event's origin is known
but different, the event is dropped; unknown origins are still forwarded. A new
session has no session id until its run reports `init`, so strict filtering
would hide the turn the user just started.

### Multiple devices (Phase 2 B)

The relay allows 4 peers per room; the bridge keeps one entry per peer
(`peerId → {dataKey, ecdh, watch, at}`), so every device has its own handshake,
key and filter. Command replies go only to the device that asked; bus events are
encrypted separately for each watching device. `GET /api/remote/status` reports
`peers: [{peerId, at, watch}]` (plus `peer` as the most recent one, kept for the
settings page). All devices share the room's pairing code and therefore the same
permissions; per-device pairing/revocation is not implemented yet.

### History replay (Phase 2 C)

Selecting a session asks for its most recent page: `{cmd:"history", sessionId,
before?, limit?}` → `{type:"history", sessionId, items, cursor, size, live?,
missing?}`. `limit` defaults to 40 (max 100); `cursor` is the byte offset of the
oldest line in the page, `0` means the beginning — the PWA's "加载更早" button
sends `before=cursor` to page backwards. Pages are read with the same tail-first
reader as `/api/session/:id`; the currently generating run is skipped
(`startedAt`) because its events already stream live.

Items are a whitelist, not raw transcript rows: `user` / `assistant` text,
compact `note`s, `tool_use` (name + input as a clipped JSON string) and
`tool_result` (id, ok, text). `thinking` and hook context are not sent. Text is
capped at 8 KB (4 KB for tool payloads) and the whole page is packed under
120 KB, so it stays inside the 180 KB plaintext / 256 KB frame limits. A session
that no longer exists answers `missing: true` instead of an error.

### Permission cards (Phase 2 D)

`perm_request` / `perm_resolved` are whitelisted events. Each card is reshaped by
`gw/remote-perm.mjs` before it leaves the phone: only `{id, tool, input, at,
runId, sessionId, guard, blockedPath, reason, description, rules, canAlways, …}`
survive, with a per-tool clip table for the input (Bash command 2 KB, Edit
old/new 1.5 KB, Write content 2 KB + line count, plan 4 KB, AskUserQuestion
questions/options only, unknown tools get a 2 KB JSON preview). A card that still
exceeds `PERM_VIEW_MAX` (16 KB) falls back to `{preview, overflow:true}`.

A device answers with `{cmd:"perm", id, behavior:"allow"|"deny", always?, mode?,
message?, interrupt?, answers?}`. The bridge refuses the answer when remote
control is disabled (`error`), when the id is no longer in any `run.perms`
(`gone:true`), or when the fields fail validation (`bad id` / `bad behavior`).
`always` is passed through only as `true`, and only claude's own `addRules` /
`addDirectories` suggestions can be applied — the PWA cannot inject rules. `mode`
is limited to `default` / `acceptEdits`; wide modes (`bypassPermissions`, `auto`,
`dontAsk`) are handled per-run and are not reachable from the remote. Answers for
`AskUserQuestion` are sanitized (≤ 20 questions, key ≤ 500, value ≤ 1000).
Accepted answers go through `run.answerPerm()` — the same path as
`POST /api/perm/answer` — and are acknowledged with `{type:"perm_ack", id, ok}`.
`PERM_WAIT_MS` timeouts still deny on the phone.

Pending cards are replayed after `ready` and after every `watch` (`{type:"perms",
items}`), so a device that reconnects or switches sessions gets the cards that
are still open. Resolutions are broadcast as `perm_resolved` (id, behavior,
always, interrupt, expired), which also drives the "⌛ timed out" state.

**Security:** remote approval hands machine control to whoever holds the pairing
code. There is no per-device pairing or second confirmation yet; reset the code
when a device is lost (see Security notes).

### File browsing (Phase 2 E)

`{cmd:"ls", path}` / `{cmd:"read", path, offset?, limit?}` / `{cmd:"blob", path,
offset?}` are answered only inside two roots: the workspace and the project
transcript directory (`CFG.home/.claude/projects`). Every path is first checked
lexically against the roots and then resolved with `realpath()` and re-checked,
so `..` traversal, absolute paths outside, and symlinks/junctions pointing out
are all refused with `forbidden` whether or not the target exists — the PWA's
path is never trusted. Secret file names and credential directories (same list
as `gw/files.mjs`) are refused too; listings hide dotfiles, secrets, and
escaping or dangling symlinks, put directories first, and stop at 500 entries
(`truncated:true`).

`read` returns at most 48 KB per request as UTF-8 text (`data`, `size`,
`offset`, `next`, `eof`); a multibyte character cut by the boundary is dropped
and the next read starts at `next`. Files with NUL bytes in the first 8 KB are
reported as `binary` with size/mime instead of raw bytes. The reply is
re-checked against `REPLY_MAX` (150 KB) after JSON escaping and truncated if
needed. `blob` serves base64 in 90 000-byte chunks (≈120 KB base64, inside the
180 KB plaintext cap) with `next` pointing at the next offset and `null` at the
end; files above 5 MB are refused with `too large`.

The PWA adds a 文件 panel: root selector (工作区 / 项目记录), path bar with 上一级,
directory listing, and a text viewer with 继续读取 (each tap shows the next page,
not cumulative) or an image preview assembled from blob chunks into a Blob URL.
Other binaries show size + mime only; nothing is written back to the phone.

## Behavior notes

- The gateway persists room + code in `CFG.home/ccapp-remote.json` (mode 0600),
  so restarts keep the same pairing; `POST /api/remote/reset` regenerates both
  and old devices are locked out.
- PWA reconnect: 2 s doubling to 30 s, reset after a good handshake. `bad-code`
  is fatal (no retry loop). A pairing link auto-connects on load; the connect
  button starts a fresh log.
- The PWA sends `watch` after `ready` and on every session-dropdown change; it
  queues incoming `data` frames that arrive before the handshake key is ready
  (relay delivers `hello` and `ready` back-to-back).
- Selecting a session clears the stream view and loads its latest history page
  (also after reconnect); "load earlier" prepends without moving the scroll
  position. Live events for that session append below the history.
- Switching sessions clears the permission cards on screen; the bridge replays
  the ones still open after the new `watch`. The file panel closes when remote
  control is disabled and keeps its own path history (no back stack beyond 上一级).

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

## Security notes

- Relay keeps no state on disk; rooms disappear when the agent disconnects.
- Limits: 256 KB per frame **and per reassembled message** (a fragmented stream
  without FIN is closed with 1009), 80 msgs/10 s per socket, 4 peers/room,
  1000 rooms, 25 s ping timeout.
- The public endpoint is HTTPS with a valid cert; WebSocket uses WSS.
- Pairing code = remote-control credential: anyone with it can drive the phone
  **and answer permission prompts**. There is no second confirmation and no
  per-device pairing yet; reset the code when a device is lost. The settings
  page shows it only on the phone.
- File browsing is limited to the workspace and the project transcript
  directory; secret names and credential directories are filtered, but anything
  else under those two roots is readable by any paired device.
- Not yet: device revocation list, per-device pairing, per-IP limits on the
  relay (a client can reconnect to retry joins).

## Operations

The relay host is whichever machine runs `relay/server.mjs` + the two frpc
processes. Checklist when moving or re-provisioning it:

- Keep the relay on `127.0.0.1:3010` and let frpc terminate TLS (tunnel
  `29898220`, local port 3010).
- Check the SakuraFrp dashboard for traffic: the free plan is 5 GiB/month at
  10 Mbps; the tunnel stops when it runs out. Daily check-in adds traffic.
- Auto-start after login/reboot (Windows):

  ```bat
  schtasks /Create /TN cccodroid-relay /SC ONLOGON /TR "node D:\cccodroid\remote\relay\server.mjs --port 3010 --host 127.0.0.1"
  schtasks /Create /TN cccodroid-frpc  /SC ONLOGON /TR "frpc -f <访问密钥>:29898220"
  ```

  or a systemd unit on Linux (`Restart=always`, `After=network-online.target`).
- After restarting the relay, verify `https://api.r01omzmfm.nyat.app:42965/health`
  returns `{"ok":true,…}` (the cert takes ~30 s on a cold frpc start).
