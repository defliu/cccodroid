// Phase 2 D: permission requests over the remote channel.
//
// The gateway already emits `perm_request` with the full tool input (up to
// 64 KB per field, see queue.mjs permView). That is far more than a phone card
// needs, and the whole event must stay well under the relay frame limit, so the
// bridge sends a shaped copy: tool name, the fields the card renders, and the
// rules claude itself suggested for "always allow". Raw input is never echoed
// back by the PWA; answers carry only behavior/mode/message/answers, and the
// bridge hands them to run.answerPerm(), which re-validates id and expiry.

export const PERM_VIEW_MAX = 16_000;   // 整张卡片（JSON 字节）
export const PERM_TEXT_MAX = 4000;     // 计划 / 问题等长文本

const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : String(s ?? ""));
const byteLen = (o) => Buffer.byteLength(JSON.stringify(o), "utf8");

function clipOpt(v, n) {
  return typeof v === "string" ? clip(v, n) : undefined;
}

function inputFor(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (tool) {
  case "Bash":
    return { command: clip(i.command || "", 2000), description: clipOpt(i.description, 300) };
  case "Edit":
    return { file_path: clip(i.file_path || "", 400), old_string: clip(i.old_string || "", 1500), new_string: clip(i.new_string || "", 1500) };
  case "MultiEdit":
    return {
      file_path: clip(i.file_path || "", 400),
      edits: (Array.isArray(i.edits) ? i.edits : []).slice(0, 8).map((e) => ({
        old_string: clip((e && e.old_string) || "", 800), new_string: clip((e && e.new_string) || "", 800),
      })),
    };
  case "Write": {
    const c = String(i.content ?? "");
    const out = { file_path: clip(i.file_path || "", 400), content: clip(c, 2000) };
    const lines = c ? c.split("\n").length : 0;
    if (lines) out.lines = lines;   // 卡片上写「共 N 行」，正文只给前一段
    return out;
  }
  case "Read": case "Glob": case "Grep":
    return { file_path: clip(i.file_path || "", 400), path: clipOpt(i.path, 400), pattern: clipOpt(i.pattern, 500) };
  case "NotebookEdit":
    return { notebook_path: clip(i.notebook_path || "", 400), new_source: clip(i.new_source || "", 1500) };
  case "WebFetch":
    return { url: clip(i.url || "", 800), prompt: clipOpt(i.prompt, 800) };
  case "WebSearch":
    return { query: clip(i.query || "", 800) };
  case "ExitPlanMode":
    return { plan: clip(i.plan || "", PERM_TEXT_MAX) };
  case "AskUserQuestion":
    return {
      questions: (Array.isArray(i.questions) ? i.questions : []).slice(0, 8).map((q) => ({
        question: clip((q && q.question) || "", 800),
        multiSelect: !!(q && q.multiSelect),
        options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 10).map((o) => ({
          label: clip((o && o.label) || "", 200),
          description: clipOpt(o && o.description, 300),
        })),
      })),
    };
  default:
    // UserConfig / ProjectConfig / MCP 工具等：不解析，给一段可以看的预览
    return { preview: clip(typeof input === "string" ? input : JSON.stringify(i), 2000) };
  }
}

/** claude 自己给的「始终允许」规则，只用于卡片上显示；真正的规则永远从 run.perms 里取 */
export function suggestionRules(p) {
  const out = [];
  for (const s of (p && p.suggestions) || []) {
    if (!s || s.type !== "addRules") continue;
    for (const r of s.rules || []) {
      if (!r) continue;
      out.push(clip(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName || ""), 200));
    }
  }
  return out.filter(Boolean).slice(0, 6);
}

/** answerPerm 会把这些类型的建议交给 claude；没有就没什么可「始终允许」的 */
export function hasAlwaysSuggestion(p) {
  return ((p && p.suggestions) || []).some((s) => s && (s.type === "addRules" || s.type === "addDirectories"));
}

/** 一张待答权限卡在远程端的形状；没有 id 的（不是权限请求）返回 null */
export function permForRemote(p) {
  if (!p || typeof p !== "object") return null;
  const id = typeof p.id === "string" && p.id ? clip(p.id, 200) : "";
  if (!id) return null;
  const tool = clip(p.tool || "", 80);
  const out = { id, tool, input: inputFor(tool, p.input), at: Number(p.at) || 0 };
  if (p.runId) out.runId = clip(p.runId, 80);
  if (p.sessionId) out.sessionId = clip(p.sessionId, 80);
  if (p.toolUseId) out.toolUseId = clip(p.toolUseId, 120);
  if (p.agentId) out.agentId = clip(p.agentId, 120);
  if (p.interactive) out.interactive = true;
  if (p.blockedPath) out.blockedPath = clip(p.blockedPath, 400);
  if (p.reason) out.reason = clip(p.reason, 600);
  if (p.description) out.description = clip(p.description, 600);
  if (p.guard && typeof p.guard === "object") out.guard = { cat: clip(p.guard.cat || "", 80), what: clip(p.guard.what || "", 200) };
  const rules = suggestionRules(p);
  if (rules.length) out.rules = rules;
  if (hasAlwaysSuggestion(p)) out.canAlways = true;
  // 兜底：整张卡还是太大（计划特别长之类）就只留摘要和预览，别让事件撑爆一帧
  if (byteLen(out) > PERM_VIEW_MAX) {
    return {
      id, tool, at: out.at,
      ...(out.runId ? { runId: out.runId } : {}),
      ...(out.sessionId ? { sessionId: out.sessionId } : {}),
      ...(out.rules ? { rules: out.rules } : {}),
      ...(out.canAlways ? { canAlways: true } : {}),
      ...(out.guard ? { guard: out.guard } : {}),
      input: { preview: clip(JSON.stringify(p.input || {}), 1500) },
      overflow: true,
    };
  }
  return out;
}

const ALLOWED_MODES = new Set(["default", "acceptEdits"]);

function cleanAnswers(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 20)) {
    if (typeof k !== "string" || !k || typeof x !== "string") continue;
    const val = x.trim();
    if (val) out[k.slice(0, 500)] = val.slice(0, 1000);
  }
  return Object.keys(out).length ? out : null;
}

/** c2a `perm` 命令 → run.answerPerm 的参数。只收白名单字段；`always` 是布尔，
 *  规则本身永远由 claude 的 suggestions 决定（前端塞不进任意规则）。 */
export function permAnswerFor(cmd) {
  if (!cmd || typeof cmd !== "object") return { error: "bad command" };
  const id = typeof cmd.id === "string" ? cmd.id.slice(0, 200) : "";
  if (!id) return { error: "bad id" };
  const behavior = cmd.behavior === "allow" ? "allow" : cmd.behavior === "deny" ? "deny" : "";
  if (!behavior) return { error: "bad behavior" };
  const a = { behavior };
  if (behavior === "allow") {
    if (cmd.always === true) a.always = true;
    if (ALLOWED_MODES.has(cmd.mode)) a.mode = cmd.mode;
    const answers = cleanAnswers(cmd.answers);
    if (answers) a.answers = answers;
  } else {
    const msg = typeof cmd.message === "string" ? cmd.message.trim().slice(0, 2000) : "";
    if (msg) a.message = msg;
    if (cmd.interrupt === true) a.interrupt = true;
  }
  return { id, a };
}
