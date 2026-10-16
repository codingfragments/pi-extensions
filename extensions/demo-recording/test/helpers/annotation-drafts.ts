/**
 * The annotation draft API as the older tests used it (one draft, no revisions), on top of the draft
 * contract (src/drafts/annotations.ts): each call reads the current revision first, so these helpers never
 * conflict. Tests about revisions and conflicts (ux6-annotation-drafts.test.ts) use the real API.
 */

import type { DraftOp } from "../../src/annotations/draft.ts";
import { readAnnotations } from "../../src/annotations/file.ts";
import {
  type AnnotationWorkingDraft,
  discardAnnotationDraft,
  editAnnotationDraft,
  listAnnotationDrafts,
  preferredAnnotationDraft,
  readAnnotationDraft,
  saveAnnotationDraftAsVersion,
} from "../../src/drafts/annotations.ts";

export function editDraft(dir: string, base: number, op: DraftOp): AnnotationWorkingDraft {
  const cur = readAnnotationDraft(dir, base);
  const d = editAnnotationDraft(dir, base, op, { expected: cur?.revision ?? null, author: "test" });
  if (!d) throw new Error("the edit changed nothing");
  return d;
}

/** The draft the line (or the latest edit) is about, like the panel's "unsaved changes". */
export const readDraft = (dir: string): AnnotationWorkingDraft | undefined =>
  preferredAnnotationDraft(dir, undefined);

export function saveDraft(dir: string) {
  const d = readDraft(dir);
  if (!d) throw new Error("no unsaved annotation changes");
  const r = saveAnnotationDraftAsVersion(dir, d.base, d.revision);
  return readAnnotations(dir, r.version) as NonNullable<ReturnType<typeof readAnnotations>>;
}

export function discardDraft(dir: string): boolean {
  const d = readDraft(dir);
  if (!d) return false;
  discardAnnotationDraft(dir, d.base, d.revision);
  return true;
}

export const allDrafts = listAnnotationDrafts;
