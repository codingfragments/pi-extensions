/**
 * The annotation draft (S5 part 8, D58): panel edits accumulate in
 * `annotations/draft.json` on top of a version; "Save" writes ONE new version
 * with every change recorded in the items' `edits`, "Discard" drops it. The
 * draft survives panel reloads and restarts.
 */

import fs from "node:fs";
import path from "node:path";
import { annotationsDir, readAnnotations, validateAnnotations, writeAnnotations } from "./file.ts";
import {
  type AnnotationEdit,
  type AnnotationFile,
  type AnnotationItem,
  DEFAULT_DURATION,
  MAX_TEXT,
  MAX_ZOOMS,
} from "./types.ts";

export interface AnnotationDraft {
  /** The version the draft started from. */
  base: number;
  updatedAt: string;
  file: AnnotationFile;
  /** Number of edits since the base. */
  changes: number;
}

const draftFile = (projectDir: string) => path.join(annotationsDir(projectDir), "draft.json");

export function readDraft(projectDir: string): AnnotationDraft | undefined {
  const f = draftFile(projectDir);
  if (!fs.existsSync(f)) return undefined;
  return JSON.parse(fs.readFileSync(f, "utf8")) as AnnotationDraft;
}

export function discardDraft(projectDir: string): boolean {
  const f = draftFile(projectDir);
  if (!fs.existsSync(f)) return false;
  fs.rmSync(f);
  return true;
}

export type DraftOp =
  | { op: "toggle"; id: string; enabled?: boolean }
  | { op: "text"; id: string; text: string }
  /** ±ms on the anchor (start) or the duration. */
  | { op: "nudge"; id: string; field: "start" | "duration"; deltaMs: number }
  /** Swap in alternative n (0-based) as the target; the old target becomes an alternative. */
  | { op: "target"; id: string; alternative: number };

/** Apply one edit to a draft (created from `base` when there is none, or when it is for another version). */
export function editDraft(
  projectDir: string,
  base: number,
  op: DraftOp,
  now = new Date(),
): AnnotationDraft {
  let d = readDraft(projectDir);
  if (!d || d.base !== base) {
    const file = readAnnotations(projectDir, base);
    if (!file) throw new Error(`annotations v${base} do not exist`);
    d = { base, updatedAt: now.toISOString(), file, changes: 0 };
  }
  const it = d.file.items.find((x) => x.id === op.id);
  if (!it) throw new Error(`annotation ${op.id} is not in v${base}`);
  const edit = (field: AnnotationEdit["field"], from: unknown) => {
    it.edits = [...(it.edits ?? []), { at: now.toISOString(), field, from }];
  };
  if (op.op === "toggle") {
    const next = op.enabled ?? !it.enabled;
    if (next === it.enabled) return d;
    if (
      next &&
      it.type === "zoom" &&
      d.file.items.filter((x) => x.enabled && x.type === "zoom").length >= MAX_ZOOMS
    )
      throw new Error(`at most ${MAX_ZOOMS} zooms per demo — turn another zoom off first`);
    edit("enabled", it.enabled);
    it.enabled = next;
  } else if (op.op === "text") {
    if (it.type !== "callout" && it.type !== "chapter") throw new Error(`${it.type} has no text`);
    const text = op.text.trim();
    if (!text) throw new Error("the text can't be empty");
    if (text.length > MAX_TEXT)
      throw new Error(`≤ ${MAX_TEXT} characters — it marks, it doesn't narrate`);
    if (text === it.text) return d;
    edit("text", it.text);
    it.text = text;
    it.origin = "edited";
  } else if (op.op === "nudge") {
    if (!Number.isFinite(op.deltaMs) || Math.abs(op.deltaMs) > 10000)
      throw new Error("deltaMs must be within ±10 s");
    if (op.field === "start") {
      const prev = it.anchor.offsetMs ?? 0;
      edit("start", prev);
      it.anchor = { ...it.anchor, offsetMs: prev + op.deltaMs } as AnnotationItem["anchor"];
    } else {
      const prev = it.durMs ?? DEFAULT_DURATION[it.type];
      if (prev === 0)
        throw new Error(
          "a redaction lasts to the end of the scene (or the next page change) — no duration to nudge",
        );
      const next = Math.max(500, Math.min(30000, prev + op.deltaMs));
      edit("duration", it.durMs);
      it.durMs = next;
    }
    it.origin = "edited";
  } else if (op.op === "target") {
    const alt = it.alternatives?.[op.alternative];
    if (!alt) throw new Error(`${it.id} has no alternative target ${op.alternative + 1}`);
    edit("target", it.target);
    const old = it.target;
    it.alternatives = (it.alternatives ?? []).map((a, i) =>
      i === op.alternative && old ? old : a,
    );
    it.target = alt;
    it.origin = "edited";
  }
  validateAnnotations(d.file);
  d.changes += 1;
  d.updatedAt = now.toISOString();
  fs.mkdirSync(annotationsDir(projectDir), { recursive: true });
  fs.writeFileSync(draftFile(projectDir), `${JSON.stringify(d, null, 2)}\n`);
  return d;
}

/** Save the draft as the next version (one version for all edits). */
export function saveDraft(projectDir: string): AnnotationFile {
  const d = readDraft(projectDir);
  if (!d) throw new Error("no unsaved annotation changes");
  const { version: _v, ...rest } = d.file;
  const stored = writeAnnotations(projectDir, { ...rest, by: "user edits", editedFrom: d.base });
  discardDraft(projectDir);
  return stored;
}
