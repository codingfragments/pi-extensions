// The pure part of the discovery panel (item 10, D3): when a session looks stalled, and how an area's measured state reads.
// No browser imports, so tests can load it.

/** No look, action or plan change for this long while a session is open: say so (the Director may only be thinking). */
export const STALL_MS = 90_000;
/** The Director's turn ended while the session is still open: a short grace, then say so. */
export const SETTLED_GRACE_MS = 15_000;

const ACTIVITY = new Set([
  "discovery.opened",
  "discovery.look",
  "discovery.act",
  "discovery.progress",
]);

/**
 * null while things move, else { kind: "quiet" | "director-stopped", sinceMs }. A session is open from `discovery.opened` to
 * `discovery.closed`; "quiet" is no discovery activity for STALL_MS; "director-stopped" is the Director's run settled after the
 * last activity and the session is still open (nothing will move it).
 */
export function stallOf(events, now = Date.now()) {
  let open = false;
  let lastAt = null;
  let settledAt = null;
  for (const e of events) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    if (e.type === "discovery.opened") {
      open = true;
      settledAt = null;
    } else if (e.type === "discovery.closed") open = false;
    else if (e.type === "director.started") settledAt = null;
    else if (e.type === "director.settled") settledAt = at;
    if (ACTIVITY.has(e.type)) lastAt = at;
  }
  if (!open || lastAt === null) return null;
  if (settledAt !== null && settledAt >= lastAt && now - settledAt >= SETTLED_GRACE_MS)
    return { kind: "director-stopped", sinceMs: now - settledAt };
  if (now - lastAt >= STALL_MS) return { kind: "quiet", sinceMs: now - lastAt };
  return null;
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** The words for a stall. */
export function stallWords(s) {
  return s.kind === "director-stopped"
    ? `The Director has stopped, but the discovery session is still open (${minutes(s.sinceMs)} min). Nothing will move it until you ask it to continue.`
    : `No activity for ${minutes(s.sinceMs)} min. The Director may be thinking, or it may have lost the thread.`;
}

/** How an area reads: [tone, icon, word]. Never colour alone. */
export const AREA_WORDS = {
  done: ["ok", "✓", "seen and done"],
  "done-empty": ["warn", "!", "marked done, nothing seen"],
  current: ["info", "◔", "in hand"],
  seen: ["info", "●", "seen"],
  todo: ["neutral", "○", "not yet"],
  dropped: ["neutral", "–", "left out"],
};

/**
 * One segment per declared area, from what the engine MEASURED there (D3): done and seen is full, done with nothing seen is dashed and says so,
 * seen is part filled, the one in hand is outlined, a dropped area is dimmed and says it was left out. The words are in the label and the
 * title (counts), never the colour alone.
 */
export function areaSegment(a, weight) {
  const n = (a.looks ?? 0) + (a.acts ?? 0);
  const counts =
    a.looks === undefined
      ? ""
      : ` · ${a.looks} look${a.looks === 1 ? "" : "s"}, ${a.acts} action${a.acts === 1 ? "" : "s"}`;
  const base = { key: a.name, weight, title: `${a.name}${counts}` };
  switch (a.status) {
    case "done":
      return { ...base, label: a.name, done: 1, state: "done" };
    case "done-empty":
      return {
        ...base,
        label: `${a.name} (marked done, nothing seen)`,
        title: `${a.name}: marked done, but nothing was seen there`,
        done: 0,
        state: "todo",
        restarted: true,
      };
    case "dropped":
      return { ...base, label: `${a.name} (left out)`, done: 0, state: "dropped" };
    case "current":
      return { ...base, label: a.name, done: Math.min(0.9, n / 12), state: "current" };
    case "seen":
      return { ...base, label: a.name, done: Math.min(0.9, Math.max(0.2, n / 12)), state: "seen" };
    default:
      return { ...base, label: a.name, done: 0, state: "todo" };
  }
}
