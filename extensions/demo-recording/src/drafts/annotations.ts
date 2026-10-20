/**
 * Annotation drafts on the draft contract (UX6a, D115, D121, D122): the user's unsaved edits of an
 * annotation version, one draft per base version in `drafts/annotations/v<base>.json`. The rules are those
 * of the voice-over's drafts (src/drafts/store.ts): every write carries the revision it was based on and a
 * stale one is rejected with the current draft; writes are atomic; revisions never repeat for a base;
 * *Save new version* is idempotent on the revision; a draft stays on its base and is flagged when the base
 * moves; nothing here starts a job, tells the Director or changes approval or the production line.
 *
 * What differs: a voice draft is a set of edited texts, an annotation draft is the whole annotation file
 * with the edits applied (src/annotations/draft.ts has the edit operations and their validation).
 *
 * The single `annotations/draft.json` of earlier versions is read once, becomes the draft of its base
 * (revision 1, author "migrated") and is removed.
 */

import fs from "node:fs";
import path from "node:path";
import { type DraftOp, type ZoomGuard, applyDraftOp } from "../annotations/draft.ts";
import {
  annotationVersions,
  annotationsDir,
  readAnnotations,
  writeAnnotations,
} from "../annotations/file.ts";
import type { AnnotationFile } from "../annotations/types.ts";
import { isAccepted } from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import { writeFileAtomic } from "../workdir/versioning.ts";
import { DraftConflict, draftFile, draftsDir, readJson, readLast, writeLast } from "./store.ts";

const STAGE = "annotations";

export interface AnnotationWorkingDraft {
  schema: 1;
  stage: "annotations";
  base: number;
  /** Counts every write; never repeats for a base. */
  revision: number;
  /** The tab or session that wrote the latest revision. */
  author: string;
  createdAt: string;
  updatedAt: string;
  baseApprovedAtStart: boolean;
  latestAtStart: number;
  /** Number of edits since the base. */
  changes: number;
  /** The base's file with the edits applied. */
  file: AnnotationFile;
}

export interface AnnotationDraftSummary {
  base: number;
  revision: number;
  author: string;
  updatedAt: string;
  changes: number;
}

export type AnnotationDraftConflict = DraftConflict<AnnotationWorkingDraft>;

const legacyFile = (projectDir: string) => path.join(annotationsDir(projectDir), "draft.json");

/** The old single draft becomes the draft of its base, once. */
function migrateLegacy(projectDir: string): void {
  const f = legacyFile(projectDir);
  if (!fs.existsSync(f)) return;
  try {
    const old = JSON.parse(fs.readFileSync(f, "utf8")) as {
      base: number;
      updatedAt: string;
      file: AnnotationFile;
      changes: number;
    };
    if (!readJson(draftFile(projectDir, STAGE, old.base))) {
      const state = readState(projectDir);
      const next: AnnotationWorkingDraft = {
        schema: 1,
        stage: STAGE,
        base: old.base,
        revision: (readLast(projectDir, STAGE, old.base)?.revision ?? 0) + 1,
        author: "migrated",
        createdAt: old.updatedAt,
        updatedAt: old.updatedAt,
        baseApprovedAtStart: state ? isAccepted(state.accepted, STAGE, old.base) : false,
        latestAtStart: annotationVersions(projectDir).at(-1) ?? old.base,
        changes: old.changes,
        file: old.file,
      };
      writeFileAtomic(draftFile(projectDir, STAGE, old.base), `${JSON.stringify(next, null, 2)}\n`);
    }
    fs.rmSync(f);
  } catch {
    // an unreadable legacy draft is left where it is, and reported by nothing: it was never a version
  }
}

export function readAnnotationDraft(
  projectDir: string,
  base: number,
): AnnotationWorkingDraft | undefined {
  migrateLegacy(projectDir);
  return readJson<AnnotationWorkingDraft>(draftFile(projectDir, STAGE, base));
}

export function summarizeAnnotationDraft(d: AnnotationWorkingDraft): AnnotationDraftSummary {
  return {
    base: d.base,
    revision: d.revision,
    author: d.author,
    updatedAt: d.updatedAt,
    changes: d.changes,
  };
}

/** Every draft with changes, oldest base first. */
export function listAnnotationDrafts(projectDir: string): AnnotationWorkingDraft[] {
  migrateLegacy(projectDir);
  const dir = draftsDir(projectDir, STAGE);
  if (!fs.existsSync(dir)) return [];
  const out: AnnotationWorkingDraft[] = [];
  for (const name of fs.readdirSync(dir)) {
    const m = /^v(\d+)\.json$/.exec(name);
    if (!m) continue;
    const d = readJson<AnnotationWorkingDraft>(path.join(dir, name));
    if (d && d.changes > 0) out.push(d);
  }
  return out.sort((a, b) => a.base - b.base);
}

/**
 * The draft a "render from my unsaved changes" means: the one on the version the line uses, else the most
 * recently edited.
 */
export function preferredAnnotationDraft(
  projectDir: string,
  lineVersion: number | undefined,
): AnnotationWorkingDraft | undefined {
  const all = listAnnotationDrafts(projectDir);
  return (
    all.find((d) => d.base === lineVersion) ??
    [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  );
}

/**
 * Apply one edit to the draft of `base` (created from the version when there is none). `expected` is the
 * revision the caller last saw (null = it has no draft); a stale one throws `DraftConflict`. An edit that
 * changes nothing writes nothing and returns the draft as it is (undefined when there is none).
 */
export function editAnnotationDraft(
  projectDir: string,
  base: number,
  op: DraftOp,
  input: { expected: number | null; author: string },
  now = new Date(),
  guard?: ZoomGuard,
): AnnotationWorkingDraft | undefined {
  const current = readAnnotationDraft(projectDir, base);
  const expected = input.expected || null;
  if (current ? current.revision !== expected : expected !== null)
    throw new DraftConflict<AnnotationWorkingDraft>(current ?? null, expected);
  const startFile = current?.file ?? readAnnotations(projectDir, base);
  if (!startFile) throw new Error(`annotations v${base} do not exist`);
  const file = structuredClone(startFile);
  const changed = applyDraftOp(file, op, now, guard);
  if (!changed) return current; // nothing differs: no new revision, and no draft if there was none
  const state = readState(projectDir);
  const at = now.toISOString();
  const next: AnnotationWorkingDraft = {
    schema: 1,
    stage: STAGE,
    base,
    revision: (current?.revision ?? readLast(projectDir, STAGE, base)?.revision ?? 0) + 1,
    author: input.author,
    createdAt: current?.createdAt ?? at,
    updatedAt: at,
    baseApprovedAtStart:
      current?.baseApprovedAtStart ?? (state ? isAccepted(state.accepted, STAGE, base) : false),
    latestAtStart: current?.latestAtStart ?? annotationVersions(projectDir).at(-1) ?? base,
    changes: (current?.changes ?? 0) + 1,
    file,
  };
  writeFileAtomic(draftFile(projectDir, STAGE, base), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Delete the draft, and say what is gone. A draft already gone gives `null`. */
export function discardAnnotationDraft(
  projectDir: string,
  base: number,
  expected: number | null,
  now = new Date(),
): AnnotationDraftSummary | null {
  const current = readAnnotationDraft(projectDir, base);
  if (!current) return null;
  if (current.revision !== (expected || null))
    throw new DraftConflict<AnnotationWorkingDraft>(current, expected || null);
  writeLast(projectDir, STAGE, base, {
    revision: current.revision,
    how: "discarded",
    at: now.toISOString(),
  });
  fs.rmSync(draftFile(projectDir, STAGE, base));
  return summarizeAnnotationDraft(current);
}

export interface SavedAnnotations {
  version: number;
  /** True when this revision had already been saved: nothing new was written. */
  repeated: boolean;
  changes: number;
  /** The items that carry user edits in the new version. */
  edited: string[];
}

/**
 * Turn the draft into exactly one new version, once per revision. On any failure the draft stays.
 */
export function saveAnnotationDraftAsVersion(
  projectDir: string,
  base: number,
  expected: number | null,
  now = new Date(),
): SavedAnnotations {
  const last = readLast(projectDir, STAGE, base);
  if (last?.how === "saved" && last.savedAs !== undefined && last.revision === (expected || null))
    return { version: last.savedAs, repeated: true, changes: 0, edited: [] };
  const current = readAnnotationDraft(projectDir, base);
  if (!current || current.revision !== (expected || null))
    throw new DraftConflict<AnnotationWorkingDraft>(current ?? null, expected || null);
  if (!current.changes) throw new Error("nothing to save: the draft has no changes");
  const { version: _v, ...rest } = current.file;
  const stored = writeAnnotations(projectDir, { ...rest, by: "user edits", editedFrom: base });
  writeLast(projectDir, STAGE, base, {
    revision: current.revision,
    how: "saved",
    savedAs: stored.version,
    at: now.toISOString(),
  });
  fs.rmSync(draftFile(projectDir, STAGE, base));
  return {
    version: stored.version,
    repeated: false,
    changes: current.changes,
    edited: stored.items.filter((x) => (x.edits?.length ?? 0) > 0).map((x) => x.id),
  };
}

export interface AnnotationDraftFlags {
  base: number;
  latest: number;
  superseded: number | null;
  baseApproved: boolean;
  approvalChanged: boolean;
  notes: string[];
}

/** What changed under a draft since it was started (D121). Never changes the draft. */
export function annotationDraftFlags(
  projectDir: string,
  d: AnnotationWorkingDraft,
): AnnotationDraftFlags {
  const latest = annotationVersions(projectDir).at(-1) ?? d.base;
  const state = readState(projectDir);
  const baseApproved = state ? isAccepted(state.accepted, STAGE, d.base) : false;
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
