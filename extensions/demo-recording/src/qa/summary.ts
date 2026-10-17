/**
 * The QA summary of a list of items, and the reading of reports written before the severity change (P1a Q1a).
 * Kept apart from the checks so the render store can use it without pulling them in.
 */

import type { QaItem, QaReport, QaSummary } from "./types.ts";

export function summarize(items: QaItem[], ranAt = new Date().toISOString()): QaSummary {
  const blocking = items.filter((i) => i.level === "blocking");
  const confirmed = blocking.filter((i) => i.confirmed).length;
  return {
    status:
      blocking.length === 0 ? "pass" : confirmed === blocking.length ? "confirmed" : "blocked",
    blocking: blocking.length,
    confirmed,
    high: items.filter((i) => i.level === "warning" && i.high).length,
    warnings: items.filter((i) => i.level === "warning").length,
    info: items.filter((i) => i.level === "info").length,
    ranAt,
  };
}

/**
 * Reports written before Q1a called a wrong number, a toast in the footage or a narration far off its moment
 * `blocking`. Only integrity defects and redaction gaps are hard stops now, so those older items read as
 * warnings that need your eyes (their confirmations stay). The record's summary stays as it was until QA is re-run.
 */
export function legacyLevels(report: QaReport): QaReport {
  for (const it of report.items) {
    if (it.level !== "blocking" || it.hard) continue;
    if (it.check === "annotations" && /^redaction .* doesn't cover its element/.test(it.message)) {
      it.hard = "redaction";
      continue;
    }
    it.level = "warning";
    it.high = true;
  }
  return report;
}

/** True when the report was written before Q1a (an item the old rules called blocking is not a hard stop now). */
export function hasLegacyLevels(report: QaReport): boolean {
  return report.items.some(
    (it) =>
      it.level === "blocking" &&
      !it.hard &&
      !(it.check === "annotations" && /^redaction .* doesn't cover its element/.test(it.message)),
  );
}
