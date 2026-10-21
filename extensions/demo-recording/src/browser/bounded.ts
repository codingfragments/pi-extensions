/**
 * Short-lived browsers (the login probe, brand previews, overlay rendering, the login window) that must not outlive a frozen Chromium: every launch carries a process
 * marker, closing is bounded and then forced, and `withBrowser` puts a deadline on the whole job and diagnoses what it left behind.
 */

import type { Browser } from "playwright";
import { CallStalledError, withDeadline } from "../discovery/watchdog.ts";
import { diagnoseStuck } from "../util/bounded.ts";
import { fmtProcesses } from "./diagnosis.ts";
import { MARKER_FLAG, killMarker, newMarker, processesOf } from "./processes.ts";

export interface BoundedBrowser {
  browser: Browser;
  marker: string;
  /** Close it (5 s), then kill what is left of it. Safe to call twice. */
  close: () => Promise<void>;
}

export async function launchBounded(o: { headless?: boolean } = {}): Promise<BoundedBrowser> {
  const { chromium } = await import("playwright");
  const marker = newMarker();
  const browser = await chromium.launch({
    headless: o.headless !== false,
    args: [`${MARKER_FLAG}${marker}`],
  });
  let closed = false;
  return {
    browser,
    marker,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.race([
        browser.close().catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);
      killMarker(marker);
    },
  };
}

/** Run `fn` with a browser and a deadline (default 2 min); a job that does not finish is diagnosed, the browser killed, and the error says so. */
export async function withBrowser<T>(
  label: string,
  fn: (browser: Browser) => Promise<T>,
  o: { headless?: boolean; deadlineMs?: number } = {},
): Promise<T> {
  const b = await launchBounded(o);
  try {
    return await withDeadline(label, o.deadlineMs ?? 120_000, () => fn(b.browser));
  } catch (err) {
    if (err instanceof CallStalledError) {
      const rows = processesOf(b.marker);
      const file = await diagnoseStuck({
        label,
        cmd: "chromium",
        args: [],
        pid: rows[0]?.pid ?? 0,
        ranMs: err.afterMs,
        limitMs: err.afterMs,
        reason: "timeout",
        stderrTail: fmtProcesses(rows),
      });
      throw new Error(
        `${err.message}: the browser did not answer and was killed${file ? ` (diagnosis: ${file})` : ""}`,
      );
    }
    throw err;
  } finally {
    await b.close();
  }
}
