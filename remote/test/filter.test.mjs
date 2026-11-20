// Session attribution and per-peer filtering: pure helpers used by the bridge
// (gateway/gw/remote.mjs) and mirrored by the mock gateway.

import { test } from "node:test";
import assert from "node:assert/strict";
import { eventSessionOf, wantsEvent } from "../../gateway/gw/remote-filter.mjs";

test("filter: eventSessionOf reads sessionId, session_gone.id, then runId mapping", () => {
  const runs = [
    { id: "r1", sessionId: "s-quant" },
    { id: "r2", sessionId: "s-notes" },
    { id: "r3" },   // 还没拿到会话号的新会话
  ];

  assert.equal(eventSessionOf({ type: "run_start", sessionId: "s-quant", runId: "r1" }, runs), "s-quant");
  assert.equal(eventSessionOf({ type: "session_gone", id: "s-notes" }, runs), "s-notes");
  assert.equal(eventSessionOf({ type: "delta", text: "x", runId: "r2" }, runs), "s-notes");
  // 新会话：run 在，但还没有会话号 → 归属未知
  assert.equal(eventSessionOf({ type: "delta", text: "x", runId: "r3" }, runs), null);
  assert.equal(eventSessionOf({ type: "delta", text: "x", runId: "r-gone" }, runs), null);
  assert.equal(eventSessionOf({ type: "usage" }, runs), null);
  assert.equal(eventSessionOf(null, runs), null);
  assert.equal(eventSessionOf({ type: "delta" }), null);
  // 字段形状不对时不猜
  assert.equal(eventSessionOf({ type: "delta", sessionId: 42 }, runs), null);
  assert.equal(eventSessionOf({ type: "session_gone", id: "" }, runs), null);
});

test("filter: wantsEvent is fail-open only when watch or origin is unknown", () => {
  assert.equal(wantsEvent(null, "s-quant"), true);      // 没筛选：全转发
  assert.equal(wantsEvent(null, null), true);
  assert.equal(wantsEvent("s-quant", null), true);      // 归属判不出：照发
  assert.equal(wantsEvent("s-quant", "s-quant"), true);
  assert.equal(wantsEvent("s-quant", "s-notes"), false); // 明确是别的会话才丢
});
