/**
 * One warm browser for the short jobs (overlay rendering, brand previews, brand assets: item 19, R3-19 and R3-22). A job used to launch its own Chromium: the
 * thumbnails of the Annotations tab launched one per still, one after the other, which is slow (a launch is 0.1 to 0.4 s, the first page of a browser another 0.7 s for
 * fonts) and is exactly the "browser recycling" the Bun spawn race happens on. Now the first job launches it and the next ones reuse it; it goes away after it was idle
 * for a while, after it served many jobs, when it stalls (killed and diagnosed, as before) or when it disconnects.
 *
 * A job gets `newPage` only (every page it opens is its own context, as `browser.newPage` always was) and every page it leaves open is closed when it ends, so one job
 * cannot leave anything behind for the next.
 */

import type { Browser, Page } from "playwright";
import { CallStalledError, withDeadline } from "../discovery/watchdog.ts";
import { diagnoseStuck } from "../util/bounded.ts";
import { type BoundedBrowser, launchBounded } from "./bounded.ts";
import { fmtProcesses } from "./diagnosis.ts";
import { processesOf } from "./processes.ts";

/** What a pooled job may use of the browser. */
export interface PageSource {
  newPage: Browser["newPage"];
}

/** A shared browser is closed after this long without a job. */
export const POOL_IDLE_MS = 45_000;
/** …and recycled (when no job is running) after this many jobs: a long-lived Chromium grows. */
export const POOL_MAX_JOBS = 200;

interface Shared {
  b: BoundedBrowser;
  jobs: number;
  active: number;
  idle?: ReturnType<typeof setTimeout>;
}

let shared: Shared | undefined;
let starting: Promise<Shared> | undefined;
const stats = { launches: 0, reuses: 0, jobs: 0, recycled: 0, discarded: 0 };
// under `node --test` a warm browser would keep the test process alive for the whole idle time: a test process lets it go almost at once
let idleMs = process.env.NODE_TEST_CONTEXT ? 250 : POOL_IDLE_MS;

/** What the pool did (for tests and the log). */
export const poolStats = () => ({ ...stats, open: shared ? 1 : 0, active: shared?.active ?? 0 });

let maxJobs = POOL_MAX_JOBS;
/** For tests: recycle after fewer jobs. */
export const setPoolMaxJobs = (n: number) => {
  maxJobs = n;
};

/** For tests: a shorter idle time. */
export const setPoolIdleMs = (ms: number) => {
  idleMs = ms;
};

async function discard(s: Shared | undefined): Promise<void> {
  if (!s) return;
  if (shared === s) shared = undefined;
  if (s.idle) clearTimeout(s.idle);
  stats.discarded++;
  await s.b.close().catch(() => undefined);
}

async function acquire(headless: boolean): Promise<Shared> {
  if (
    shared &&
    (!shared.b.browser.isConnected() || (shared.active === 0 && shared.jobs >= maxJobs))
  ) {
    if (shared.b.browser.isConnected()) stats.recycled++;
    await discard(shared);
  }
  if (shared) {
    if (shared.idle) clearTimeout(shared.idle);
    shared.idle = undefined;
    stats.reuses++;
    return shared;
  }
  // a second job that arrives while the first one launches waits for that launch
  starting ??= launchBounded({ headless })
    .then((b) => {
      const s: Shared = { b, jobs: 0, active: 0 };
      shared = s;
      stats.launches++;
      return s;
    })
    .finally(() => {
      starting = undefined;
    });
  const s = await starting;
  if (s.idle) clearTimeout(s.idle);
  s.idle = undefined;
  return s;
}

function release(s: Shared): void {
  s.active--;
  if (s.active > 0 || shared !== s) return;
  s.idle = setTimeout(() => {
    if (shared === s && s.active === 0) void discard(s);
  }, idleMs);
  s.idle.unref?.();
}

/** Close the shared browser now (pi is shutting down, or a test wants a clean slate). */
export async function closePool(): Promise<void> {
  const s = shared ?? (await starting?.catch(() => undefined));
  await discard(s);
}

/**
 * Run `fn` on the shared browser under a deadline (default 2 min). A job that does not finish is diagnosed and the browser killed (the next job starts a new one); the pages
 * the job opened are closed when it ends, however it ends.
 */
export async function withPooledPages<T>(
  label: string,
  fn: (pages: PageSource) => Promise<T>,
  o: { deadlineMs?: number } = {},
): Promise<T> {
  const s = await acquire(true);
  s.active++;
  s.jobs++;
  stats.jobs++;
  const mine = new Set<Page>();
  const pages: PageSource = {
    newPage: async (opts) => {
      const page = await s.b.browser.newPage(opts);
      mine.add(page);
      page.once("close", () => mine.delete(page));
      return page;
    },
  };
  try {
    return await withDeadline(label, o.deadlineMs ?? 120_000, () => fn(pages));
  } catch (err) {
    if (err instanceof CallStalledError) {
      const rows = processesOf(s.b.marker);
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
      await discard(s);
      throw new Error(
        `${err.message}: the browser did not answer and was killed${file ? ` (diagnosis: ${file})` : ""}`,
      );
    }
    // a browser that went away under the job is not reused
    if (!s.b.browser.isConnected()) await discard(s);
    throw err;
  } finally {
    await Promise.all([...mine].map((p) => p.close().catch(() => undefined)));
    release(s);
  }
}
