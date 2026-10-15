/**
 * Annotation confidence (D78, D80):
 *   low    a redaction (privacy always needs your eyes) · a box target · it can't be placed
 *   medium a text target (no layout ref) · callout/chapter wording · new vs the base version
 *   high   a step or layout-ref target, no warnings
 * Annotations get badges, "needs eyes" and sorting only — no bulk approve.
 */

import type { AnnotationFile } from "../annotations/types.ts";
import { type ConfidenceSummary, type Reason, judge, summarize } from "./level.ts";

export function annotationConfidence(
  file: AnnotationFile,
  placement: Record<string, { problem: string } | object>,
  base?: { version: number; ids: string[] },
): ConfidenceSummary {
  const known = base ? new Set(base.ids) : undefined;
  const items = file.items.map((it) => {
    const r: Reason[] = [];
    if (it.type === "redact")
      r.push({ level: "low", text: "a redaction — check that the blur covers what it should" });
    const problem = (placement[it.id] as { problem?: string } | undefined)?.problem;
    if (problem) r.push({ level: "low", text: `can't be placed: ${problem}` });
    const t = it.target;
    if (t && "box" in t) r.push({ level: "low", text: "a fixed box, not tied to an element" });
    else if (t && "text" in t)
      r.push({ level: "medium", text: `found by its text (“${t.text}”), not a layout ref` });
    if ((it.type === "callout" || it.type === "chapter") && it.text)
      r.push({ level: "medium", text: `wording: “${it.text}”` });
    if (known && !known.has(it.id))
      r.push({ level: "medium", text: `new since v${base?.version}` });
    return judge(it.id, r, it.confidence);
  });
  return summarize(items);
}

/** The version an annotation version is compared with (its edit/re-suggest/import base, else the previous one). */
export function annotationBase(file: AnnotationFile, versions: number[]): number | undefined {
  return (
    file.editedFrom ??
    file.resuggestedFrom ??
    file.importedFrom ??
    versions.filter((v) => v < file.version).at(-1)
  );
}
