// The keys of the Recording tab (item 13c, R3-3, D146), as pure functions so a test can import them without the panel's modules.
//   [ ]      previous / next chapter          < >      previous / next finding of the take
//   ← →      back / forward 10 s (Shift: 1 s)  N or +   a note at this moment
// They work anywhere on the tab (the caller ignores typing, dialogs and modifier keys).

export const STEP_MS = 10_000;
export const FINE_STEP_MS = 1_000;
/** A finding "ahead" is later than this past the playhead, one "behind" is earlier than this before it: pressing < right after arriving goes to the one before. */
const AHEAD_MS = 400;
const BEHIND_MS = 800;

/** What a key does: { kind: "chapter" | "finding", d: -1 | 1 }, { kind: "seekBy", ms }, { kind: "note" }, or null. */
export function keyAction(key, shift = false) {
  if (key === "[" || key === "]") return { kind: "chapter", d: key === "]" ? 1 : -1 };
  if (key === "<" || key === ">") return { kind: "finding", d: key === ">" ? 1 : -1 };
  if (key === "ArrowLeft" || key === "ArrowRight")
    return {
      kind: "seekBy",
      ms: (key === "ArrowRight" ? 1 : -1) * (shift ? FINE_STEP_MS : STEP_MS),
    };
  if (key === "n" || key === "N" || key === "+") return { kind: "note" };
  return null;
}

/**
 * The places of a take's findings, in take order: what the storyboard meant the scene to show and what the take found there. A finding with a time is at
 * that time; one without (the planned ones) at the start of its scene; a finding named by both is one stop, at its time.
 */
export function findingStops(scenes) {
  const byId = new Map();
  for (const s of scenes ?? [])
    for (const [list, kind] of [
      [s.found ?? [], "found"],
      [s.planned ?? [], "planned"],
    ])
      for (const f of list) {
        const ms = f.t ?? s.startMs;
        const had = byId.get(f.id);
        if (!had || (had.timed === false && f.t !== undefined))
          byId.set(f.id, {
            id: f.id,
            ms,
            scene: s.id,
            kind,
            text: f.text,
            timed: f.t !== undefined,
          });
      }
  return [...byId.values()].sort((a, b) => a.ms - b.ms);
}

/** The next (d = 1) or previous (d = -1) stop from the playhead, or undefined when there is none. */
export function stopFrom(stops, ms, d) {
  if (d > 0) return stops.find((s) => s.ms > ms + AHEAD_MS);
  return [...stops].reverse().find((s) => s.ms < ms - BEHIND_MS);
}

/** The position after moving by `deltaMs`, kept inside the take. */
export function clampSeek(ms, deltaMs, durationMs) {
  const to = ms + deltaMs;
  return Math.max(0, Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, to) : to);
}
