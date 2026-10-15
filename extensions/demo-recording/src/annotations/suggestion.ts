/**
 * Raw suggestion JSON (from the tool call or from a separate designer run,
 * S5 part 12) → a clean `Suggestion`: exactly one anchor kind and one target
 * kind, no undefined keys, scores clamped.
 */

import type { Suggestion } from "./design.ts";
import type { AnnotationItem, AnnotationTarget } from "./types.ts";

/** Drop undefined keys and keep exactly one anchor kind / target kind. */
function cleanAnchor(a: Record<string, unknown>): AnnotationItem["anchor"] {
  const off = typeof a.offsetMs === "number" && a.offsetMs ? { offsetMs: a.offsetMs } : {};
  if (typeof a.mark === "string") return { mark: a.mark, ...off };
  if (typeof a.word === "string")
    return {
      word: a.word,
      ...(typeof a.occurrence === "number" ? { occurrence: a.occurrence } : {}),
      ...off,
    };
  return { sceneStart: true, ...off };
}
function cleanTarget(t: Record<string, unknown> | undefined): AnnotationTarget | undefined {
  if (!t) return undefined;
  if (typeof t.step === "number") return { step: t.step };
  if (typeof t.layout === "string") return { layout: t.layout };
  if (t.box && typeof t.box === "object")
    return { box: t.box as { x: number; y: number; w: number; h: number } };
  if (typeof t.text === "string")
    return { text: t.text, ...(typeof t.role === "string" ? { role: t.role } : {}) };
  return undefined;
}

function agentScore(v: unknown): { score: number; why?: string } | undefined {
  const o = (typeof v === "number" ? { score: v } : v) as
    | { score?: unknown; why?: unknown }
    | undefined;
  if (!o || typeof o.score !== "number") return undefined;
  const score = Math.min(5, Math.max(1, Math.round(o.score)));
  return { score, ...(typeof o.why === "string" && o.why.trim() ? { why: o.why.trim() } : {}) };
}

export function toSuggestion(raw: Record<string, unknown>): Suggestion {
  const target = cleanTarget(raw.target as Record<string, unknown> | undefined);
  const alternatives = Array.isArray(raw.alternatives)
    ? (raw.alternatives as Record<string, unknown>[])
        .map(cleanTarget)
        .filter((x): x is AnnotationTarget => !!x)
    : undefined;
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    type: raw.type as Suggestion["type"],
    scene: raw.scene as string,
    anchor: cleanAnchor((raw.anchor ?? {}) as Record<string, unknown>),
    ...(target ? { target } : {}),
    ...(alternatives?.length ? { alternatives } : {}),
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    ...(typeof raw.durMs === "number" ? { durMs: raw.durMs } : {}),
    ...(typeof raw.factor === "number" ? { factor: raw.factor } : {}),
    value: typeof raw.value === "number" ? raw.value : 3,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    ...(agentScore(raw.confidence)
      ? { confidence: agentScore(raw.confidence) as { score: number; why?: string } }
      : {}),
  };
}
