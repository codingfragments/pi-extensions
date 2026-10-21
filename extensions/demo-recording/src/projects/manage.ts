/**
 * Managing projects (item 14, E; D146): list them, switch, archive (one zip) and delete (a verified zip first). Pure engine, no panel: the Projects page and
 * `/demo archive` use the same functions.
 *
 * The zip holds the project folder and its app (`apps/<app>`: the app's record and the discovery screens the storyboard's pictures point to), under the same
 * paths as in the working folder (`projects/<slug>/…`, `apps/<app>/…`), so unzipping it into the root puts everything back. Left out: caches (`previews/`, `.cache`),
 * the app's `auth/` (a saved login must never end up in a backup file) and, on request, the video files of DRAFT renders (their records stay). The zip writer has no
 * ZIP64: a project that would not fit below 4 GiB is refused with the reason, never cut. Delete = archive, read the zip back, compare, and only then remove the folder.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ZIP_LIMIT,
  type ZipEntry,
  crcOf,
  crcOfEntry,
  readZipIndex,
  writeZip,
} from "../util/zip.ts";
import { appDir, listProjects, projectDir, projectsDir, readApp } from "../workdir/layout.ts";
import { readState } from "../workdir/state.ts";

/** The session entry that remembers the active project (restored by `session_start`). */
export const ACTIVE_ENTRY = "demo-recording.active";

export const archiveDir = (root: string) => path.join(root, "archive");

export interface ProjectRow {
  slug: string;
  app: string;
  appName: string;
  phase: string;
  /** Bytes of the project folder (what is on disk, caches included). */
  bytes: number;
  updatedAt: string;
  active: boolean;
}

/** Bytes of everything under `dir` (files only, symlinks not followed). */
export function folderBytes(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

export function listProjectRows(root: string, activeSlug?: string): ProjectRow[] {
  return listProjects(root).map((slug) => {
    const dir = projectDir(root, slug);
    const st = readState(dir);
    const app = st ? readApp(root, st.app) : undefined;
    return {
      slug,
      app: st?.app ?? "",
      appName: app?.name ?? st?.app ?? "",
      phase: st?.phase ?? "unknown",
      bytes: folderBytes(dir),
      updatedAt: st?.updatedAt ?? fs.statSync(dir).mtime.toISOString(),
      active: slug === activeSlug,
    };
  });
}

const CACHE = new Set(["previews", ".cache", "node_modules"]);

export interface ArchiveOptions {
  /** Leave out the video files of draft renders (their records stay): for a project that is too big for one zip. */
  withoutDrafts?: boolean;
  now?: Date;
  /** Test seam: the size above which a project is refused (default: just below 4 GiB). */
  limitBytes?: number;
}

export interface ArchivePlan {
  entries: ZipEntry[];
  bytes: number;
  left: { caches: number; auth: boolean; drafts: number };
}

function draftRenderDirs(dir: string): Set<string> {
  const out = new Set<string>();
  const rd = path.join(dir, "render");
  if (!fs.existsSync(rd)) return out;
  for (const f of fs.readdirSync(rd))
    if (/^v\d+\.json$/.test(f))
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(rd, f), "utf8")) as { kind?: string };
        if (rec.kind === "draft") out.add(path.join(rd, f.replace(/\.json$/, "")));
      } catch {
        // an unreadable record: its files are kept
      }
  return out;
}

/** What goes into the zip of a project, and what is left out. */
export function planArchive(root: string, slug: string, o: ArchiveOptions = {}): ArchivePlan {
  const dir = projectDir(root, slug);
  const st = readState(dir);
  if (!st) throw new Error(`no demo project "${slug}" under ${projectsDir(root)}`);
  const entries: ZipEntry[] = [];
  const left = { caches: 0, auth: false, drafts: 0 };
  const drafts = o.withoutDrafts ? draftRenderDirs(dir) : new Set<string>();
  const walk = (
    base: string,
    prefix: string,
    skip: (rel: string, abs: string) => "cache" | "auth" | "draft" | undefined,
  ) => {
    const go = (d: string) => {
      for (const e of fs
        .readdirSync(d, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(d, e.name);
        const rel = path.relative(base, abs).split(path.sep).join("/");
        const why = skip(rel, abs);
        if (why) {
          if (why === "cache") left.caches++;
          else if (why === "auth") left.auth = true;
          else left.drafts++;
          continue;
        }
        if (e.isDirectory()) go(abs);
        else if (e.isFile()) entries.push({ name: `${prefix}/${rel}`, file: abs });
      }
    };
    go(base);
  };
  walk(dir, `projects/${slug}`, (rel, abs) => {
    if (CACHE.has(rel.split("/")[0] as string) || rel.endsWith(".part") || rel.endsWith(".tmp"))
      return "cache";
    if (drafts.has(abs)) return "draft";
    return undefined;
  });
  const app = st.app && fs.existsSync(appDir(root, st.app)) ? st.app : undefined;
  if (app)
    walk(appDir(root, app), `apps/${app}`, (rel) => {
      const top = rel.split("/")[0] as string;
      if (top === "auth") return "auth";
      if (CACHE.has(top)) return "cache";
      return undefined;
    });
  const bytes = entries.reduce((n, e) => n + fs.statSync(e.file).size, 0);
  return { entries, bytes, left };
}

export interface ArchiveResult {
  file: string;
  bytes: number;
  files: number;
  left: ArchivePlan["left"];
  /** The zip was read back and every entry matches its source file. */
  verified: true;
}

const stamp = (d: Date) =>
  d.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/** Write `<root>/archive/<slug>-<date>.zip` and read it back. Throws, leaving no zip behind, when it cannot be written or does not verify. */
export async function archiveProject(
  root: string,
  slug: string,
  o: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const plan = planArchive(root, slug, o);
  const limit = o.limitBytes ?? ZIP_LIMIT - 64 * 1024 * 1024; // room for the headers and the directory
  if (plan.bytes >= limit) {
    const gib = (plan.bytes / 2 ** 30).toFixed(1);
    throw new Error(
      `"${slug}" is ${gib} GiB, too big for one zip (the writer stops at 4 GiB)${o.withoutDrafts ? ", even without the draft renders" : ": try again without the draft renders"}`,
    );
  }
  // a second archive in the same second (an archive, then a delete) gets a number rather than replacing or refusing
  const base = `${slug}-${stamp(o.now ?? new Date())}`;
  let file = path.join(archiveDir(root), `${base}.zip`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(archiveDir(root), `${base}-${n}.zip`);
  await writeZip(file, plan.entries);
  try {
    await verifyArchive(file, plan.entries);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw new Error(`the zip did not verify and was removed: ${(err as Error).message}`);
  }
  return {
    file,
    bytes: fs.statSync(file).size,
    files: plan.entries.length,
    left: plan.left,
    verified: true,
  };
}

/** Read the zip back: the same names, the same sizes, and the stored bytes of every entry have the CRC of the file they came from. */
export async function verifyArchive(file: string, entries: ZipEntry[]): Promise<void> {
  const index = readZipIndex(file);
  if (index.length !== entries.length)
    throw new Error(`${index.length} entries in the zip, ${entries.length} expected`);
  const byName = new Map(index.map((e) => [e.name, e]));
  for (const e of entries) {
    const z = byName.get(e.name);
    if (!z) throw new Error(`${e.name} is missing from the zip`);
    if (z.size !== fs.statSync(e.file).size) throw new Error(`${e.name}: the size differs`);
    const [stored, source] = await Promise.all([crcOfEntry(file, z), crcOf(e.file)]);
    if (stored !== source || z.crc !== source) throw new Error(`${e.name}: the bytes differ`);
  }
}

export interface DeleteResult extends ArchiveResult {
  removed: string;
}

/**
 * Delete a project: archive it, read the zip back, and only then remove the folder. The app (`apps/<app>`) is shared with other projects and stays.
 * `confirmName` must be the project's name, exactly.
 */
export async function deleteProject(
  root: string,
  slug: string,
  confirmName: string,
  o: ArchiveOptions = {},
): Promise<DeleteResult> {
  if (confirmName !== slug) throw new Error(`type the project's name (${slug}) to delete it`);
  const archived = await archiveProject(root, slug, o);
  const dir = projectDir(root, slug);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...archived, removed: dir };
}
