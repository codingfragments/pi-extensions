/**
 * Working drafts (UX5a, D115, D121): the user's own unsaved edits of an artifact, kept in the project
 * as `drafts/<stage>/v<base>.json`, one per stage and base version. A draft is **not** a version: it never
 * shows up in History or the map, the Director never reads it (D121), and nothing here starts a model, TTS
 * or render job or changes approval or the production line.
 *
 *  - Every write carries the revision it was based on; a stale one is rejected with the current draft
 *    (`DraftConflict`), never silently overwritten.
 *  - Writes are atomic (write, then rename).
 *  - Revisions never repeat for a base: `v<base>.last.json` remembers the last one used, so a stale tab
 *    cannot be mistaken for a current one after a discard or a save.
 *  - *Save new version* is idempotent on the revision: the same revision twice gives the same version.
 *  - A draft stays on its base. When the base is approved or withdrawn, or a newer version exists, the
 *    draft is flagged (`draftFlags`), never moved, rebased or dropped.
 *
 * Only the voice-over has inline editing today, so only `vo` drafts exist; the module is keyed by stage.
 */

import fs from "node:fs";
import path from "node:path";
import { readVo, replaceVoSection, voVersions, writeVo } from "../vo/store.ts";
import { isAccepted } from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import { writeFileAtomic } from "../workdir/versioning.ts";

export const DRAFT_STAGES = ["vo"] as const;
export type DraftStage = (typeof DRAFT_STAGES)[number];
export const isDraftStage = (v: unknown): v is DraftStage =>
  (DRAFT_STAGES as readonly unknown[]).includes(v);

export const MAX_EDIT_CHARS = 20_000;
export const MAX_EDIT_SECTIONS = 200;

export interface WorkingDraft {
  schema: 1;
  stage: DraftStage;
  /** The version the draft is built on. */
  base: number;
  /** Counts every write; never repeats for a base. */
  revision: number;
  /** The tab or session that wrote the latest revision. */
  author: string;
  createdAt: string;
  updatedAt: string;
  /** Whether the base was approved and which version was the latest when the draft was started. */
  baseApprovedAtStart: boolean;
  latestAtStart: number;
  /** Section key to the edited body (only sections that differ from the base). */
  edits: Record<string, string>;
}

export interface DraftSummary {
  stage: DraftStage;
  base: number;
  revision: number;
  author: string;
  updatedAt: string;
  changes: number;
  sections: string[];
}

/** A write based on a revision that is no longer the current one. `current` is null when there is none. */
export class DraftConflict<T extends { revision: number } = WorkingDraft> extends Error {
  readonly current: T | null;
  constructor(current: T | null, expected: number | null) {
    super(
      current
        ? `the draft changed since you last saw it (you have revision ${expected ?? "none"}, it is at ${current.revision})`
        : `the draft no longer exists (you have revision ${expected ?? "none"}): it was saved or discarded elsewhere`,
    );
    this.name = "DraftConflict";
    this.current = current;
  }
}

export interface LastRecord {
  revision: number;
  how: "saved" | "discarded";
  savedAs?: number;
  at: string;
}

export const draftsDir = (projectDir: string, stage: string) =>
  path.join(projectDir, "drafts", stage);
export const draftFile = (projectDir: string, stage: string, base: number) =>
  path.join(draftsDir(projectDir, stage), `v${base}.json`);
export const lastFile = (projectDir: string, stage: string, base: number) =>
  path.join(draftsDir(projectDir, stage), `v${base}.last.json`);

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${path.basename(file)} is unreadable: ${(err as Error).message}`);
  }
}

export const readDraft = (projectDir: string, stage: DraftStage, base: number) =>
  readJson<WorkingDraft>(draftFile(projectDir, stage, base));

export const readLast = (projectDir: string, stage: string, base: number) =>
  readJson<LastRecord>(lastFile(projectDir, stage, base));

export const writeLast = (projectDir: string, stage: string, base: number, rec: LastRecord) =>
  writeFileAtomic(lastFile(projectDir, stage, base), `${JSON.stringify(rec, null, 2)}\n`);

export function summarize(d: WorkingDraft): DraftSummary {
  const sections = Object.keys(d.edits);
  return {
    stage: d.stage,
    base: d.base,
    revision: d.revision,
    author: d.author,
    updatedAt: d.updatedAt,
    changes: sections.length,
    sections,
  };
}

/** The bodies of a voice-over version's sections, by key. */
function baseBodies(projectDir: string, base: number): Map<string, string> {
  const vo = readVo(projectDir, base);
  if (!vo) throw new Error(`voice-over v${base} does not exist`);
  return new Map(vo.validated.script.sections.map((s) => [s.key, s.body]));
}

const norm = (s: string) => s.trim().replace(/\r\n/g, "\n");

/**
 * Save edits into the draft of `base`. `edits` maps a section key to its new body, or to null to drop that
 * edit. `expected` is the revision the caller last saw (null = it has no draft). An edit equal to the base
 * is dropped, so `changes` is always the number of sections that really differ.
 */
export function saveDraft(
  projectDir: string,
  stage: DraftStage,
  base: number,
  input: { expected: number | null; edits: Record<string, string | null>; author: string },
  now = new Date(),
): WorkingDraft {
  const bodies = baseBodies(projectDir, base);
  const keys = Object.keys(input.edits);
  if (keys.length > MAX_EDIT_SECTIONS)
    throw new Error(`at most ${MAX_EDIT_SECTIONS} sections per save`);
  for (const k of keys) {
    if (!bodies.has(k)) throw new Error(`section "${k}" is not in voice-over v${base}`);
    const v = input.edits[k];
    if (v !== null && typeof v !== "string")
      throw new Error(`the edit of "${k}" must be text or null`);
    if (typeof v === "string" && v.length > MAX_EDIT_CHARS)
      throw new Error(`the edit of "${k}" is longer than ${MAX_EDIT_CHARS} characters`);
  }
  const current = readDraft(projectDir, stage, base);
  const expected = input.expected || null;
  if (current ? current.revision !== expected : expected !== null)
    throw new DraftConflict(current ?? null, expected);
  const edits = { ...(current?.edits ?? {}) };
  for (const [k, v] of Object.entries(input.edits)) {
    if (v === null || norm(v) === norm(bodies.get(k) as string)) Reflect.deleteProperty(edits, k);
    else edits[k] = v;
  }
  const at = now.toISOString();
  const state = readState(projectDir);
  const next: WorkingDraft = {
    schema: 1,
    stage,
    base,
    revision: (current?.revision ?? readLast(projectDir, stage, base)?.revision ?? 0) + 1,
    author: input.author,
    createdAt: current?.createdAt ?? at,
    updatedAt: at,
    baseApprovedAtStart:
      current?.baseApprovedAtStart ?? (state ? isAccepted(state.accepted, stage, base) : false),
    latestAtStart: current?.latestAtStart ?? voVersions(projectDir).at(-1) ?? base,
    edits,
  };
  writeFileAtomic(draftFile(projectDir, stage, base), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Throw a conflict unless `expected` is the draft's current revision. */
function assertCurrent(
  current: WorkingDraft | undefined,
  expected: number | null,
): asserts current is WorkingDraft {
  if (!current || current.revision !== expected) throw new DraftConflict(current ?? null, expected);
}

/** Delete the draft, and say what is gone. A draft already gone gives `null`. */
export function discardDraft(
  projectDir: string,
  stage: DraftStage,
  base: number,
  expected: number | null,
  now = new Date(),
): DraftSummary | null {
  const current = readDraft(projectDir, stage, base);
  if (!current) return null;
  assertCurrent(current, expected);
  writeLast(projectDir, stage, base, {
    revision: current.revision,
    how: "discarded",
    at: now.toISOString(),
  });
  fs.rmSync(draftFile(projectDir, stage, base));
  return summarize(current);
}

export interface SavedVersion {
  version: number;
  /** True when this revision had already been saved: nothing new was written. */
  repeated: boolean;
  sections: string[];
}

/**
 * Turn the draft into exactly one new version. Idempotent on the revision (a double click, a retry after a
 * lost response), and on any failure, validation included, the draft stays untouched.
 */
export function saveDraftAsVersion(
  projectDir: string,
  stage: DraftStage,
  base: number,
  expected: number | null,
  now = new Date(),
): SavedVersion {
  const last = readLast(projectDir, stage, base);
  if (last?.how === "saved" && last.savedAs !== undefined && last.revision === expected)
    return { version: last.savedAs, repeated: true, sections: [] };
  const current = readDraft(projectDir, stage, base);
  assertCurrent(current, expected);
  const sections = Object.keys(current.edits);
  if (!sections.length) throw new Error("nothing to save: the draft has no changes");
  const vo = readVo(projectDir, base);
  if (!vo) throw new Error(`voice-over v${base} does not exist`);
  let text = vo.text;
  for (const [k, body] of Object.entries(current.edits)) text = replaceVoSection(text, k, body);
  const stored = writeVo(projectDir, text, { base, panelEdit: true }); // throws on errors: the draft stays
  writeLast(projectDir, stage, base, {
    revision: current.revision,
    how: "saved",
    savedAs: stored.version,
    at: now.toISOString(),
  });
  fs.rmSync(draftFile(projectDir, stage, base));
  return { version: stored.version, repeated: false, sections };
}

export interface DraftFlags {
  base: number;
  /** The newest version of the stage. */
  latest: number;
  /** The newer version, when there is one. */
  superseded: number | null;
  baseApproved: boolean;
  /** The base's approval differs from when the draft was started. */
  approvalChanged: boolean;
  /** Plain sentences for the panel (empty when nothing changed under the draft). */
  notes: string[];
}

/** What changed under a draft since it was started (D121). Never changes the draft. */
export function draftFlags(projectDir: string, d: WorkingDraft): DraftFlags {
  const latest = voVersions(projectDir).at(-1) ?? d.base;
  const state = readState(projectDir);
  const baseApproved = state ? isAccepted(state.accepted, d.stage, d.base) : false;
  const approvalChanged = baseApproved !== d.baseApprovedAtStart;
  const notes: string[] = [];
  if (latest > d.base) notes.push(`built on v${d.base}, v${latest} exists`);
  if (approvalChanged)
    notes.push(
      baseApproved
        ? `v${d.base} was approved since you started this draft`
        : `the approval of v${d.base} was withdrawn since you started this draft`,
    );
  return {
    base: d.base,
    latest,
    superseded: latest > d.base ? latest : null,
    baseApproved,
    approvalChanged,
    notes,
  };
}

export interface DraftSectionView {
  key: string;
  /** The base version's body. */
  base: string;
  /** The draft's body. */
  draft: string;
  /** The newest version's body, when it is newer than the base. */
  latest?: string;
}

/** Each edited section next to the base and, when the base was superseded, the newest version. */
export function draftSections(projectDir: string, d: WorkingDraft): DraftSectionView[] {
  const base = baseBodies(projectDir, d.base);
  const latestV = voVersions(projectDir).at(-1);
  const latest =
    latestV !== undefined && latestV > d.base ? baseBodies(projectDir, latestV) : undefined;
  return Object.entries(d.edits).map(([key, draft]) => ({
    key,
    base: base.get(key) ?? "",
    draft,
    ...(latest ? { latest: latest.get(key) ?? "" } : {}),
  }));
}

/** Every draft with changes, for the stage's list and History. */
export function listDrafts(
  projectDir: string,
  stage: DraftStage,
): (DraftSummary & { flags: DraftFlags })[] {
  const dir = draftsDir(projectDir, stage);
  if (!fs.existsSync(dir)) return [];
  const out: (DraftSummary & { flags: DraftFlags })[] = [];
  for (const name of fs.readdirSync(dir)) {
    const m = /^v(\d+)\.json$/.exec(name);
    if (!m) continue;
    const d = readDraft(projectDir, stage, Number(m[1]));
    if (d && Object.keys(d.edits).length)
      out.push({ ...summarize(d), flags: draftFlags(projectDir, d) });
  }
  return out.sort((a, b) => a.base - b.base);
}
