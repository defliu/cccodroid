# Windows desktop gateway: control this PC's Claude Code from your phone

Direction: the phone is a client; Claude Code runs on this Windows PC.

```
phone browser (PWA) ──WSS──▶ relay (remote/relay) ◀──WSS── gateway (gateway/) ──▶ local claude.exe
                                       ▲ phone side is just a web page; the relay forwards ciphertext only
```

Nothing has to be installed on the phone — no devkit, no on-phone Claude Code. Open the relay's
page, pair once, add it to the home screen. The main APK's first-run downloads (devkit, on-phone
Claude Code) are only for the phone-as-host direction and are unnecessary here. If you want a
separate app icon instead of a browser tab, use the remote-client APK described under
"Phone app (optional)" below; it is the shell only and downloads nothing.

## Requirements

- **Node.js 18+** (gateway and relay use only the Node standard library).
- **Claude Code CLI** working on this PC: `claude.exe` on `PATH`, or at
  `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.
  The gateway does not log in for you — use whatever auth the CLI already has.
- **Git for Windows** for the Bash tool (optional, but Bash won't work without it).

## 1. Start the gateway

```bat
scripts\start-gateway-win.cmd
```

Defaults: `CCAPP_HOME=%USERPROFILE%` (the real `~/.claude`: sessions, login, config),
`CCAPP_WORKSPACE=%USERPROFILE%` (set it to your code root), `CCAPP_NO_BRIDGE=1`,
listening on `http://127.0.0.1:8790`. The gateway binds loopback only; the phone reaches it
through the relay.

Open the desktop UI once, with the token (this sets the cookie; later visits are plain URLs):

```powershell
Start-Process ("http://127.0.0.1:8790/?t=" + (Get-Content "$env:USERPROFILE\.gateway-token" -Raw).Trim())
```

In Settings → Provider choose the one this PC uses: Claude account login, or a custom provider
pointing at a local proxy (`baseUrl`, API key, default model). On Windows, claude.exe 2.1.326
does not run `apiKeyHelper` from `--settings` outside `--bare`, so the desktop gateway passes a
custom provider's key via the child environment (the phone path still uses `apiKeyHelper`).

The first message shows a "user-level configuration" card (hooks/plugins/settings under
`~/.claude`). This is the gateway's existing guard against injected config; confirm once.

## 2. Start the relay

```bat
scripts\start-relay-win.cmd
```

Defaults to `127.0.0.1:3011`. The gateway dials this address, so the relay itself does not need
to be reachable for the gateway.

## 3. Make it reachable from the phone (HTTPS/WSS)

The PWA uses WebCrypto, which browsers only expose in a secure context (`https://` or localhost).
So the phone must load an HTTPS page:

- SakuraFrp / frp HTTPS tunnel to local port `3011`, giving an `https://…` domain (TLS terminates
  at the tunnel). Keep the gateway's relay URL as `ws://127.0.0.1:3011/ws`.
- Or your own domain with Caddy/Nginx reverse-proxying to `127.0.0.1:3011` (forward WebSocket
  `Upgrade`).
- Plain `http://<LAN-IP>:3011` (with `RELAY_HOST=0.0.0.0`) is for LAN troubleshooting only —
  without a secure context the phone browser may not provide WebCrypto.

## 4. Pair

1. Desktop UI → Settings → Remote: relay `ws://127.0.0.1:3011/ws`, enable, generate a code.
2. Open `https://your-domain/#room=…&code=…` on the phone → "encrypted connection established".
3. Add to home screen.
4. Pick "new session" or an existing one; send prompts, watch the stream, stop, browse files,
   answer permission cards.

The pairing link/code is the key to this PC: don't post it. Reset invalidates old codes.

## Phone app (optional)

For an app icon instead of a browser tab: the apk workflow publishes `cccodroid-remote.apk`
next to the main APKs (download it from the run's Artifacts), and locally
`CLIENT=1 sh scripts/build.sh` produces it.

It keeps only the cccodroid shell (one Activity + WebView + pairing screen) and drops everything
that would have to run on the phone:

- no devkit download, no on-phone Claude Code, no on-phone gateway;
- only the `INTERNET` permission (no storage, Shizuku, accessibility or battery exemptions);
- application id `cc.codroid.remote`, so it can live next to the main app.

The PWA is bundled in the APK and served from the app's own loopback port, with the relay address
passed as `?relay=`. Loopback is a secure context, so `crypto.subtle` is available and the relay
does **not** need HTTPS — plain `ws://` over the LAN works.

Usage: expose the relay to the phone (LAN: `RELAY_HOST=0.0.0.0` and allow port 3011 in the
firewall; remote: a SakuraFrp TCP or HTTPS tunnel), set the gateway's relay URL to the address the
phone can reach, generate the pairing link, install the APK and paste the link. The link's host is
the relay; to switch networks use ⋮ → "重新配对" (re-pair) with a new link. The app's private
storage holds that link — treat it like the pairing code.

Known limit: downloads in the file browser are Blob URLs, which Android WebView does not hand to
the system download manager. Viewing text/images works; for large downloads open the same pairing
link in a browser.

## Notes

- Sessions are the real `~/.claude/projects` under `CCAPP_HOME` — the phone sees the same
  sessions as the desktop CLI.
- Gateway log: `%USERPROFILE%\.claude\ccapp-gateway.log`.
- Anyone who can open the paired PWA can run commands on this PC through Claude. Treat the
  pairing code like a password.
