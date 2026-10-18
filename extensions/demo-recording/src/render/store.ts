/**
 * Render versions (S5 part 9, D59–D68): `render/vN.json` + `render/vN/<variant>/`.
 *
 * A version's RECORD is updated while it runs (status, variants) and when its
 * files are pruned or deleted; its OUTPUT files are never overwritten — a new
 * render is always a new version. Old `out/edit-vN/<variant>/` folders from
 * before the Render stage are listed as legacy renders.
 */

import fs from "node:fs";
import path from "node:path";
import type { AnnotationType } from "../annotations/types.ts";
import { hasLegacyLevels, legacyLevels, summarize } from "../qa/summary.ts";
import type { QaReport, QaSummary } from "../qa/types.ts";
import { writeZip } from "../util/zip.ts";
import { listVersions, writeNextVersion } from "../workdir/versioning.ts";

export type RenderKind = "draft" | "final";
export type RenderStatus = "running" | "done" | "failed" | "cancelled";

export interface RenderOptionsRec {
  /** Which annotation types to include (D66): "all" enabled ones, or a list (empty = none). */
  annotationTypes: "all" | AnnotationType[];
  /** Also write *.subtitled.mp4 with burned-in subtitles (D61). */
  subtitles: boolean;
  logoBug: boolean;
}

export interface RenderFiles {
  full: string;
  fullSubtitled?: string;
  scenes: string[];
  scenesSubtitled?: string[];
  vtt?: string;
  scenesVtt?: string[];
  callouts?: string;
  poster?: string;
}

export interface RenderVariantRec {
  /** Folder name under render/vN/. */
  key: string;
  brand: string;
  /** Project-relative folder. */
  dir: string;
  /** Relative to `dir`. */
  files: RenderFiles;
  bytes: number;
  durationSec: number;
  /** Identity of what was rendered: equal keys → the files are reused (D68). */
  reuseKey: string;
  reusedFrom?: number;
  warnings?: string[];
  /** Where things are in the full video (for QA and sidecars). */
  timing?: { titleMs: number; sceneStart: Record<string, number>; itemStart: number[] };
}

export interface RenderRecord {
  version: number;
  kind: RenderKind;
  /** The annotation version (absent: a draft before any annotations existed). */
  basedOn: { annotations?: number };
  /** Rendered from the panel's unsaved annotation draft (drafts only). */
  fromDraft?: boolean;
  timeline: number;
  voVersion: number;
  take: string;
  createdAt: string;
  finishedAt?: string;
  status: RenderStatus;
  error?: string;
  by: "panel" | "agent" | "edit" | "cli";
  options: RenderOptionsRec;
  brands: string[];
  size: { width: number; height: number };
  variants: RenderVariantRec[];
  /** QA summary (part 10, D69); null = not run. The report: render/vN.qa.json. */
  qa: null | QaSummary;
  /** LEGACY: a render made with timing overrides (D74, retired in Q7): render/vN.overrides.json is still read, nothing writes one. */
  overrides?: { fromRender: number; shifts: number };
  /** Files deleted by the user (record kept, D64). */
  deleted?: string;
  /** Files removed by draft pruning (record kept, D64). */
  pruned?: string;
}

export const renderDir = (projectDir: string) => path.join(projectDir, "render");
export const renderVersions = (projectDir: string) =>
  listVersions(renderDir(projectDir), "v", ".json");
const recordFile = (projectDir: string, v: number) =>
  path.join(renderDir(projectDir), `v${v}.json`);
export const versionDir = (projectDir: string, v: number) =>
  path.join(renderDir(projectDir), `v${v}`);

export function readRender(projectDir: string, v: number): RenderRecord | undefined {
  const f = recordFile(projectDir, v);
  if (!fs.existsSync(f)) return undefined;
  const rec = JSON.parse(fs.readFileSync(f, "utf8")) as RenderRecord;
  // A QA made before Q1a called a wrong number or a toast "blocking": only real defects stop a final now, so the
  // summary is read from the report with the new levels (the files on disk stay as they were).
  if (rec.qa && rec.qa.status !== "error") {
    const qf = path.join(projectDir, "render", `v${v}.qa.json`);
    if (fs.existsSync(qf)) {
      const report = JSON.parse(fs.readFileSync(qf, "utf8")) as QaReport;
      if (hasLegacyLevels(report)) rec.qa = summarize(legacyLevels(report).items, report.createdAt);
    }
  }
  return rec;
}

export function listRenders(projectDir: string): RenderRecord[] {
  return renderVersions(projectDir)
    .reverse()
    .map((v) => readRender(projectDir, v))
    .filter((r): r is RenderRecord => !!r);
}

/** Create the next version's record (status running). */
export function startRecord(
  projectDir: string,
  rec: Omit<RenderRecord, "version" | "createdAt" | "status" | "variants" | "qa">,
  now = new Date(),
): RenderRecord {
  const draft = {
    ...rec,
    version: 0,
    createdAt: now.toISOString(),
    status: "running" as const,
    variants: [],
    qa: null,
  };
  const stored = writeNextVersion(
    renderDir(projectDir),
    "v",
    ".json",
    `${JSON.stringify(draft, null, 2)}\n`,
  );
  const full: RenderRecord = { ...draft, version: stored.version };
  fs.writeFileSync(stored.file, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

export function saveRecord(projectDir: string, rec: RenderRecord): void {
  fs.writeFileSync(recordFile(projectDir, rec.version), `${JSON.stringify(rec, null, 2)}\n`);
}

/**
 * The flavor of a variant: brand + what differs from the default (all
 * annotations, logo bug on) — "neutral", "acme_callouts-only",
 * "neutral_plain", "acme_chapters-only_nobug". Also the variant's folder name.
 */
export function flavorName(brand: string, o: RenderOptionsRec): string {
  const parts = [brand];
  if (Array.isArray(o.annotationTypes))
    parts.push(
      !o.annotationTypes.length
        ? "plain"
        : o.annotationTypes.length === 1
          ? `${o.annotationTypes[0]}s-only`
          : `${[...o.annotationTypes].sort().join("-")}-only`,
    );
  if (!o.logoBug) parts.push("nobug");
  return parts.join("_");
}
export const variantName = flavorName;

/** File names of a variant: <project>_<kind>-v<N>_<flavor>… (relative to the variant folder). */
export function renderNames(project: string, kind: RenderKind, version: number, flavor: string) {
  const base = `${project}_${kind}-v${version}_${flavor}`;
  const scene = (id: string) => `scenes/${base}_${id}`;
  return {
    base,
    full: `${base}.mp4`,
    fullSubtitled: `${base}_subtitled.mp4`,
    vtt: `${base}_transcript.vtt`,
    callouts: `${base}_callouts.srt`,
    poster: `${base}_poster.jpg`,
    scene: (id: string) => `${scene(id)}.mp4`,
    sceneSubtitled: (id: string) => `${scene(id)}_subtitled.mp4`,
    sceneVtt: (id: string) => `${scene(id)}_transcript.vtt`,
  };
}
export type RenderNames = ReturnType<typeof renderNames>;

export function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(f) : fs.statSync(f).size;
  }
  return n;
}

/** Files of a variant exist on disk? */
export const variantPresent = (projectDir: string, v: RenderVariantRec) =>
  fs.existsSync(path.join(projectDir, v.dir, v.files.full));

/** Delete a render's files; the record stays, marked (D64). Returns the bytes freed. */
export function deleteRenderFiles(
  projectDir: string,
  v: number,
  how: "deleted" | "pruned",
  now = new Date(),
): number {
  const rec = readRender(projectDir, v);
  if (!rec) throw new Error(`render v${v} does not exist`);
  if (rec.status === "running") throw new Error(`render v${v} is still running — cancel it first`);
  const dir = versionDir(projectDir, v);
  const bytes = dirBytes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  rec[how] = now.toISOString();
  saveRecord(projectDir, rec);
  return bytes;
}

/**
 * Keep the newest `keep` drafts' files (D64); older drafts keep their record.
 * Finals are never pruned.
 */
export function pruneDrafts(projectDir: string, keep: number): number[] {
  const drafts = listRenders(projectDir).filter(
    (r) => r.kind === "draft" && r.status !== "running" && !r.deleted && !r.pruned,
  );
  const pruned: number[] = [];
  for (const r of drafts.slice(Math.max(0, keep))) {
    deleteRenderFiles(projectDir, r.version, "pruned");
    pruned.push(r.version);
  }
  return pruned;
}

/** Renders from before the Render stage: out/edit-vN/<variant>/full.mp4. */
export interface LegacyRender {
  edit: number;
  variant: string;
  dir: string;
  full: string;
  scenes: string[];
  bytes: number;
}

export function legacyRenders(projectDir: string): LegacyRender[] {
  const out = path.join(projectDir, "out");
  if (!fs.existsSync(out)) return [];
  const res: LegacyRender[] = [];
  for (const d of fs.readdirSync(out)) {
    const m = /^edit-v(\d+)$/.exec(d);
    if (!m) continue;
    for (const v of fs.readdirSync(path.join(out, d), { withFileTypes: true })) {
      if (!v.isDirectory()) continue;
      const dir = path.join("out", d, v.name);
      if (!fs.existsSync(path.join(projectDir, dir, "full.mp4"))) continue;
      const sc = path.join(projectDir, dir, "scenes");
      res.push({
        edit: Number(m[1]),
        variant: v.name,
        dir,
        full: "full.mp4",
        scenes: fs.existsSync(sc)
          ? fs
              .readdirSync(sc)
              .filter((f) => f.endsWith(".mp4"))
              .sort()
              .map((f) => `scenes/${f}`)
          : [],
        bytes: dirBytes(path.join(projectDir, dir)),
      });
    }
  }
  return res.sort((a, b) => b.edit - a.edit || a.variant.localeCompare(b.variant));
}

function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (!e.name.endsWith(".part") && !e.name.endsWith(".filter.txt")) out.push(r);
  }
  return out.sort();
}

/**
 * One zip with everything of a variant (videos, subtitled versions, scenes,
 * transcripts, callouts, poster) at render/vN/<base>.zip — next to, not in,
 * the variant folder, so Delete removes it with the version. Built on first
 * request, rebuilt only when a file is newer than the zip.
 */
export async function variantZip(
  projectDir: string,
  rec: RenderRecord,
  v: RenderVariantRec,
): Promise<{ rel: string; bytes: number; built: boolean }> {
  const dir = path.join(projectDir, v.dir);
  if (!variantPresent(projectDir, v))
    throw new Error(`render v${rec.version} (${v.key}) has no files any more`);
  const base = renderNames(path.basename(projectDir), rec.kind, rec.version, v.key).base;
  const rel = path.join("render", `v${rec.version}`, `${base}.zip`);
  const out = path.join(projectDir, rel);
  const files = filesUnder(dir);
  const newest = Math.max(...files.map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= newest)
    return { rel, bytes: fs.statSync(out).size, built: false };
  const bytes = await writeZip(
    out,
    files.map((f) => ({ name: `${base}/${f}`, file: path.join(dir, f) })),
  );
  return { rel, bytes, built: true };
}
