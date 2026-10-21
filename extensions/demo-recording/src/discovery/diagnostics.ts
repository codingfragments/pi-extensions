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
import { type ProcRow, processesOf, sampleProcess } from "../browser/processes.ts";

export const diagDir = (sessionDir: string) => path.join(sessionDir, "diagnostics");

const fmtRows = (rows: ProcRow[]) =>
  rows
    .map(
      (r) =>
        `${String(r.pid).padStart(6)} ${String(r.ppid).padStart(6)} ${r.stat.padEnd(4)} cpu ${String(r.cpu).padStart(5)}% rss ${String(r.rssMb).padStart(5)} MB up ${r.etime.padEnd(10)} ${r.command.slice(0, 140)}`,
    )
    .join("\n");

/** Chromium switches of the deep log. */
export const deepLogArgs = (sessionDir: string): string[] => [
  "--enable-logging",
  "--v=1",
  `--log-file=${path.join(diagDir(sessionDir), "chromium.log")}`,
];

/** The short diagnosis of a stall: the processes and, where possible, their native stacks. Never throws. Returns the files written. */
export async function diagnoseStall(
  sessionDir: string,
  marker: string,
  n: number,
  note: string,
): Promise<string[]> {
  const dir = diagDir(sessionDir);
  const files: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rows = processesOf(marker);
    const ps = path.join(dir, `stall-${n}.ps.txt`);
    fs.writeFileSync(
      ps,
      `${new Date().toISOString()} ${note}\n\n${fmtRows(rows) || "(no processes found for this browser)"}\n`,
    );
    files.push(ps);
    // the browser process and the busiest others: three seconds each, in parallel
    const pick = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, 4);
    const main = rows.find(
      (r) => r.command.includes("--remote-debugging-pipe") && !r.command.includes("--type="),
    );
    if (main && !pick.some((r) => r.pid === main.pid)) pick.unshift(main);
    const done = await Promise.all(
      pick.map(async (r) => {
        const f = path.join(dir, `stall-${n}.${r.pid}.sample.txt`);
        return (await sampleProcess(r.pid, 3, f)) ? f : undefined;
      }),
    );
    for (const f of done) if (f) files.push(f);
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
        `--- ${new Date().toISOString()}\n${fmtRows(processesOf(getMarker()))}\n`,
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
