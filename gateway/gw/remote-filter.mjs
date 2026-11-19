// Pure routing helpers for the remote bridge: which session an event belongs
// to, and whether a peer that watches one session should receive it.
//
// Kept free of imports so the remote test suite can load it without the
// gateway runtime (usage.mjs and friends touch process.getuid and start
// background work on import).

/** Session an event belongs to, or null when it can't be told.
 *  Events carry `sessionId` only at the ends of a run; the middle of a run is
 *  tagged with `runId`, so the caller passes the live run list for mapping. */
export function eventSessionOf(ev, runs = []) {
  if (!ev || typeof ev !== "object") return null;
  if (typeof ev.sessionId === "string" && ev.sessionId) return ev.sessionId;
  if (ev.type === "session_gone" && typeof ev.id === "string" && ev.id) return ev.id;
  if (ev.runId && Array.isArray(runs)) {
    const r = runs.find((x) => x && x.id === ev.runId);
    if (r && typeof r.sessionId === "string" && r.sessionId) return r.sessionId;
  }
  return null;
}

/** Fail-open: forward when there is no filter or the origin is unknown.
 *  A brand-new session has no sessionId until its run reports init — strict
 *  filtering would hide the very turn the user just started. */
export function wantsEvent(watch, sid) {
  if (!watch || !sid) return true;
  return watch === sid;
}
