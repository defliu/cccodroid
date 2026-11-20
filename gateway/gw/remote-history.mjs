// 远程历史回放的数据整形（纯函数，不碰文件系统，方便单测）。
//
// transcript 的一页条目能带几百 KB（工具参数里的整份文件、长回复），而中继单帧
// 256 KB、桥接明文上限 180 KB —— 超了整条连接就被断。所以手机端只拿白名单字段，
// 而且一段回复 / 一次工具调用都有上限，整页再按总预算收一次。

export const MAX_TEXT = 8000;          // 用户 / 助手正文、压缩提示
export const MAX_TOOL = 4000;          // 工具入参 / 结果
export const HISTORY_BUDGET = 120_000; // 一页历史 JSON 的总字节数（UTF-8）

const CLIP = "…";
const clip = (s, max) => (s.length > max ? s.slice(0, max) + CLIP : s);
const idOf = (v) => (typeof v === "string" && v ? v.slice(0, 120) : null);
const textField = (it) => (it.role === "tool_use" ? "input" : "text");
const byteLen = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** transcriptItems 的一条 → 发给手机的白名单条目；thinking / hookctx 等不发。 */
export function trimHistoryItem(it) {
  if (!it || typeof it !== "object") return null;
  if (it.role === "user" || it.role === "assistant") {
    if (typeof it.text !== "string" || !it.text) return null;
    const text = clip(it.text, MAX_TEXT);
    return { role: it.role, text, ...(text !== it.text ? { truncated: true } : {}) };
  }
  if (it.role === "note") {
    if (typeof it.text !== "string" || !it.text) return null;
    return { role: "note", text: clip(it.text, MAX_TEXT) };
  }
  if (it.role === "tool_use") {
    const name = typeof it.name === "string" && it.name ? it.name.slice(0, 80) : "tool";
    let input = "";
    try {
      input = typeof it.input === "string" ? it.input : JSON.stringify(it.input ?? "");
    } catch { input = ""; }
    return { role: "tool_use", id: idOf(it.id), name, input: clip(input, MAX_TOOL) };
  }
  if (it.role === "tool_result") {
    const text = typeof it.text === "string" ? clip(it.text, MAX_TOOL) : "";
    return { role: "tool_result", id: idOf(it.id), ok: it.ok !== false, text };
  }
  return null;
}

/** 一页条目 → 能塞进一帧的白名单条目。
 *  先逐条裁剪；还超预算就按比例把所有正文一起缩短（保住条数与顺序，手机端不会缺轮次），
 *  极端情况（条目太多、每条都缩到下限）再从最老的条目开始丢。 */
export function packHistory(items, budget = HISTORY_BUDGET) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const t = trimHistoryItem(it);
    if (t) out.push(t);
  }
  for (let guard = 0; guard < 20 && byteLen(out) > budget; guard++) {
    const ratio = Math.max(0.05, (budget / byteLen(out)) * 0.9);
    let changed = false;
    for (const it of out) {
      const k = textField(it);
      const s = String(it[k] || "");
      if (s.length <= 400) continue;
      const max = Math.max(400, Math.floor(s.length * ratio));
      if (max < s.length) { it[k] = clip(s, max); it.truncated = true; changed = true; }
    }
    if (!changed) break;
  }
  while (out.length > 1 && byteLen(out) > budget) out.shift();
  return out;
}
