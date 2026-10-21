/**
 * Child processes (ffmpeg, uv/Python, say) and short-lived browsers with a deadline. A child that stops making progress holds a job (an edit, a render, the voice) for
 * ever, and the job's own cancel cannot reach into it. Here a child that outlives its deadline is DIAGNOSED (its command, how long it ran, its process tree, the last
 * of its output, and on macOS its native stacks, into `<root>/diagnostics/`), then killed with everything below it, and the caller gets an error that says so.
 *
 * Generous defaults (an encode of a long take is slow on purpose): the point is that nothing waits for ever, not that nothing is slow. Config `media.toolTimeoutMin`.
 */

import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeFacts } from "../browser/diagnosis.ts";

/** The event a child process raises when it fails (a Node event, not one of the panel's bus events). */
const CHILD_ERROR = "error";

let diagDir = path.join(os.tmpdir(), "demo-rec-diagnostics");
let toolMinutes = 30;

/** Where diagnoses of stuck children and browsers go (the working folder's `diagnostics/`). */
export function setDiagnosticsDir(dir: string): void {
  diagDir = dir;
}
export const diagnosticsDir = () => diagDir;

/** The deadline of ffmpeg and uv in minutes (0 = none). Set from the config. */
export function setToolTimeoutMin(min: number): void {
  toolMinutes = Math.max(0, min);
}

/** The deadline for a command, in ms (0 = none): short for a probe, the configured one for the heavy tools. */
export function defaultTimeoutMs(cmd: string): number {
  const name = path.basename(cmd);
  if (name === "ffprobe") return 60_000;
  if (name === "ffmpeg" || name === "uv") return toolMinutes * 60_000;
  if (name === "say") return 10 * 60_000;
  return 10 * 60_000;
}

export class BoundedRunError extends Error {
  readonly timedOut: boolean;
  readonly diagnosis?: string;
  constructor(message: string, timedOut: boolean, diagnosis?: string) {
    super(message);
    this.timedOut = timedOut;
    if (diagnosis) this.diagnosis = diagnosis;
  }
}

/** The pid and everything below it, deepest first. */
export function descendants(pid: number): number[] {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
    const kids = new Map<number, number[]>();
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)/.exec(line);
      if (!m) continue;
      const list = kids.get(Number(m[2])) ?? [];
      list.push(Number(m[1]));
      kids.set(Number(m[2]), list);
    }
    const order: number[] = [];
    const walk = (p: number) => {
      for (const c of kids.get(p) ?? []) walk(c);
      order.push(p);
    };
    walk(pid);
    return order;
  } catch {
    return [pid];
  }
}

export function killTree(pid: number): void {
  for (const p of descendants(pid)) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // gone already
    }
  }
}

const sampleOf = (pid: number, file: string) =>
  new Promise<boolean>((resolve) => {
    if (process.platform !== "darwin") return resolve(false);
    execFile("sample", [String(pid), "2", "-file", file], { timeout: 12_000 }, (e) => resolve(!e));
  });

export interface StuckInfo {
  label: string;
  cmd: string;
  args: string[];
  cwd?: string;
  pid: number;
  ranMs: number;
  limitMs: number;
  reason: "timeout" | "aborted";
  stderrTail: string;
}

/** Write down what is known about a stuck child before it is killed. Returns the file, relative to the diagnostics folder's parent. Never throws. */
export async function diagnoseStuck(info: StuckInfo): Promise<string | undefined> {
  try {
    fs.mkdirSync(diagDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(diagDir, `process-${stamp}-${path.basename(info.cmd)}.txt`);
    const tree = info.pid > 0 ? descendants(info.pid) : [];
    let ps = "(no process to look at)";
    if (tree.length)
      try {
        ps = execFileSync(
          "ps",
          ["-wwo", "pid=,ppid=,stat=,pcpu=,rss=,etime=,command=", "-p", tree.join(",")],
          { encoding: "utf8" },
        );
      } catch {
        ps = "(the process is gone)";
      }
    const sample = path.join(diagDir, `process-${stamp}-${info.pid}.sample.txt`);
    const sampled = info.pid > 0 ? await sampleOf(info.pid, sample) : false;
    fs.writeFileSync(
      file,
      [
        `${info.reason === "timeout" ? "STUCK" : "ABORTED"}: ${info.label}`,
        `command: ${info.cmd} ${info.args.join(" ").slice(0, 600)}`,
        info.cwd ? `cwd: ${info.cwd}` : "",
        `ran ${(info.ranMs / 1000).toFixed(1)} s${info.limitMs ? `, limit ${(info.limitMs / 1000).toFixed(0)} s` : ""}`,
        `process tree (pid ppid stat cpu% rssKB etime command):\n${ps.trim()}`,
        sampled ? `native stacks: ${path.basename(sample)}` : "native stacks: not available",
        `last of its output:\n${info.stderrTail.slice(-1500) || "(none)"}`,
        `machine: ${JSON.stringify(runtimeFacts())}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Watch a spawned child: past `timeoutMs` (0 = never) or when `signal` aborts, diagnose it, kill it and its tree, and emit an "error" on it with a BoundedRunError (the
 * callers' own `child.on("error", reject)` turns that into a rejection). Returns the function that stops the watch (call it when the child has closed).
 */
export function guardChild(
  child: ChildProcess,
  o: {
    label: string;
    cmd: string;
    args: string[];
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    stderrTail: () => string;
  },
): () => void {
  const started = Date.now();
  let done = false;
  const stop = async (reason: "timeout" | "aborted") => {
    if (done || !child.pid) return;
    done = true;
    const info: StuckInfo = {
      label: o.label,
      cmd: o.cmd,
      args: o.args,
      pid: child.pid,
      ranMs: Date.now() - started,
      limitMs: o.timeoutMs,
      reason,
      stderrTail: o.stderrTail(),
      ...(o.cwd ? { cwd: o.cwd } : {}),
    };
    const file = reason === "timeout" ? await diagnoseStuck(info) : undefined;
    killTree(child.pid);
    const why =
      reason === "timeout"
        ? `${o.label} did not finish within ${Math.round(o.timeoutMs / 60_000) >= 1 ? `${Math.round(o.timeoutMs / 60_000)} min` : `${Math.round(o.timeoutMs / 1000)} s`} and was killed${file ? ` (diagnosis: ${file})` : ""}`
        : `${o.label} was cancelled`;
    const tail = info.stderrTail.trim().split("\n").slice(-4).join("\n");
    child.emit(
      CHILD_ERROR,
      new BoundedRunError(
        `${why}${tail ? `\nlast output:\n${tail}` : ""}`,
        reason === "timeout",
        file,
      ),
    );
  };
  const timer = o.timeoutMs > 0 ? setTimeout(() => void stop("timeout"), o.timeoutMs) : undefined;
  timer?.unref?.();
  const onAbort = () => void stop("aborted");
  if (o.signal) {
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener("abort", onAbort, { once: true });
  }
  return () => {
    done = true;
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  };
}
