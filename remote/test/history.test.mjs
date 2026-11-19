// Phase 2 C：远程历史回放的整形规则 —— 白名单字段、单条上限、整页预算。
import test from "node:test";
import assert from "node:assert/strict";
import {
  trimHistoryItem,
  packHistory,
  MAX_TEXT,
  MAX_TOOL,
  HISTORY_BUDGET,
} from "../../gateway/gw/remote-history.mjs";

test("history: whitelist drops transcript-only fields", () => {
  const t = trimHistoryItem({ role: "assistant", text: "hi", uuid: "u1", truncated: true, chapter: 3, secret: "x" });
  assert.deepEqual(t, { role: "assistant", text: "hi" });
  const r = trimHistoryItem({ role: "tool_result", id: "t1", ok: false, text: "boom", name: "Bash", extra: 1 });
  assert.deepEqual(r, { role: "tool_result", id: "t1", ok: false, text: "boom" });
});

test("history: thinking and hook context are not sent", () => {
  assert.equal(trimHistoryItem({ role: "thinking", text: "hmm" }), null);
  assert.equal(trimHistoryItem({ role: "hookctx", event: "SessionStart", text: "ctx" }), null);
  assert.equal(trimHistoryItem(null), null);
  assert.equal(trimHistoryItem("nope"), null);
});

test("history: long text is capped and marked", () => {
  const t = trimHistoryItem({ role: "user", text: "a".repeat(MAX_TEXT + 50) });
  assert.equal(t.truncated, true);
  assert.ok(t.text.length <= MAX_TEXT + 1);
  const s = trimHistoryItem({ role: "assistant", text: "short" });
  assert.equal(s.truncated, undefined);
  assert.equal(s.text, "short");
});

test("history: tool input is stringified and capped, name kept", () => {
  const t = trimHistoryItem({ role: "tool_use", id: "t9", name: "Write", input: { content: "x".repeat(MAX_TOOL * 2) } });
  assert.equal(t.role, "tool_use");
  assert.equal(t.name, "Write");
  assert.equal(t.id, "t9");
  assert.ok(t.input.length <= MAX_TOOL + 1);
  assert.ok(t.input.includes("content"));   // 入参被序列化成字符串，不是原始对象
});

test("history: whole page fits the frame budget", () => {
  const items = [];
  for (let i = 0; i < 100; i++) {
    items.push({ role: i % 2 ? "assistant" : "user", text: String(i) + ":" + "z".repeat(20000) });
  }
  const out = packHistory(items);
  assert.ok(out.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(out), "utf8") <= HISTORY_BUDGET);
  // 顺序保持：最后一条仍是原列表最后一条的内容开头
  assert.equal(out[out.length - 1].text.slice(0, 3), "99:");
  assert.equal(out[0].text.slice(0, 2), "0:");
});

test("history: garbage entries are skipped, empty page stays empty", () => {
  assert.deepEqual(packHistory([]), []);
  assert.deepEqual(packHistory(null), []);
  const out = packHistory([null, 42, { role: "thinking", text: "x" }, "s", { role: "user", text: "ok" }]);
  assert.deepEqual(out, [{ role: "user", text: "ok" }]);
});
