/**
 * The one place a Chromium is started. Under Bun (pi is a Bun executable) Playwright's launch can fail at random with
 *
 *     error: Failed to connect, syscall "connect", errno -2, code "ENOENT"   at #createStdioObject ← spawn ← launchProcess
 *
 * a known Bun bug (oven-sh/bun#34785: intermittent, on browser recycling under load). It never failed in 100+ launches of a plain script, so what triggers it inside pi is
 * not known; what is known is that it is transient. So every launch here is:
 *   - serialized (one launch at a time) with a short gap after a browser was closed or killed: the recycling is where it happens;
 *   - retried a few times on exactly that error, and on nothing else (a missing browser, a bad flag fail at once);
 *   - written down (`<root>/diagnostics/launches.jsonl`: when, how long, which try, how many browsers were open, the temp folder's size on a failure), so the next
 *     failure comes with evidence instead of a stack trace.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, LaunchOptions } from "playwright";
import { diagnosticsDir } from "../util/bounded.ts";

/** The gap, in ms, between a browser being closed or killed and the next launch. */
export const LAUNCH_GAP_MS = 150;
/** Tries per launch (the first one included) and the pauses between them. */
export const LAUNCH_TRIES = 3;
export const RETRY_PAUSE_MS = [250, 750];

/** Is this the Bun spawn race (and not a real launch failure)? Judged by its message, its code and where it was thrown. */
export function isBunSpawnRace(err: unknown): boolean {
  const e = err as
    | { message?: string; code?: string; syscall?: string; stack?: string }
    | undefined;
  if (!e) return false;
  const message = e.message ?? "";
  const connect =
    (e.syscall === "connect" && e.code === "ENOENT") ||
    /(^|\n)\s*(error: )?Failed to connect\s*($|\n)/i.test(message);
  return (
    connect && /createStdioObject|launchProcess|child_process/i.test(`${message}\n${e.stack ?? ""}`)
  );
}

type Launcher = (o: LaunchOptions) => Promise<Browser>;

let chain: Promise<unknown> = Promise.resolve();
let lastClosedAt = 0;
let open = 0;
let sweptOnce = false;

/** Tell the launcher that a browser went away (closed or killed): the next launch waits LAUNCH_GAP_MS. */
export function noteBrowserClosed(): void {
  lastClosedAt = Date.now();
}

/** How many browsers started here are still open (for the log and for tests). */
export const openBrowsers = () => open;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function log(rec: Record<string, unknown>): void {
  try {
    fs.mkdirSync(diagnosticsDir(), { recursive: true });
    fs.appendFileSync(
      path.join(diagnosticsDir(), "launches.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, open, ...rec })}\n`,
    );
  } catch {
    // the log must never be what breaks a launch
  }
}

const tmpEntries = (): number => {
  try {
    return fs.readdirSync(os.tmpdir()).length;
  } catch {
    return -1;
  }
};

/**
 * Launch Chromium through Playwright, one at a time, retrying the Bun spawn race. `label` says who asks (for the log). `launcher` is for tests.
 */
export function launchChromium(
  options: LaunchOptions,
  label = "browser",
  launcher?: Launcher,
): Promise<Browser> {
  const run = async (): Promise<Browser> => {
    const launch: Launcher =
      launcher ??
      (async (o) => {
        const { chromium } = await import("playwright");
        return chromium.launch(o);
      });
    if (!sweptOnce && !launcher) {
      sweptOnce = true;
      void import("../util/janitor.ts").then((j) => j.sweepOwnTemp()).catch(() => undefined);
    }
    const wait = LAUNCH_GAP_MS - (Date.now() - lastClosedAt);
    if (wait > 0) await sleep(wait);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= LAUNCH_TRIES; attempt++) {
      const t = Date.now();
      try {
        const browser = await launch(options);
        open++;
        browser.on("disconnected", () => {
          open = Math.max(0, open - 1);
          noteBrowserClosed();
        });
        log({ label, ok: true, ms: Date.now() - t, attempt });
        return browser;
      } catch (err) {
        lastErr = err;
        const race = isBunSpawnRace(err);
        log({
          label,
          ok: false,
          ms: Date.now() - t,
          attempt,
          race,
          error: String((err as Error).message ?? err).split("\n")[0],
          tmpEntries: tmpEntries(),
        });
        if (!race || attempt === LAUNCH_TRIES) break;
        await sleep(RETRY_PAUSE_MS[attempt - 1] ?? 750);
      }
    }
    if (isBunSpawnRace(lastErr))
      throw new Error(
        `the browser could not be started after ${LAUNCH_TRIES} tries (${label}): Bun failed to connect the browser's pipes (ENOENT in child_process, oven-sh/bun#34785). It is transient: try the action again; if it keeps happening, restart pi. What led up to it is in ${path.join(diagnosticsDir(), "launches.jsonl")}.`,
        { cause: lastErr },
      );
    throw lastErr;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}
