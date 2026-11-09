/**
 * Finding and killing the processes of one browser we launched. Every launch carries a marker argument (`--demo-rec-session=<marker>`; Chromium ignores a switch
 * it does not know), so the processes of one session are found by their command line, and a frozen browser can be killed without touching anyone else's Chrome.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MARKER_FLAG = "--demo-rec-session=";

/** A fresh marker for one browser launch. */
export const newMarker = (): string =>
  `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface ProcRow {
  pid: number;
  ppid: number;
  stat: string;
  cpu: number;
  rssMb: number;
  etime: string;
  command: string;
}

/** The processes whose command line carries the marker (the browser; its helpers inherit the user-data-dir, so they are found by their parent too). */
export function processesOf(marker: string): ProcRow[] {
  try {
    const out = execFileSync("ps", ["-wwAo", "pid=,ppid=,stat=,pcpu=,rss=,etime=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const rows: ProcRow[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        stat: m[3] as string,
        cpu: Number(m[4]),
        rssMb: Math.round(Number(m[5]) / 1024),
        etime: m[6] as string,
        command: m[7] as string,
      });
    }
    const roots = new Set(
      rows.filter((r) => r.command.includes(`${MARKER_FLAG}${marker}`)).map((r) => r.pid),
    );
    if (!roots.size) return [];
    // the browser process and everything below it
    const found = new Map<number, ProcRow>();
    const add = (pid: number) => {
      for (const r of rows)
        if (r.pid === pid && !found.has(r.pid)) {
          found.set(r.pid, r);
          for (const c of rows) if (c.ppid === pid) add(c.pid);
        }
    };
    for (const pid of roots) add(pid);
    return [...found.values()];
  } catch {
    return [];
  }
}

/** The profile folders (`--user-data-dir`) a browser's processes were started with. */
export function userDataDirsOf(rows: ProcRow[]): string[] {
  const dirs = new Set<string>();
  for (const r of rows) {
    const m = /--user-data-dir=(\S+)/.exec(r.command);
    if (m?.[1]) dirs.add(m[1]);
  }
  return [...dirs];
}

/** A profile folder Playwright made for a throwaway browser (its own name, in the temp folder): the only kind that is removed after a kill. */
export const isThrowawayProfile = (dir: string): boolean =>
  /^playwright_[a-z]+dev_profile-/.test(path.basename(dir));

/**
 * SIGKILL everything of a marker, and remove the browser's throwaway profile folder (a killed browser cannot clean up after itself, and its profile is 100+ MB of
 * cache). Returns how many processes were killed.
 */
export function killMarker(marker: string): number {
  let n = 0;
  const rows = processesOf(marker);
  const profiles = userDataDirsOf(rows).filter(isThrowawayProfile);
  for (const r of rows) {
    try {
      process.kill(r.pid, "SIGKILL");
      n++;
    } catch {
      // already gone
    }
  }
  for (const dir of profiles)
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // the janitor gets it later
    }
  return n;
}

/** macOS `sample`: the native stacks of a process for a few seconds, into a file. Resolves false where it is not available or fails. */
export function sampleProcess(pid: number, seconds: number, file: string): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "sample",
      [String(pid), String(seconds), "-file", file],
      { timeout: (seconds + 10) * 1000 },
      (err) => resolve(!err),
    );
  });
}
