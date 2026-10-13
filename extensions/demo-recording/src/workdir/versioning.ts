/**
 * Immutable versioning helpers (IMPLEMENTATION_PLAN §1 principle 2).
 *
 * Artifacts are never overwritten: a new storyboard is `v4.yaml`, a new take is
 * `take-003/`. Writes use exclusive-create (`wx` / non-recursive mkdir) so two
 * concurrent writers can never clobber each other — the loser retries with the
 * next number.
 */

import fs from "node:fs";
import path from "node:path";

const MAX_RETRIES = 50;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All existing version numbers for files named `<prefix><N><ext>` in `dir`, ascending. */
export function listVersions(dir: string, prefix: string, ext: string): number[] {
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`^${escapeRe(prefix)}(\\d+)${escapeRe(ext)}$`);
  return fs
    .readdirSync(dir)
    .map((name) => re.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export function latestVersion(dir: string, prefix: string, ext: string): number | undefined {
  return listVersions(dir, prefix, ext).at(-1);
}

export interface Versioned {
  version: number;
  file: string;
}

/**
 * Write `content` as the next version `<prefix><N><ext>` in `dir`.
 * Never overwrites; retries on a concurrent create of the same number.
 */
export function writeNextVersion(
  dir: string,
  prefix: string,
  ext: string,
  content: string | Uint8Array,
): Versioned {
  fs.mkdirSync(dir, { recursive: true });
  let next = (latestVersion(dir, prefix, ext) ?? 0) + 1;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++, next++) {
    const file = path.join(dir, `${prefix}${next}${ext}`);
    try {
      fs.writeFileSync(file, content, { flag: "wx" });
      return { version: next, file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not allocate a new version in ${dir} after ${MAX_RETRIES} attempts`);
}

/** Create the next numbered directory `<prefix><NNN>` (e.g. `take-001`). Never reuses one. */
export function createNextNumberedDir(parent: string, prefix: string, pad = 3): Versioned {
  fs.mkdirSync(parent, { recursive: true });
  const re = new RegExp(`^${escapeRe(prefix)}(\\d+)$`);
  const existing = fs
    .readdirSync(parent)
    .map((name) => re.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  let next = (existing.length ? Math.max(...existing) : 0) + 1;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++, next++) {
    const dir = path.join(parent, `${prefix}${String(next).padStart(pad, "0")}`);
    try {
      fs.mkdirSync(dir); // non-recursive: fails with EEXIST if a racer won
      return { version: next, file: dir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not allocate a new ${prefix} directory in ${parent}`);
}

/** Atomic replace for mutable bookkeeping files (state.json): write temp, then rename. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
