/**
 * What this extension and its tests have left in the temp folder, and removing it. A dry run unless you say `--delete`; only folders older than `--older-than`
 * (default 1h) and not in use by a running process. The names are Playwright's profile folders, the extension's own `demo-rec-` prefix, and every prefix the extension's
 * tests pass to `mkdtempSync` (read from the tests, so the list cannot go stale). Other tools' folders are never touched.
 *
 *   npm run clean:tmp                 what would go
 *   npm run clean:tmp -- --delete     remove it
 *   npm run clean:tmp -- --delete --older-than 10m
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWN_TEMP, sweepTemp } from "../src/util/janitor.ts";

/** The literal prefixes the tests give to `mkdtempSync(path.join(os.tmpdir(), "<prefix>"…`. */
export function testPrefixes(testDir: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.ts$/.test(e.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(
          /(?:tmpdir\(\)\)?|TMP\w*)\s*,\s*["'`]([A-Za-z0-9][A-Za-z0-9_.-]*)["'`]/g,
        ))
          found.add(m[1] as string);
        for (const m of text.matchAll(/mkdtempSync\([^)]*["'`]([A-Za-z0-9][A-Za-z0-9_.-]*-)["'`]/g))
          found.add(m[1] as string);
        // helpers that wrap it: tmp("ann8-"), mkTmp("zoom-")
        for (const m of text.matchAll(
          /\b(?:tmp|mkTmp|tmpDir|makeTmp)\(\s*["'`]([A-Za-z0-9][A-Za-z0-9_.-]*-)["'`]/g,
        ))
          found.add(m[1] as string);
      }
    }
  };
  walk(testDir);
  return [...found].sort();
}

const parseAge = (s: string): number => {
  const m = /^(\d+)(s|m|h|d)$/.exec(s);
  if (!m) throw new Error(`--older-than wants a number and s, m, h or d (got "${s}")`);
  return (
    Number(m[1]) *
    { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"]
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const del = args.includes("--delete");
  const ageArg = args[args.indexOf("--older-than") + 1];
  const olderThanMs = args.includes("--older-than") ? parseAge(ageArg ?? "") : 3_600_000;
  const prefixes = testPrefixes(path.join(import.meta.dirname, "..", "test"));
  const patterns = [
    ...OWN_TEMP,
    ...prefixes.map((p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
  ];
  const dir = os.tmpdir();
  const total = fs.readdirSync(dir).length;
  const r = sweepTemp({ dir, patterns, olderThanMs, dryRun: !del });
  const byPrefix = new Map<string, number>();
  for (const n of r.removed) {
    const key = patterns.find((p) => p.test(n))?.source.replace(/^\^/, "") ?? n;
    byPrefix.set(key, (byPrefix.get(key) ?? 0) + 1);
  }
  console.log(
    `${dir}: ${total} entries, ${r.removed.length} ${del ? "removed" : "would be removed"} (older than ${args.includes("--older-than") ? ageArg : "1h"}), ${r.kept.length} of ours kept (new or in use)`,
  );
  for (const [k, n] of [...byPrefix].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  if (!del && r.removed.length)
    console.log("\nNothing was removed. Run again with --delete to remove these.");
}
