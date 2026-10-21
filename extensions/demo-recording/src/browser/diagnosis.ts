/**
 * Everything worth knowing about a browser that stopped answering, collected in a few seconds and in parallel, each probe with its own deadline so that the collecting
 * itself cannot hang. Which probes answer and which do not says WHERE it is stuck:
 *
 *   nothing answers                       → the browser process itself (stopped, deadlocked, out of memory)
 *   the browser answers, the page does not → the page's renderer is stuck (a script that never returns, a huge page)
 *   evaluate answers, the screenshot does not → compositing / the GPU path
 *   everything answers                    → the browser is fine: the step was waiting for something that never happened
 *
 * Used by recording (a step that did not finish, an interrupt, a failed scene) and discovery (a call that did not answer).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { type ProcRow, processesOf, sampleProcess } from "./processes.ts";

export interface ProbeResult {
  name: string;
  ok: boolean;
  ms: number;
  timedOut?: boolean;
  value?: unknown;
  error?: string;
}

/** A probe that cannot hold anything up: its answer, its failure or its deadline, whichever comes first. */
async function probe(name: string, ms: number, fn: () => Promise<unknown>): Promise<ProbeResult> {
  const t = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = fn().then(
    (value) =>
      ({
        name,
        ok: true,
        ms: Date.now() - t,
        ...(value === undefined ? {} : { value }),
      }) as ProbeResult,
    (err) =>
      ({
        name,
        ok: false,
        ms: Date.now() - t,
        error: String((err as Error).message ?? err).split("\n")[0],
      }) as ProbeResult,
  );
  const late = new Promise<ProbeResult>((res) => {
    timer = setTimeout(
      () => res({ name, ok: false, ms, timedOut: true, error: `no answer within ${ms} ms` }),
      ms,
    );
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ProbeTarget {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/** The page state the evaluate probe reads (a string: the engine's TypeScript has no DOM types). */
const PAGE_STATE = `(() => {
  const a = document.activeElement;
  const m = performance && performance.memory ? performance.memory : null;
  return {
    url: location.href, title: document.title, readyState: document.readyState, visibility: document.visibilityState,
    hasFocus: document.hasFocus(), scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight, nodes: document.getElementsByTagName("*").length,
    active: a ? (a.tagName + (a.id ? "#" + a.id : "") + " " + String(a.getAttribute && a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 60)) : null,
    busy: document.querySelectorAll('[aria-busy="true"],[role="progressbar"]').length,
    jsHeapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null,
  };
})()`;

export interface ProbeOptions {
  timeoutMs?: number;
  /** Write the screenshot and the aria snapshot here (a folder), when they answer. */
  filesDir?: string;
}

/** All the probes, in parallel. Never throws. */
export async function probeBrowser(t: ProbeTarget, o: ProbeOptions = {}): Promise<ProbeResult[]> {
  const ms = o.timeoutMs ?? 3000;
  const dir = o.filesDir;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const closed = (() => {
    try {
      return {
        connected: t.browser.isConnected(),
        pageClosed: t.page.isClosed(),
        url: t.page.url(),
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  })();
  const results = await Promise.all([
    probe("browser-cdp", ms, async () => {
      const s = await t.browser.newBrowserCDPSession();
      try {
        const v = (await s.send("Browser.getVersion")) as {
          product: string;
          userAgent: string;
          revision: string;
        };
        return { product: v.product, revision: v.revision };
      } finally {
        await s.detach().catch(() => undefined);
      }
    }),
    probe("page-metrics", ms, async () => {
      const s = await t.context.newCDPSession(t.page);
      try {
        const m = (await s.send("Performance.getMetrics")) as {
          metrics: { name: string; value: number }[];
        };
        const pick = (n: string) => m.metrics.find((x) => x.name === n)?.value;
        return {
          taskDurationS: pick("TaskDuration"),
          scriptDurationS: pick("ScriptDuration"),
          layoutDurationS: pick("LayoutDuration"),
          nodes: pick("Nodes"),
          jsHeapUsedMB: Math.round((pick("JSHeapUsedSize") ?? 0) / 1048576),
          listeners: pick("JSEventListeners"),
        };
      } finally {
        await s.detach().catch(() => undefined);
      }
    }),
    probe("page-evaluate", ms, () => t.page.evaluate(PAGE_STATE)),
    probe("screenshot", ms, async () => {
      const jpg = await t.page.screenshot({ type: "jpeg", quality: 60, timeout: ms });
      if (dir) fs.writeFileSync(path.join(dir, "page.jpg"), jpg);
      return { bytes: jpg.length };
    }),
    probe("aria", ms, async () => {
      const raw = await t.page.locator("body").ariaSnapshot({ timeout: ms });
      if (dir) fs.writeFileSync(path.join(dir, "aria.yaml"), raw);
      return { chars: raw.length };
    }),
  ]);
  return [{ name: "connection", ok: !("error" in closed), ms: 0, value: closed }, ...results];
}

/** Where it is stuck, in one sentence, from which probes answered. */
export function verdictOf(probes: ProbeResult[]): string {
  const by = (n: string) => probes.find((p) => p.name === n);
  const conn = by("connection")?.value as { connected?: boolean; pageClosed?: boolean } | undefined;
  if (conn && conn.connected === false)
    return "the browser is not connected any more (it exited or crashed)";
  if (conn?.pageClosed) return "the page is closed";
  const answered = (n: string) => by(n)?.ok === true;
  const cdp = answered("browser-cdp");
  const page = answered("page-evaluate") || answered("page-metrics");
  if (!probes.filter((p) => p.name !== "connection").some((p) => p.ok))
    return "nothing answers: the browser process itself is stuck (stopped, deadlocked, or out of memory)";
  if (cdp && !page)
    return "the browser answers but the page does not: the page's renderer is stuck (a script that never returns, or a page too heavy)";
  if (page && !answered("screenshot"))
    return "the page answers but cannot be screenshotted: the compositor or the GPU path is stuck";
  if (page && !answered("aria"))
    return "the page answers but its accessibility tree does not: the page is busy rebuilding itself";
  return "everything answers: the browser is fine, the step was waiting for something that did not happen";
}

/** Facts about this machine and this process that explain a slow or stuck browser. */
export function runtimeFacts(): Record<string, unknown> {
  const mem = process.memoryUsage();
  return {
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    node: process.version,
    cpus: os.cpus().length,
    loadAvg: os.loadavg().map((x) => +x.toFixed(2)),
    freeMemMB: Math.round(os.freemem() / 1048576),
    totalMemMB: Math.round(os.totalmem() / 1048576),
    uptimeH: +(os.uptime() / 3600).toFixed(1),
    processRssMB: Math.round(mem.rss / 1048576),
    processHeapMB: Math.round(mem.heapUsed / 1048576),
  };
}

export const fmtProcesses = (rows: ProcRow[]): string =>
  rows
    .map(
      (r) =>
        `${String(r.pid).padStart(6)} ${String(r.ppid).padStart(6)} ${r.stat.padEnd(4)} cpu ${String(r.cpu).padStart(5)}% rss ${String(r.rssMb).padStart(5)} MB up ${r.etime.padEnd(10)} ${r.command.slice(0, 160)}`,
    )
    .join("\n") || "(no processes found for this browser)";

/** `sample` of the browser process and the busiest others, in parallel (macOS). Returns the files written. */
export async function sampleBrowser(
  marker: string,
  dir: string,
  prefix: string,
  seconds = 3,
): Promise<string[]> {
  const rows = processesOf(marker);
  const main = rows.find(
    (r) => r.command.includes("--remote-debugging-pipe") && !r.command.includes("--type="),
  );
  const pick = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, 4);
  if (main && !pick.some((r) => r.pid === main.pid)) pick.unshift(main);
  const done = await Promise.all(
    pick.map(async (r) => {
      const f = path.join(dir, `${prefix}.${r.pid}.sample.txt`);
      return (await sampleProcess(r.pid, seconds, f)) ? f : undefined;
    }),
  );
  return done.filter((f): f is string => !!f);
}
