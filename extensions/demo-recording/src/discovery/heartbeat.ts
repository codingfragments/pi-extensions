/**
 * The discovery heartbeat: while a session is open and nothing else has been said for a while, say that it is still alive, how long since the last step, what
 * that step was, and what the Director is doing. Between two looks the Director is waiting for a model call that can take a minute; without this the log, the
 * bar and the drawer are silent for all of it and a working session looks stuck.
 *
 * Pure (no timers, no browser): the session owns the timer, this file owns the words.
 */

/** The default beat: one message at least this often while the session is quiet. */
export const HEARTBEAT_DEFAULT_SEC = 30;

/** "45 s", "1 min 15 s", "3 min". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

export type DirectorState = "working" | "settled" | "unknown";

export interface HeartbeatFacts {
  /** Ms since the last look, action or plan change (or since the session opened). */
  sinceStepMs: number;
  /** What that step was, in the log's words ("look 14 “Orders” · /orders"); empty before the first. */
  lastStep: string;
  screens: string;
  actions: string;
  /** The area in hand, when the Director declared a plan. */
  area?: string;
  /** A browser call that is running now and has not answered yet. */
  inFlight?: { call: string; ms: number; deadlineMs: number };
  director: DirectorState;
}

/** One line, plain: what is known and nothing guessed. */
export function heartbeatMessage(f: HeartbeatFacts): string {
  // a browser call that has not answered is the news, not the Director
  if (f.inFlight && f.inFlight.ms >= 8000) {
    const w = f.inFlight;
    return [
      `⏳ ${w.call} has been running for ${formatAge(w.ms)} and the browser has not answered${w.deadlineMs > 0 ? ` (the browser is restarted after ${formatAge(w.deadlineMs)})` : ""}`,
      `${f.screens} screens, ${f.actions} actions`,
      ...(f.area ? [`area in hand: ${f.area}`] : []),
    ].join(" · ");
  }
  const parts = [
    f.lastStep
      ? `⏳ still here · ${formatAge(f.sinceStepMs)} since the last step (${f.lastStep})`
      : `⏳ still here · ${formatAge(f.sinceStepMs)} since the session opened, no step yet`,
    `${f.screens} screens, ${f.actions} actions`,
  ];
  if (f.area) parts.push(`area in hand: ${f.area}`);
  if (f.director === "working") parts.push("the Director is working on the next step");
  else if (f.director === "settled")
    parts.push("the Director has stopped, the session is still open");
  return parts.join(" · ");
}

/** How long to wait before the next look at the clock: until a beat is due, never a busy loop. */
export function nextBeatDelay(now: number, lastSaidAt: number, beatMs: number): number {
  return Math.max(50, lastSaidAt + beatMs - now);
}
