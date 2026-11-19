// Phase 2 D：远程权限卡的整形与答案校验。
import test from "node:test";
import assert from "node:assert/strict";
import {
  permForRemote,
  permAnswerFor,
  suggestionRules,
  hasAlwaysSuggestion,
  PERM_VIEW_MAX,
  PERM_TEXT_MAX,
} from "../../gateway/gw/remote-perm.mjs";

test("perm: card whitelists fields and drops unknown input keys", () => {
  const v = permForRemote({
    id: "p1", tool: "Bash", at: 123, runId: "r1", sessionId: "s1", secret: "x",
    input: { command: "rm -rf build", description: "清理", secretArg: "leak" },
  });
  assert.equal(v.id, "p1");
  assert.equal(v.tool, "Bash");
  assert.equal(v.runId, "r1");
  assert.equal(v.sessionId, "s1");
  assert.equal(v.at, 123);
  assert.deepEqual(v.input, { command: "rm -rf build", description: "清理" });
  assert.equal(v.secret, undefined);
  assert.equal(v.input.secretArg, undefined);
  assert.equal(permForRemote({ tool: "Bash" }), null);
  assert.equal(permForRemote(null), null);
});

test("perm: long tool payloads are clipped per tool", () => {
  const bash = permForRemote({ id: "a", tool: "Bash", input: { command: "x".repeat(5000) } });
  assert.ok(bash.input.command.length <= 2001);
  const write = permForRemote({ id: "b", tool: "Write", input: { file_path: "/w/a.txt", content: "y".repeat(9000) } });
  assert.ok(write.input.content.length <= 2001);
  assert.equal(write.input.lines, 1);
  assert.equal(write.input.file_path, "/w/a.txt");
  const plan = permForRemote({ id: "c", tool: "ExitPlanMode", input: { plan: "z".repeat(PERM_TEXT_MAX * 2) } });
  assert.ok(plan.input.plan.length <= PERM_TEXT_MAX + 1);
  const web = permForRemote({ id: "d", tool: "WebFetch", input: { url: "https://x", prompt: "p", extra: 1 } });
  assert.deepEqual(web.input, { url: "https://x", prompt: "p" });
});

test("perm: AskUserQuestion keeps only question/options fields", () => {
  const v = permForRemote({
    id: "q1", tool: "AskUserQuestion",
    input: { questions: [{ question: "用哪个？", multiSelect: true, header: "h", options: [{ label: "A", description: "aa", x: 1 }, { label: "B" }] }] },
  });
  assert.deepEqual(v.input.questions, [{
    question: "用哪个？", multiSelect: true,
    options: [{ label: "A", description: "aa" }, { label: "B", description: undefined }],
  }]);
  assert.equal(v.input.questions[0].header, undefined);
});

test("perm: unknown tools only get a preview, not raw input", () => {
  const v = permForRemote({ id: "u1", tool: "UserConfig", input: { changes: [{ rel: "a", kind: "added" }], secret: 1 } });
  assert.ok(v.input.preview.includes("changes"));
  assert.equal(v.input.changes, undefined);
});

test("perm: always suggestions are surfaced as rules, and only claude's own", () => {
  const p = {
    id: "g1", tool: "Bash",
    suggestions: [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }] },
      { type: "addDirectories", directories: ["/w"] },
      { type: "setMode", mode: "acceptEdits" },
    ],
  };
  assert.deepEqual(suggestionRules(p), ["Bash(npm test:*)"]);
  assert.equal(hasAlwaysSuggestion(p), true);
  const v = permForRemote(p);
  assert.deepEqual(v.rules, ["Bash(npm test:*)"]);
  assert.equal(v.canAlways, true);
  const none = permForRemote({ id: "g2", tool: "Bash", suggestions: [{ type: "setMode", mode: "acceptEdits" }] });
  assert.equal(none.canAlways, undefined);
  assert.equal(none.rules, undefined);
  assert.equal(hasAlwaysSuggestion({ suggestions: [{ type: "addDirectories" }] }), true);
});

test("perm: oversized card falls back to a summary inside the view budget", () => {
  const p = { id: "big", tool: "AskUserQuestion", guard: { cat: "device:screen", what: "读屏" }, input: { questions: [] } };
  for (let i = 0; i < 40; i++) {
    p.input.questions.push({ question: "q".repeat(800), options: Array.from({ length: 10 }, (_, k) => ({ label: `o${k}` + "z".repeat(180), description: "d".repeat(280) })) });
  }
  const v = permForRemote(p);
  assert.equal(v.overflow, true);
  assert.ok(Buffer.byteLength(JSON.stringify(v), "utf8") <= PERM_VIEW_MAX);
  assert.ok(v.input.preview);
  assert.deepEqual(v.guard, { cat: "device:screen", what: "读屏" });
});

test("perm answer: only whitelisted fields survive", () => {
  const ok = permAnswerFor({ id: "p1", behavior: "allow", always: true, mode: "acceptEdits", updatedPermissions: [{ hack: 1 }] });
  assert.equal(ok.id, "p1");
  assert.deepEqual(ok.a, { behavior: "allow", always: true, mode: "acceptEdits" });
  assert.equal(permAnswerFor({ id: "p1", behavior: "maybe" }).error, "bad behavior");
  assert.equal(permAnswerFor({ behavior: "allow" }).error, "bad id");
  // 不允许远程切到「全部放行」这类模式
  const wide = permAnswerFor({ id: "p1", behavior: "allow", mode: "bypassPermissions" });
  assert.equal(wide.a.mode, undefined);
});

test("perm answer: deny message clipped, interrupt kept", () => {
  const d = permAnswerFor({ id: "p2", behavior: "deny", message: "  ".repeat(10) + "x".repeat(3000), interrupt: true });
  assert.equal(d.a.behavior, "deny");
  assert.equal(d.a.interrupt, true);
  assert.ok(d.a.message.length <= 2000);
  const empty = permAnswerFor({ id: "p3", behavior: "deny" });
  assert.equal(empty.a.message, undefined);
  assert.equal(empty.a.interrupt, undefined);
});

test("perm answer: AskUserQuestion answers are sanitized", () => {
  const r = permAnswerFor({
    id: "p4", behavior: "allow",
    answers: { "用哪个？": " A ", bad: 42, "": "x", ["a".repeat(900)]: "y".repeat(2000) },
  });
  assert.deepEqual(Object.keys(r.a.answers), ["用哪个？", "a".repeat(500)]);
  assert.equal(r.a.answers["用哪个？"], "A");
  assert.equal(r.a.answers["a".repeat(500)].length, 1000);
  const none = permAnswerFor({ id: "p5", behavior: "allow", answers: { bad: 1 } });
  assert.equal(none.a.answers, undefined);
});
