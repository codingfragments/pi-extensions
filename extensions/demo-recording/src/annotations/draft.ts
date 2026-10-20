/**
 * Edits of an annotation draft (S5 part 8, D58; UX6a, D122). This file holds the edit operations only:
 * what a toggle, a text change, a nudge, a target swap or a reset does to a copy of an annotation file,
 * with their validation. Where a draft lives, its revisions and conflicts are in
 * src/drafts/annotations.ts (one draft per base version, like the voice-over's).
 */

import { validateAnnotations } from "./file.ts";
import {
  type AnnotationEdit,
  type AnnotationFile,
  type AnnotationItem,
  type AnnotationTarget,
  DEFAULT_DURATION,
  MAX_TEXT,
} from "./types.ts";
import { DEFAULT_ZOOM_LIMITS, type ZoomLimits, zoomRefusal } from "./zoom-limits.ts";

export type DraftOp =
  | { op: "toggle"; id: string; enabled?: boolean }
  | { op: "text"; id: string; text: string }
  /** ±ms on the anchor (start) or the duration. */
  | { op: "nudge"; id: string; field: "start" | "duration"; deltaMs: number }
  /** Swap in alternative n (0-based) as the target; the old target becomes an alternative. */
  | { op: "target"; id: string; alternative: number }
  /** Back to how the designer suggested it (D122): every recorded change of the item undone. */
  | { op: "reset"; id: string };

const sameTarget = (a: AnnotationTarget, b: AnnotationTarget) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Can this item be reset: it was suggested, and the user changed it. */
/** The zoom limits in force and the length of the demo (ms) they are measured against; both optional (the defaults, an 80 s demo). */
export interface ZoomGuard {
  limits?: ZoomLimits;
  durationMs?: number;
}

export function canReset(it: AnnotationItem): boolean {
  return (
    it.origin !== "manual" &&
    !(it.edits ?? []).some((e) => e.field === "added") &&
    (it.edits ?? []).some((e) => e.field !== "added")
  );
}

/**
 * Apply one edit to `file` in place (the caller passes a copy). Returns false when it changed nothing.
 * Throws, leaving `file` valid, when the edit is not allowed.
 */
export function applyDraftOp(
  file: AnnotationFile,
  op: DraftOp,
  now = new Date(),
  guard: ZoomGuard = {},
): boolean {
  const limits = guard.limits ?? DEFAULT_ZOOM_LIMITS;
  const it = file.items.find((x) => x.id === op.id);
  if (!it) throw new Error(`annotation ${op.id} is not in this version`);
  const before = JSON.stringify(it);
  const edit = (field: AnnotationEdit["field"], from: unknown) => {
    it.edits = [...(it.edits ?? []), { at: now.toISOString(), field, from }];
  };
  if (op.op === "toggle") {
    const next = op.enabled ?? !it.enabled;
    if (next === it.enabled) return false;
    if (next && it.type === "zoom") {
      const why = zoomRefusal(file.items, it, limits, guard.durationMs);
      if (why) throw new Error(why);
    }
    edit("enabled", it.enabled);
    it.enabled = next;
  } else if (op.op === "text") {
    if (it.type !== "callout" && it.type !== "chapter") throw new Error(`${it.type} has no text`);
    const text = op.text.trim();
    if (!text) throw new Error("the text can't be empty");
    if (text.length > MAX_TEXT)
      throw new Error(`≤ ${MAX_TEXT} characters — it marks, it doesn't narrate`);
    if (text === it.text) return false;
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
  } else if (op.op === "reset") {
    if (!canReset(it))
      throw new Error(
        it.origin === "manual" || (it.edits ?? []).some((e) => e.field === "added")
          ? `${it.id} was added by hand: it has no suggested version to go back to`
          : `${it.id} has not been changed`,
      );
    // the first recorded `from` of a field is how the designer suggested it
    const first = (f: AnnotationEdit["field"]) => (it.edits ?? []).find((e) => e.field === f);
    const enabled = first("enabled");
    const text = first("text");
    const start = first("start");
    const duration = first("duration");
    const target = first("target");
    if (enabled) {
      if (enabled.from === true && it.type === "zoom" && !it.enabled) {
        const why = zoomRefusal(file.items, it, limits, guard.durationMs);
        if (why) throw new Error(why);
      }
      it.enabled = enabled.from === true;
    }
    if (text) it.text = text.from as string;
    if (start)
      it.anchor = {
        ...it.anchor,
        offsetMs: (start.from as number) ?? 0,
      } as AnnotationItem["anchor"];
    if (duration) {
      if (duration.from === undefined) Reflect.deleteProperty(it, "durMs");
      else it.durMs = duration.from as number;
    }
    if (target?.from && it.target) {
      const original = target.from as AnnotationTarget;
      const current = it.target;
      it.alternatives = (it.alternatives ?? []).map((a) => (sameTarget(a, original) ? current : a));
      it.target = original;
    }
    Reflect.deleteProperty(it, "edits");
    it.origin = "suggested";
  }
  validateAnnotations(file);
  return JSON.stringify(it) !== before;
}
