/**
 * What a discovery session leaves behind to explain a frozen browser (`<session>/diagnostics/`, `<session>/calls.jsonl`):
 *   calls.jsonl            every browser call: what, when, how long, how it ended (always; small)
 *   stall-N.ps.txt         the browser's processes (state, CPU, memory) at the moment a call stalled (always)
 *   stall-N.<pid>.sample.txt  macOS `sample` of each of them: the native stacks, which say where a frozen process is stuck (always, where `sample` exists)
 *   page.log               console errors, page errors, dialogs, crashes, failed requests (deep log only: discovery.browserLog)
 *   ps.log                 the processes every 2 s (deep log only)
 *   chromium.log           Chromium's own log, --v=1 (deep log only)
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  type ProbeTarget,
  fmtProcesses,
  probeBrowser,
  runtimeFacts,
  sampleBrowser,
  verdictOf,
} from "../browser/diagnosis.ts";
import { processesOf } from "../browser/processes.ts";

export const diagDir = (sessionDir: string) => path.join(sessionDir, "diagnostics");

/** Chromium switches of the deep log. */
export const deepLogArgs = (sessionDir: string): string[] => [
  "--enable-logging",
  "--v=1",
  `--log-file=${path.join(diagDir(sessionDir), "chromium.log")}`,
];

/**
 * The diagnosis of a stall, before the browser is killed: what answers and what does not (`stall-N.probes.json`, with a verdict that says where it is stuck), the
 * processes, the page as far as it still answers (screenshot, aria), and where possible the native stacks. Never throws. Returns the files written.
 */
export async function diagnoseStall(
  sessionDir: string,
  marker: string,
  n: number,
  note: string,
  target?: ProbeTarget,
): Promise<string[]> {
  const dir = diagDir(sessionDir);
  const files: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    // the processes and their stacks are taken while the probes run: both are slow when the browser is stuck
    const [probes, samples] = await Promise.all([
      target
        ? probeBrowser(target, { filesDir: path.join(dir, `stall-${n}`) })
        : Promise.resolve([]),
      sampleBrowser(marker, dir, `stall-${n}`),
    ]);
    const rows = processesOf(marker);
    const ps = path.join(dir, `stall-${n}.ps.txt`);
    fs.writeFileSync(
      ps,
      `${new Date().toISOString()} ${note}\n${probes.length ? `verdict: ${verdictOf(probes)}\n` : ""}\n${fmtProcesses(rows)}\n\nmachine: ${JSON.stringify(runtimeFacts())}\n`,
    );
    files.push(ps, ...samples);
    if (probes.length) {
      const pf = path.join(dir, `stall-${n}.probes.json`);
      fs.writeFileSync(pf, `${JSON.stringify({ verdict: verdictOf(probes), probes }, null, 2)}\n`);
      files.push(pf);
    }
  } catch {
    // a diagnosis must never be what breaks the recovery
  }
  return files;
}

/** The deep log's process sampler: one block every `everyMs`. Returns the stop function. */
export function startProcessSampler(
  sessionDir: string,
  getMarker: () => string,
  everyMs = 2000,
): () => void {
  const dir = diagDir(sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  const t = setInterval(() => {
    try {
      fs.appendFileSync(
        path.join(dir, "ps.log"),
        `--- ${new Date().toISOString()}\n${fmtProcesses(processesOf(getMarker()))}\n`,
      );
    } catch {
      // ignore
    }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** The page events worth keeping: crashes and dialogs always; console errors and failed requests in the deep log. */
export function attachPageLog(
  page: Page,
  sessionDir: string,
  deep: boolean,
  say: (m: string) => void,
): void {
  const dir = diagDir(sessionDir);
  const line = (kind: string, text: string) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "page.log"),
        `${new Date().toISOString()} ${kind} ${text.replace(/\s+/g, " ").slice(0, 400)}\n`,
      );
    } catch {
      // ignore
    }
  };
  page.on("crash", () => {
    line("CRASH", page.url());
    say(`the page crashed (${page.url()})`);
  });
  page.on("dialog", (d) => {
    line("DIALOG", `${d.type()} ${d.message()}`);
    say(`the page opened a ${d.type()} dialog: ${d.message().slice(0, 80)}`);
  });
  if (!deep) return;
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") line(`console.${m.type()}`, m.text());
  });
  page.on("pageerror", (e) => line("pageerror", e.message));
  page.on("requestfailed", (r) =>
    line("requestfailed", `${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ""}`),
  );
}
