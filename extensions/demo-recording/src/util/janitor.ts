/**
 * Our own leftovers in the temp folder. A browser that is killed instead of closed leaves its profile folder (`playwright_chromiumdev_profile-*`, 100+ MB of
 * cache), and the tools and tests of this extension have left tens of thousands of folders behind. The engine sweeps what is unmistakably its own and old, once per
 * process, and never anything that a running process still has in its command line.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What the engine sweeps by itself: Playwright's profile folders and the extension's own temp prefix. */
export const OWN_TEMP = [/^playwright_[a-z]+dev_profile-/, /^playwright-artifacts-/, /^demo-rec-/];

export interface SweepResult {
  removed: string[];
  kept: string[];
}

/** The command lines of all running processes (to know which folders are in use). */
function runningCommands(): string {
  try {
    return execFileSync("ps", ["-wwAo", "command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/**
 * Remove the folders of `dir` whose name matches one of `patterns` and that are older than `olderThanMs`, unless a running process mentions them.
 * `dryRun` only reports. Never throws.
 */
export function sweepTemp(o: {
  dir?: string;
  patterns?: RegExp[];
  olderThanMs?: number;
  dryRun?: boolean;
  now?: number;
  commands?: string;
}): SweepResult {
  const dir = o.dir ?? os.tmpdir();
  const patterns = o.patterns ?? OWN_TEMP;
  const olderThanMs = o.olderThanMs ?? 24 * 3600 * 1000;
  const now = o.now ?? Date.now();
  const result: SweepResult = { removed: [], kept: [] };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => patterns.some((p) => p.test(n)));
  } catch {
    return result;
  }
  if (!names.length) return result;
  const commands = o.commands ?? runningCommands();
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs < olderThanMs || commands.includes(full)) {
        result.kept.push(name);
        continue;
      }
      if (!o.dryRun)
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      result.removed.push(name);
    } catch {
      result.kept.push(name);
    }
  }
  return result;
}

/** The sweep the engine runs once per process (a day old, our own names). */
export function sweepOwnTemp(): SweepResult {
  return sweepTemp({});
}
