# Phase 1 PWA 联调报告

- 日期：2026-11-19
- 环境：Windows 11 + Node v24.20.0（`node --test` 与浏览器手动联调）
- 组件：`remote/relay/server.mjs`（127.0.0.1:3012）+ `remote/test/mock-gateway.mjs` + `remote/web/`（同源 PWA）
- 结论：**发现并修复一个阻断性缺陷后，9.1 节联调清单全部通过；9.3 设置页入口与 9.4 校验补齐全做完了。**
  9.2（Android 真机）与本机的设置页目视验证做不了，原因见第五节。

## 一、发现的问题（已修复）

### 阻断：网关→远程端的 `data` 帧缺少 `peerId`，远程端收不到任何数据

- 位置：`gateway/gw/remote.mjs` 的 `sendData()`、`remote/test/mock-gateway.mjs` 的 `sendData()`
- 现象：PWA 能完成配对和握手（显示「已加密连接」），但会话列表为空、发送后无任何回显与事件流。
- 原因：中继在 agent 角色的 `data` 分支要求用 `msg.peerId` 定位目标 peer（`remote/relay/server.mjs:237-249`），缺失时回 `{t:"error",code:"no-peer"}` 并丢弃该帧。而桥接和 mock 的 `sendData` 都没带 `peerId`，所以 `ready` / `sessions` / 所有事件都到不了客户端。
- 对照组：Phase 0 的 `remote/test/demo-agent.mjs` 是带 `peerId` 的，所以 Phase 0 能通、Phase 1 从未真正跑通过。
- 修复：两处 `ws.send` 补上 `peerId`（各 1 行）。
- 回归：新增 `remote/test/phase1.test.mjs`，把契约钉死 —— 不带 `peerId` 必须收到 `no-peer`；带 `peerId` 必须能解密送达；客户端离开后再发同一 `peerId` 也必须 `no-peer`（不广播）。
- 影响面：**Android 真机上原样会复现**，不是 mock 特有问题。

## 二、联调结果（9.1 清单）

| 项 | 结果 | 证据 |
|---|---|---|
| 配对（房间 + 配对码，WebCrypto） | ✅ | 状态变为「已加密连接」，双方 MAC 校验通过 |
| `ready` 与会话下拉 | ✅ | mock 会话（`""`、`s-quant`、`s-notes`），自动选中 |
| 发送 → `queued` | ✅ | 「已发送，等待执行」 |
| 流式 `delta` | ✅ | 逐段追加「收到：…这是 mock 网关的流式回复。」 |
| `tool_use` / `tool_result` | ✅ | 🛠 Bash → ✓ Bash |
| `run_end` | ✅ | 「— 本轮结束 —」，并自动触发一次 `list` 刷新 |
| 停止按钮 | ✅ | mock 回 `stopped{killed:true}` → 「已停止当前轮」 |
| 刷新按钮 | ✅ | 重新拉取列表，且保持当前选中项 |
| 手动断开 → 重连 | ✅ | 「已断开」→ 重新握手 → 会话列表恢复 |
| 配对链接 `#room=…&code=…` | ✅ | 打开即自动连接（原先只预填，本次补上） |
| 断线自动重连 | ✅ | 2 秒起翻倍、封顶 30 秒，状态栏显示倒计时；恢复后重置 |
| 配对码错误 | ✅ | `bad-code` 判为终止态：「配对码不对，已停止重试」，不再循环 |
| 超长消息 | ✅ | 352 KB 的消息被挡下：「消息太长（352 KB），超过了中继的单帧上限，请拆成几条发送」，正文留在输入框 |
| 重连后日志 | ✅ | 点「连接」重新开始，旧日志清空 |
| 截图留档 | ⚠️ 用日志代替 | 截图工具在桌面窗口最小化时超时（工具限制，非功能问题）；以 PWA 面板日志代替留档：<br>`通道已建立（端到端加密）` → `已连接网关（2 个会话）` → `远程控制联调：截一张图留档` → `已发送，等待执行` → `收到：…` → `这是 mock 网关的流式回复。` → `🛠 Bash` → `✓ Bash` → `— 本轮结束 —` |

## 三、本轮补的代码（对应 9.3 / 9.4）

### 9.3 设置页入口

- `gateway/web/index.html`：「设置 → 设备与权限」后面新增「远程控制」分类，含开关、状态、配对链接（复制 / 打开）、房间 / 配对码 / 中继展示、重新生成配对码（两次点击确认，4 秒内有效）。
- `gateway/web/app/10c-remote.js`：进分类才轮询 `/api/remote/status`（3 秒一次），离开即停；调 `/api/remote/enable|disable|reset`。
- `gateway/web/app/15-pages.js`：分类切换时触发 `rmOnOpen()`。
- `gateway/web/lang-en.js`：新增 17 条英文；`i18n/scan.mjs` 显示 en 全覆盖，其余 8 种语言待翻译（见第五节）。

### 9.4 校验补齐

- `gateway/gw/queue.mjs`：把 `/api/chat` 的入参校验抽成 `precheckChat()`，路由和远程桥接共用 —— 接口没了（409）、没填 Key（503）、队列满（429）、超长（413）、会话号格式（400）在远程端同样生效。
- `gateway/gw/remote.mjs`：`send` 命令改用 `precheckChat()`；`enqueue` 包 try/catch；`sendData` 在加密前按 `MAX_PLAIN_BYTES` 挡超长帧（超了就回一句 `error`，不把连接撑爆）。
- `gateway/gw/remote-protocol.mjs`：新增 `MAX_PLAIN_BYTES = 180_000` 与 `plainBytes()`（中继单帧 256 KB，base64 后膨胀 4/3）。
- `remote/web/app.js`：发送前同样检查；被挡时正文保留、不记成「已发送」。

### 9.5 安全与运维复核

- **状态文件权限 0600**：`gw/remote.mjs` 的 `saveState()` 写入时 `mode: 0o600` 并补一次 `chmod`，确认无误。
- **设备吊销 / 重置入口**：`/api/remote/reset` 已有，设置页「重新生成配对码」接上（两次点击确认）。
- **中继限流 / 房间数 / 帧大小复核**：256 KB/帧、80 条/10 秒/连接、4 peer/房间、1000 房间、25 秒心跳，参数本身合理。复核时发现一个缺口：帧上限只查单帧，**分片消息（continuation 帧不置 FIN）的总量没有上限**，可被用来把中继内存撑大。已修：重组总量超过 `MAX_FRAME` 直接 1009 断开，并补 `remote/test/relay-limits.test.mjs`（正常分片仍能组装、超量分片必须 1009）。残余风险：中继没有按 IP 限流，攻击者可以重连反复试 `join`（只影响可用性，配对码哈希校验不受影响）。
- **免费隧道流量**：5 GiB/月、10 Mbps，超了断；需在 SakuraFrp 面板看用量并每日签到。已写进 `README.md` 的 Operations。
- **开机自启**：中继与 frpc 的自启属于中继所在机器的运维；`README.md` 的 Operations 给了 Windows 计划任务示例与 Linux systemd 提示（访问密钥仍不入库）。

## 四、测试

- `node --test remote/test/phase0.test.mjs remote/test/phase1.test.mjs remote/test/wsclient.test.mjs remote/test/relay-limits.test.mjs`：全部通过（含 peerId 契约回归与分片总量上限）。
- 手动联调：relay 3012 + mock gateway，在浏览器面板里逐项走完第二节清单。
- 设置页：本机无法运行网关（见第五节），只做了静态检查：分段拼接后的 `app.js` 语法通过，`index.html` 的 id 与 `10c-remote.js` 引用一一对应。
- 网关回归（Windows 上借用 `process.getuid` 垫片跑临时目录）：`queue-v062`、`provider-gone`、`stab-b-chat-idem` 15 项全过（覆盖 `precheckChat` 抽取）；前端/语言 45 项过 44，唯一失败的 `a0610-f3-frontend` C23 是工作区 CRLF 与测试里 LF 锚点不一致的 Windows 检出问题，与本次改动无关（该文件未动）。

## 五、本机做不了的验证

1. **9.2 Android 真机**：没有设备。清单里的打包核实已做：`scripts/build.sh` 用 `cp "$SRC/gw/"*.mjs` 整目录拷网关模块、`cp -R` 拷整个 `web/`，新增的 `gw/remote*.mjs` 与 `web/app/10c-remote.js` 随目录进 APK，FILES 清单也由 build.sh 现场生成，无需改打包配置。剩下的真机启动、10 分钟观察只能上设备做。
2. **设置页目视验证**：网关在 Windows 上起不来 —— `process.getuid()` 在 `usage.mjs` 顶层调用，导入即抛；`bridge-config.mjs`、`claude.mjs`、`leftover.mjs`、`managed-bridge.mjs`、`sessionops.mjs`、`storage.mjs` 也都有。按交接文档的约定不在 Windows 上硬跑。需要真机或 Linux 上看一眼布局。
3. **翻译**：本机补的 17 条英文之外，其他 8 种语言（繁 / 法 / 西 / 俄 / 阿 / 日 / 韩 / 印尼）的译文也已按 `i18n/lang-*.txt` 流程补齐，`node i18n/scan.mjs --all` 显示 9 种语言均 2984/2984。译文值得母语使用者再看一眼，尤其是「中继 / relais / ретранслятор / المرحّل」这类术语。

## 六、其他发现（未改动，Phase 2 范围）

1. **多设备路由**：桥接只记最后一个 `peerId`，两个远程端同时连时数据只发给后加入者（交接文档已列为 Phase 2）。
2. **二维码**：仓库里没有任何二维码库，设置页给的是复制 / 打开链接，扫码配对要等 Phase 2 决定引不引依赖。
3. 客户端日志里 `no-room` 的报错文案来自中继，提示可读性一般。
