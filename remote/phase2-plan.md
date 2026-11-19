# Phase 2 方案（远程控制）

- 状态：A（事件过滤）+ B（多设备）已实现并通过本地验收（2026-11-19，见 `phase2-acceptance.md`，Android 真机项待设备执行）；C / D / E 未开工
- 前置：Phase 1 已完成并通过联调（见 `phase1-test-report.md`）
- 原则：先把「多台设备 / 多个会话同时跑」的真实痛点解决，再铺历史回放一类的新界面；每项都能单独上线、单独回退。

## 进度（2026-11-19）

- **A + B 已落地**：`gateway/gw/remote.mjs` 换成每 peer 一份 `{dataKey, ecdh, watch, at}`；新增 `gateway/gw/remote-filter.mjs`（事件归属 + fail-open 匹配）；PWA 在 `ready` 和下拉框变化时下发 `watch`；设置页显示「N 台远程设备已接入」。
- 测试：`remote/test/filter.test.mjs`（归属/筛选矩阵）、`remote/test/phase1.test.mjs` 新增双 peer 路由用例、mock 网关支持多 peer 与 `watch`；浏览器里用 mock 验证了按会话过滤，用真实网关 + 第二个客户端验证了双设备各自握手、各自收 `ready`/`watching`，后加入者不影响先加入者。
- 偏差：没有引入 `lastCid`（入队幂等已有 `cid` 全局去重，Peer 级重发去重暂无需求）；`remoteStatus()` 新增 `peers` 数组，`peer` 保留为「最近一台」。
- 联调发现并修复：PWA 在 `hello` 与 `ready` 背靠背到达时可能先收到 `ready` 而密钥还没算完，会把 `ready` 丢掉 —— 现在先把 `data` 帧排队，握手完成再按序解密。

## 0. 现状与约束

- 中继已支持一个房间 4 个 peer、按 `peerId` 路由；桥接目前只记**最后一个** peer（`gw/remote.mjs` 的全局 `peerId` / `dataKey`），所以第二台设备一接入，第一台就收不到数据。
- 事件通过总线 `onPublish` 白名单转发，**没有按会话过滤**；手机上同时跑几个会话时，远程端会混着显示。
- 事件大多只带 `runId`（`runEmit` 统一加），只有 `run_start` / `run_end` 带 `sessionId`；需要 `runList()` 做 run→session 映射。
- 历史消息已有现成读法：`gw/transcript.mjs` 的 `readSessionPage()`（`/api/sessions` 的分页也用它）。
- 权限确认已有现成入口：`run.answerPerm(id, {...})`（对应 `/api/perm/answer`）。
- 所有新增命令都走 E2E 通道，中继零改动；新文案记得补 `lang-en.js` + 8 个 txt。

## A. 事件按会话过滤（建议先做，0.5–1 天）

**目标**：远程端选了某个会话，就只看到这个会话的进度；后台其它会话的流式输出不再串台。

**协议**：新增 c2a `{cmd:"watch", sessionId}`（`null` = 不筛选），a2c 可选回执 `{type:"watching", sessionId}`。

**桥接**（`gateway/gw/remote.mjs`）：

1. `let watchSession = null`；收到 `watch` 就更新（只接受 `SID_OK` 形状的串）。
2. 解析事件归属：`ev.sessionId` → `session_gone` 用 `ev.id` → 否则用 `runList().find(r => r.id === ev.runId)?.sessionId`。
3. 过滤规则（**fail-open**）：`watchSession` 为空 → 全转发（保持现状）；非空 → 归属已知且不等于 `watchSession` 的才丢，判定不出的照发。
4. peer 离开时清空 `watchSession`。

**PWA**（`remote/web/app.js`）：连接建立 / 收到 `ready` / 下拉框变化时发 `watch`，值取当前选中项（「新会话」发 `null`）。

**测试**：mock 网关支持 `watch` 并模拟两个会话的事件；浏览器里选 A 会话时看不到 B 的 `delta`；切回「新会话」恢复全量。

**已定的取舍**：`watch = null`（新会话视图）不做严格过滤。新会话那一轮在拿到 sessionId 之前没有归属，严格过滤会把用户刚发的内容藏掉；等会话列表刷新后用户选中新会话，自然就严了。

## B. 多设备路由（1–2 天，和 A 一起做最省事）

**目标**：中继允许 4 台设备，桥接也真的能同时服务；每台各自选会话、各自收事件。

**改法**：

1. 把全局 `dataKey` / `ecdh` / `peerId` / `watchSession` 换成 `peers = Map<peerId, { dataKey, ecdh, watch, lastCid, at }>`。
2. `hello`：按 `msg.peerId` 建/重置该 peer 的 ecdh 与 dataKey（现在 `peer` join 事件已带 peerId，验证 MAC 后回 `hello` 用同一个 id）。
3. `data`：用 `peers.get(msg.peerId)` 解密（中继给客户端来的帧盖了来源 peerId）；命令回复只发给该 peer。
4. `sendData(obj)` 改成 `sendTo(peerId, obj)`；事件广播给所有 watch 命中的 peer。
5. `peer leave` / 断线：删对应 peer；`remoteStatus().peer` 从单个值改成 `peers: [{peerId, at, watch}]`，`peer` 保留为「最近一台」兼容设置页。
6. `disableRemote` / `onClose` 清空整个 Map。

**设置页**：`10c-remote.js` 的状态文案改成「N 台设备已接入」（0/1/多），其余不动。

**测试**：`phase1.test.mjs` 扩成两台 peer 同时握手，断言各自只收到自己的 `queued` 回执、广播事件两台都收到（watch 为空时）。

**风险**：同房间共享同一个配对码，所有设备权限相同；单设备吊销要等「按设备配对」（见 D 的后续）。4 台上限来自中继，够用。

## C. 会话历史回放（1–2 天）

**目标**：远程端选中会话时，先看到最近的消息，而不是空白。

**协议**：c2a `{cmd:"history", sessionId, before?, limit?}` → a2c `{type:"history", sessionId, items, cursor}`；`limit` 默认 40、上限 100，`before` 用 `readSessionPage` 的 cursor 翻页。

**桥接**：`findSessionFile(sessionId)` + `readSessionPage(file, { before, limit })`，产出与 `transcriptItems` 一致的条目后裁剪：工具入参 / 结果各截 4 KB，图片只留标记不传 base64（必要时另走取图命令）。

**PWA**：进入会话时请求一页，顶部「加载更早」；样式复用现有气泡与工具卡。

**风险**：transcript 里可能含密钥或大段文件内容——只回白名单字段（role / text / tool 名 / 时间），不回原始 JSON；翻页上限防止一次拉爆帧（180 KB 明文上限）。

## D. 审批 / 权限卡片（2–3 天，安全敏感）

**目标**：远程端也能回答 guard 二次确认与权限请求。

**协议**：把 `perm_request` / `perm_resolved` 加进白名单（现在故意没有）；c2a `{cmd:"perm", id, behavior:"allow"|"deny", always?, mode?, message?}` → 调 `run.answerPerm(id, …)`，回 `{type:"perm_ack", id, ok}`。

**约束**：

- 只允许「远程控制已启用」时接单；id 必须是当前 run.perms 里真实存在的。
- 卡片上显示工具名、目标路径/命令摘要，和 Web UI 一致；不提供「全部允许」以外的批量放行，敏感操作照样逐张确认。
- `always` 只接受 claude 自己给的 suggestions（与 Web UI 同规则，前端不能塞任意规则）。
- 超时（`PERM_WAIT_MS`）仍按拒绝处理，和本机一致。

**风险**：远程批准等于把本机操作权交出去，配对码泄露的后果放大；建议和「按设备配对」一起做，或至少给远程确认加二次点击。

## E. 文件浏览 / 预览（2 天）

**目标**：远程端能看工作区文件和图片，替代「只能聊天」。

**协议**：c2a `{cmd:"ls", path}` / `{cmd:"read", path, offset?, limit?}`；只允许工作区与项目目录内（复用 `pathguard`），单次回包 ≤ 120 KB，二进制/图片单独 `{cmd:"blob", path}` 走 base64 并限 5 MB。

**风险**：目录穿越、符号链接逃逸、大文件把帧撑爆——三样都在桥接侧挡，不信任 PWA 的路径。

## 建议顺序

1. **A + B**（事件过滤 + 多设备）：同一片代码，一起改一次；B 只是把 A 的状态从「一个」变成「每个 peer 一份」。
2. **C**（历史回放）：纯新增，不动现有命令。
3. **D**（权限卡）：单独评审，最好和按设备配对一起。
4. **E**（文件）：最后。

## 需要定的三件事

1. 新会话视图（`watch = null`）是否接受上面的 fail-open？还是希望「只显示自己刚发的那一轮」？
2. 多设备是否接受「同一配对码 = 同权限」？按设备配对要做多大（每台一个子码 + 吊销列表）？
3. 历史回放默认 40 条、最多 100 条一页，够不够？
