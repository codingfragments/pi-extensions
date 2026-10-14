/**
 * Weights, recommended set and budget (S5 part 8, Q7, D36).
 *
 *   noise   deterministic per type × duration
 *   value   1–5 from the designer, +1 when it matches an `emphasis` hint or a
 *           VO anchor/word (cap 5)
 *   recommended set   greedy by value/noise within the caps and the 2× ratio
 *   budget  enabled noise vs. the optimum: balanced within ±25 %
 */

import type { ResolvedAnnotation } from "./resolve.ts";
import { type AnnotationItem, type AnnotationType, DEFAULT_DURATION, MAX_ZOOMS } from "./types.ts";

export const BASE_NOISE: Record<AnnotationType, number> = {
  callout: 1.0,
  highlight: 0.6,
  zoom: 1.5,
  spotlight: 2.0,
  chapter: 0,
  redact: 0,
};

/** Chapters and redactions are structure / privacy, not emphasis: outside the budget (D35). */
export const counted = (t: AnnotationType) => t !== "chapter" && t !== "redact";

export function noiseOf(it: Pick<AnnotationItem, "type" | "durMs">): number {
  const base = BASE_NOISE[it.type];
  if (!base) return 0;
  const def = DEFAULT_DURATION[it.type];
  const extra =
    it.durMs !== undefined && def > 0 && it.durMs > def ? 0.5 * ((it.durMs - def) / def) : 0;
  return Math.round((base + extra) * 100) / 100;
}

/** What the storyboard and VO stress, per scene. */
export interface Emphasis {
  /** scene → marks of steps that carry an `emphasis` hint. */
  stepMarks: Record<string, Set<string>>;
  /** scene → step indices that carry an `emphasis` hint. */
  steps: Record<string, Set<number>>;
  /** scene → mark ("" = scene start) → the narration spoken from that anchor. */
  voText: Record<string, Record<string, string>>;
}

const STOP = new Set([
  "this",
  "that",
  "with",
  "from",
  "they",
  "there",
  "their",
  "what",
  "when",
  "into",
  "just",
  "about",
  "than",
  "then",
  "have",
  "here",
  "your",
  "only",
  "also",
  "very",
]);
/** Content words and numbers of a text (for the VO match). */
export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\{\{[^}]*\}\}/g, " ")
      .split(/[^\p{L}\p{N}.%]+/u)
      .map((w) => w.replace(/^[.%]+|[.]+$/g, ""))
      .filter((w) => (w.length >= 4 && !STOP.has(w)) || /\d/.test(w)),
  );
}

/**
 * +1 (Q7): the item matches an `emphasis` hint, is anchored to a spoken word,
 * or the narration at its anchor mentions what it shows (`shows`: the target
 * element's text, a callout/chapter text). Spotlights never get the bonus —
 * they need a designer value of 5 on their own (D35).
 */
export function valueBonus(
  it: AnnotationItem,
  e: Emphasis,
  shows = "",
): { bonus: number; why?: string } {
  if (it.type === "spotlight") return { bonus: 0 };
  const a = it.anchor;
  const t = it.target;
  if (
    (t && "step" in t && e.steps[it.scene]?.has(t.step)) ||
    ("mark" in a && e.stepMarks[it.scene]?.has(a.mark))
  )
    return { bonus: 1, why: "matches an emphasis hint" };
  if ("word" in a) return { bonus: 1, why: "anchored to a spoken word" };
  const said = e.voText[it.scene]?.["mark" in a ? a.mark : ""];
  if (said) {
    const spoken = contentWords(said);
    const hit = [...contentWords(`${shows} ${it.text ?? ""}`)].find((w) => spoken.has(w));
    if (hit) return { bonus: 1, why: `the narration mentions “${hit}” here` };
  }
  return { bonus: 0 };
}

const overlaps = (a: ResolvedAnnotation, b: ResolvedAnnotation) => {
  if (a.scene !== b.scene || a.startMs >= b.endMs || b.startMs >= a.endMs) return false;
  if (!a.box || !b.box) return a.type === b.type; // two callouts at once count as overlapping
  return (
    a.box.x < b.box.x + b.box.w &&
    b.box.x < a.box.x + a.box.w &&
    a.box.y < b.box.y + b.box.h &&
    b.box.y < a.box.y + a.box.h
  );
};

/**
 * The recommended (pre-enabled) set: about half of the counted suggestions,
 * best value per noise first, never two zooms beyond the cap, never two items
 * on the same region at the same time; spotlight only at value 5.
 */
export function recommend(
  items: AnnotationItem[],
  resolved: ResolvedAnnotation[],
  /** Items whose state the user decided (kept on re-suggest): on = pre-picked, off = never picked. */
  fixed: { on: Set<string>; off: Set<string> } = { on: new Set(), off: new Set() },
): Set<string> {
  const byId = new Map(resolved.map((r) => [r.id, r]));
  const picked: ResolvedAnnotation[] = [];
  const out = new Set<string>();
  let zooms = 0;
  for (const it of items)
    if (fixed.on.has(it.id) && counted(it.type)) {
      out.add(it.id);
      const r = byId.get(it.id);
      if (r) picked.push(r);
      if (it.type === "zoom") zooms++;
    }
  const cands = items
    .filter(
      (it) => counted(it.type) && byId.has(it.id) && !fixed.on.has(it.id) && !fixed.off.has(it.id),
    )
    .filter((it) => it.type !== "spotlight" || (it.weight?.value ?? 0) >= 5)
    .sort((a, b) => {
      // Must-haves (value 5) first, then the best value per noise (Q7; ties: higher value).
      const fa = (a.weight?.value ?? 0) >= 5 ? 1 : 0;
      const fb = (b.weight?.value ?? 0) >= 5 ? 1 : 0;
      const ra = (a.weight?.value ?? 1) / Math.max(0.1, a.weight?.noise ?? noiseOf(a));
      const rb = (b.weight?.value ?? 1) / Math.max(0.1, b.weight?.noise ?? noiseOf(b));
      return fb - fa || rb - ra || (b.weight?.value ?? 0) - (a.weight?.value ?? 0);
    });
  const target = Math.ceil(items.filter((it) => counted(it.type)).length / 2);
  for (const it of cands) {
    if (out.size >= target) break;
    const r = byId.get(it.id) as ResolvedAnnotation;
    if (it.type === "zoom" && zooms >= MAX_ZOOMS) continue;
    if (picked.some((p) => overlaps(p, r))) continue;
    picked.push(r);
    out.add(it.id);
    if (it.type === "zoom") zooms++;
  }
  return out;
}

export type BudgetStatus = "balanced" | "too quiet" | "too busy";

export interface Budget {
  noise: number;
  optimum: number;
  status: BudgetStatus;
  /** Enabled value / total suggested value (counted types), 0–1. */
  valueCaptured: number;
  enabled: number;
  suggested: number;
}

export function budgetOf(items: AnnotationItem[], optimum: number): Budget {
  const c = items.filter((it) => counted(it.type));
  const on = c.filter((it) => it.enabled);
  const noise =
    Math.round(on.reduce((s, it) => s + (it.weight?.noise ?? noiseOf(it)), 0) * 100) / 100;
  const total = c.reduce((s, it) => s + (it.weight?.value ?? 1), 0);
  const got = on.reduce((s, it) => s + (it.weight?.value ?? 1), 0);
  const lo = optimum * 0.75;
  const hi = optimum * 1.25;
  const status: BudgetStatus =
    noise < lo - 1e-9 ? "too quiet" : noise > hi + 1e-9 ? "too busy" : "balanced";
  return {
    noise,
    optimum,
    status,
    valueCaptured: total ? got / total : 0,
    enabled: on.length,
    suggested: c.length,
  };
}

export const formatBudget = (b: Budget) =>
  `noise ${b.noise} / optimum ${b.optimum} · ${b.status} · value captured ${Math.round(b.valueCaptured * 100)} % (${b.enabled}/${b.suggested} enabled)`;
