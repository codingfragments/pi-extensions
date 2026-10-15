// Log view helpers (no imports, so tests can load this module in Node).

/** Events that end a progress run of their family ("take.finished" ends the "take.progress" run). */
const RUN_END = /\.(started|finished|opened|closed)$/;

const isProgress = (e) => e.type.endsWith(".progress");
const runKey = (e) => `${e.type}|${e.project ?? ""}|${e.data?.job ?? ""}`;

/**
 * Collapse progress ticks: of each run of the same progress type (same project
 * and job), only the newest tick stays, at its own place, carrying how many
 * ticks it stands for and when the run began (`ticks`, `firstAt`). A run ends
 * at the family's started/finished/opened/closed event, so the next job gets
 * a line of its own. Other events pass through unchanged.
 */
export function collapseProgress(events) {
  const out = [];
  /** run key → index in out of the run's current (newest) tick */
  const open = new Map();
  for (const e of events) {
    if (isProgress(e)) {
      const key = runKey(e);
      const at = open.get(key);
      if (at === undefined) {
        open.set(key, out.length);
        out.push({ ...e, ticks: 1, firstAt: e.at });
      } else {
        const prev = out[at];
        out[at] = null;
        open.set(key, out.length);
        out.push({ ...e, ticks: prev.ticks + 1, firstAt: prev.firstAt });
      }
      continue;
    }
    if (RUN_END.test(e.type)) {
      const family = `${e.type.split(".")[0]}.`;
      for (const k of [...open.keys()]) if (k.startsWith(family)) open.delete(k);
    }
    out.push(e);
  }
  return out.filter(Boolean);
}
