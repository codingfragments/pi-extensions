/**
 * Helpers for bus event payloads (log cleanup): the log line shows `message`
 * (one short line); the panel's event popup shows everything in `data` — so
 * context goes into structured fields, not into a longer message.
 */

import type { Job } from "../jobs.ts";

/** Longest text kept in an event (agent messages, notes): ~4 KB, then "…". */
export const MAX_EVENT_TEXT = 4096;

export const capText = (s: string, max = MAX_EVENT_TEXT) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

export const firstLine = (s: string) => s.split("\n")[0] ?? "";

/** Duration and (on failure) the full error of a finished background job. */
export function jobFacts(
  j: Pick<Job, "id" | "startedAt" | "finishedAt" | "status" | "error">,
): Record<string, unknown> {
  return {
    job: j.id,
    status: j.status,
    durationMs: (j.finishedAt ?? Date.now()) - j.startedAt,
    ...(j.error ? { error: j.error } : {}),
  };
}

export const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
