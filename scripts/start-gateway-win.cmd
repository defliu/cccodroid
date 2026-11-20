@echo off
setlocal EnableExtensions
rem cccodroid desktop gateway for Windows.
rem The phone is a client; Claude Code runs on this PC. The gateway listens on
rem 127.0.0.1 only; the phone comes in through the relay (remote/relay).
rem See docs/windows-desktop-gateway.md
rem
rem Optional environment variables (defaults in parentheses):
rem   CCAPP_HOME      gateway home (%USERPROFILE%): sessions, login, config
rem   CCAPP_WORKSPACE workspace root shown in the UI (%USERPROFILE%)
rem   CCAPP_PORT      port (8790)
rem   CCAPP_CLAUDE    path to claude.exe (auto-detected from PATH / npm global dir)
rem   CCAPP_SHELL     Git Bash bash.exe for the Bash tool (auto-detected)
rem   CCAPP_LOG       log file (%USERPROFILE%\.claude\ccapp-gateway.log)

set "ROOT=%~dp0.."
if not defined CCAPP_HOME set "CCAPP_HOME=%USERPROFILE%"
if not defined CCAPP_WORKSPACE set "CCAPP_WORKSPACE=%USERPROFILE%"
if not defined CCAPP_PORT set "CCAPP_PORT=8790"
if not defined CCAPP_LOG set "CCAPP_LOG=%USERPROFILE%\.claude\ccapp-gateway.log"
set "CCAPP_NO_BRIDGE=1"

if not defined CCAPP_CLAUDE (
  for /f "delims=" %%i in ('where claude.exe 2^>nul') do if not defined CCAPP_CLAUDE set "CCAPP_CLAUDE=%%i"
)
if not defined CCAPP_CLAUDE if exist "%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" set "CCAPP_CLAUDE=%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
if not defined CCAPP_CLAUDE (
  echo [cccodroid] claude.exe not found: install Claude Code, or set CCAPP_CLAUDE to its path.
  exit /b 1
)

if not defined CCAPP_SHELL if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "CCAPP_SHELL=%ProgramFiles%\Git\usr\bin\bash.exe"
if not defined CCAPP_SHELL if exist "%ProgramFiles(x86)%\Git\usr\bin\bash.exe" set "CCAPP_SHELL=%ProgramFiles(x86)%\Git\usr\bin\bash.exe"
if not defined CCAPP_SHELL if exist "%LocalAppData%\Programs\Git\usr\bin\bash.exe" set "CCAPP_SHELL=%LocalAppData%\Programs\Git\usr\bin\bash.exe"
if not defined CCAPP_SHELL (
  for /f "delims=" %%i in ('where git.exe 2^>nul') do if not defined CCAPP_SHELL (
    for %%j in ("%%i") do if exist "%%~dpj..\usr\bin\bash.exe" set "CCAPP_SHELL=%%~dpj..\usr\bin\bash.exe"
  )
)
if not defined CCAPP_SHELL echo [cccodroid] Git Bash not found: the Bash tool may not work. Set CCAPP_SHELL to bash.exe.

echo [cccodroid] gateway http://127.0.0.1:%CCAPP_PORT%
echo [cccodroid]   home=%CCAPP_HOME%
echo [cccodroid]   workspace=%CCAPP_WORKSPACE%
echo [cccodroid]   claude=%CCAPP_CLAUDE%
echo [cccodroid] desktop UI: http://127.0.0.1:%CCAPP_PORT%/?t=^<contents of .gateway-token^>
node "%ROOT%\gateway\server.mjs"
