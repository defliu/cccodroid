# Windows 桌面网关：用手机控制本机的 Claude Code

方向是「手机当客户端，Claude Code 跑在这台 Windows 电脑上」：

```
手机浏览器（PWA） ──WSS──▶ 中继（remote/relay） ◀──WSS── 网关（gateway/） ──▶ 本机 claude.exe
                                     ▲ 手机侧只是网页，端到端加密，中继只转发密文
```

这样用**不需要**在手机上装 devkit、Claude Code 或任何运行组件：手机打开中继上的网页、
配对一次，加到主屏幕就行。主 APK 首启时那些几百 MB 的「开发组件 / 手机端 Claude Code」
都是给「在手机上跑网关」那条路准备的，这条路一概用不上；想要独立 App 图标的，用下面
「手机端 App（可选）」里的遥控端 APK——它只保留壳，不下载任何东西。

## 前提

- **Node.js 18+**（网关和中继都只用 Node 标准库，没有 npm 依赖）。
- **Claude Code CLI** 已经能在这台电脑上正常用：`claude.exe` 在 `PATH` 里，或者装在
  `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`。
  网关不替你登录：CLI 自己怎么认证（Claude 账户登录 / 厂商 key / 本机代理）就怎么来。
- **Git for Windows**（Bash 工具要用它的 `bash.exe`）。没有也能起，只是 Claude 的 Bash 工具用不了。

## 1. 起网关

```bat
scripts\start-gateway-win.cmd
```

脚本会设好 `CCAPP_HOME=%USERPROFILE%`（读本机真实的 `~/.claude`，历史会话、登录态都在）、
`CCAPP_WORKSPACE`（默认也是用户目录，建议设成你放代码的根，比如 `D:\Traework`）、
`CCAPP_NO_BRIDGE=1`，然后开 `http://127.0.0.1:8790`。网关只监听回环地址，手机连不进来，
必须经中继。

先起一次、打开桌面界面确认能聊天：

```bat
set CCAPP_WORKSPACE=D:\Traework
set CCAPP_PORT=8790
scripts\start-gateway-win.cmd
```

首次访问界面要带令牌（会种 Cookie，之后直接开就行）：

```powershell
Start-Process ("http://127.0.0.1:8790/?t=" + (Get-Content "$env:USERPROFILE\.gateway-token" -Raw).Trim())
```

在「设置 → 厂商」里选好本机在用的那家：

- **Claude 账户登录**：CLI 已经 `/login` 过就直接用。
- **自定义厂商**：本机如果走的是本地代理（比如 `http://127.0.0.1:3425`），新建一家自定义厂商，
  填好 `baseUrl`、API Key、默认模型即可。Windows 上 claude.exe 2.1.326 在非 `--bare` 模式下
  不执行 `--settings` 里的 `apiKeyHelper`，所以桌面端会把这个厂商的 key 放进子进程环境变量
  （机主自己的机器、自己的 key；手机端仍然走 apiKeyHelper）。

> 首次发消息会弹一张「用户级配置」卡片：`~/.claude` 下的钩子、插件、设置要不要认。
> 这是网关的既有安全机制（防止有人趁模型读配置时塞东西），确认一次「保留」即可。

## 2. 起中继

```bat
scripts\start-relay-win.cmd
```

默认 `127.0.0.1:3011`。网关也是往这个地址拨号，所以中继不用暴露到公网给网关连。

## 3. 让手机连得上（HTTPS/WSS）

PWA 用 WebCrypto 做端到端加密，而浏览器只在**安全上下文**（`https://` 或 localhost）里提供
`crypto.subtle`。所以手机侧必须是 HTTPS：

- **SakuraFrp / frp 的 HTTPS 隧道**：本地端口填 `3011`，拿到一个 `https://xxxx` 域名；
  TLS 在隧道入口终止，转给本机中继即可。网关那条连接照旧写 `ws://127.0.0.1:3011/ws`。
- 自有域名 + Caddy/Nginx 反代到 `127.0.0.1:3011` 同理（WebSocket 要转发 Upgrade）。
- 纯局域网测试可以手机直接开 `http://电脑IP:3011`，但要在 `start-relay-win.cmd` 里把
  `RELAY_HOST` 设成 `0.0.0.0`、放行防火墙；且因为不是安全上下文，**手机浏览器可能没有 WebCrypto**，
  只适合排查，不建议日常用。

## 4. 配对

1. 桌面界面 → 设置 → 远程控制：中继填 `ws://127.0.0.1:3011/ws`（如果中继在别的机器上，
   填网关能直连的 `ws://…` 或 `wss://…`），开启，生成配对码。
2. 把配对链接 `https://你的域名/#room=…&code=…` 发到手机（同一 Wi-Fi 下直接抄也行），
   手机浏览器打开 →「已加密连接」。
3. 浏览器菜单 →「添加到主屏幕」，以后就是全屏应用。
4. 会话下拉框选「新会话」或已有会话；发消息、看流式输出、停止、文件、权限卡片都和桌面一致。

配对链接和配对码就是进入这台电脑的钥匙：不要发群、不要进仓库；怀疑泄漏就点「重置配对码」，
旧码立即作废。

## 手机端 App（可选）

不想用浏览器、想有一个独立的应用图标：仓库里的**遥控端 APK** 就是给这个场景的。
CI 的 apk 工作流会一起出 `cccodroid-remote.apk`（在运行的 Artifacts 里下载），
本地构建用 `CLIENT=1 sh scripts/build.sh`。

它只保留 cccodroid 的壳（一个 Activity + WebView + 配对页），把要在手机上跑的东西全裁掉：

- 不下载开发工具包，不装手机端 Claude Code，不起手机端网关；
- 只要 `INTERNET` 权限，没有存储 / Shizuku / 无障碍 / 电池优化，也没有后台保活服务；
- 包名 `cc.codroid.remote`，可以和主 APK 同时装。

页面（`remote/web`）是打进 APK 的，从应用自己的 `127.0.0.1` 临时端口加载，用 `?relay=`
把中继地址交给它。回环地址在浏览器里算安全上下文，`crypto.subtle` 可用，所以**中继
不需要 HTTPS**：同一 Wi-Fi 下直接 `ws://` 就行。

用法：

1. 让中继对手机可达。同一 Wi-Fi：`RELAY_HOST=0.0.0.0` 起中继，Windows 防火墙放行 3011；
   外网：SakuraFrp 的 TCP 或 HTTPS 隧道都行（TCP 就是 `ws://域名:端口`）。
2. 网关的远程中继填成手机能连的地址，比如 `ws://192.168.1.5:3011/ws` 或
   `wss://隧道域名/ws`，生成配对链接。
3. 手机上装 `cccodroid-remote.apk`，打开，把配对链接粘进去 →「连接」。

链接里的主机就是中继地址；换网络只要在 App 里「⋮ → 重新配对」换一条链接。App 私有目录
存着这条链接（等同钥匙），别把手机借人；怀疑泄漏就在电脑上重置配对码。

已知限制：文件浏览里的**下载**是网页用 Blob 生成的，Android WebView 不让它走系统下载；
看文本 / 图片没问题，要把大文件落到手机相册或下载目录，用浏览器打开同一个配对链接。

## 会话与数据

- 会话就是本机真实的 `~/.claude/projects`（`CCAPP_HOME` 指向的 home），手机看到的和桌面 CLI 是同一份。
- 网关日志默认 `%USERPROFILE%\.claude\ccapp-gateway.log`。
- 远程通道的安全边界：中继只见密文；网关只监听回环；手机侧靠 26 位配对码派生的密钥。
  能打开这个 PWA 的人等于能在这台电脑上让 Claude 执行命令，配对码按密码对待。

## 常见问题

- **手机打开显示「no-room」**：网关没连上中继（网关日志里搜 `[remote]`），或者中继地址/端口填错。
  网关重启会自动重连；改了中继地址或重置配对码后会自动断开重连（旧版本要重启网关）。
- **首轮一直等确认**：先发一条消息，在卡片里点「保留」；这是 `~/.claude` 第一次建档。
- **Bash 工具报错**：设置 `CCAPP_SHELL` 指到 Git Bash 的 `bash.exe`。
- **模型报 Not logged in**：CLI 本身没登录，或者自定义厂商没填 key。先用 `claude` 在终端里确认能对话。
