@echo off
setlocal EnableExtensions
rem cccodroid relay for Windows: both the phone and the gateway connect here.
rem The phone side needs HTTPS/WSS (browsers expose WebCrypto only in a secure
rem context). Put an HTTPS tunnel (e.g. SakuraFrp) in front of this port.
rem See docs/windows-desktop-gateway.md
rem
rem Optional environment variables:
rem   RELAY_PORT  port (3011)
rem   RELAY_HOST  bind address (127.0.0.1); use 0.0.0.0 for direct LAN clients

set "ROOT=%~dp0.."
if not defined RELAY_PORT set "RELAY_PORT=3011"
if not defined RELAY_HOST set "RELAY_HOST=127.0.0.1"

echo [cccodroid] relay http://%RELAY_HOST%:%RELAY_PORT%
node "%ROOT%\remote\relay\server.mjs" --port %RELAY_PORT% --host %RELAY_HOST%
