/**
 * Compare two versions (item 9, D-R2-11, R2-3): the facts. Deterministic and free: what exists in each version, what was
 * added, removed or changed, as numbers and named items. The Director's verdict (9b) is written on top of these facts and
 * must name items from `evidence`, so "honest" is checkable: an evidence id that is not here is refused.
 * Storyboard and voice-over only (recording, annotations and render are the long tail).
 */

import { diffStoryboards } from "../storyboard/diff.ts";
import { readStoryboard } from "../storyboard/store.ts";
import type { Scene, Storyboard } from "../storyboard/types.ts";
import { wordDiff } from "../util/worddiff.ts";
import { wordCount } from "../vo/script.ts";
import { readVo } from "../vo/store.ts";

export type CompareStage = "storyboard" | "vo";
export const COMPARE_STAGES: readonly CompareStage[] = ["storyboard", "vo"];

export interface CompareFact {
  id: string;
  label: string;
  a: number | string | null;
  b: number | string | null;
  /** b − a for numbers. */
  delta?: number;
}

export interface CompareChange {
  /** `scene:<id>`, `section:<key>` or `order`: what a verdict may cite. */
  id: string;
  kind: "added" | "removed" | "changed" | "same" | "reordered";
  label: string;
  /** What differs, in words and numbers. */
  detail: string;
}

export interface Comparison {
  stage: CompareStage;
  a: number;
  b: number;
  facts: CompareFact[];
  changes: CompareChange[];
  /** Every id a verdict may cite: `fact:<id>`, the change ids. */
  evidence: string[];
}

const fact = (
  id: string,
  label: string,
  a: number | string | null,
  b: number | string | null,
): CompareFact => ({
  id,
  label,
  a,
  b,
  ...(typeof a === "number" && typeof b === "number" ? { delta: +(b - a).toFixed(2) } : {}),
});

const evidenceOf = (facts: CompareFact[], changes: CompareChange[]) => [
  ...facts.map((f) => `fact:${f.id}`),
  ...changes.map((c) => c.id),
];

// ---------------------------------------------------------------- storyboard

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const steps = (sb: Storyboard) => sb.scenes.flatMap((s) => s.steps);
const marksOf = (s: Scene) => s.steps.map((x) => x.mark).filter(Boolean) as string[];
const improvised = (sb: Storyboard) =>
  steps(sb).filter((s) => s.do === "improvise" || (s as { improvise?: unknown }).improvise).length;
const goals = (sb: Storyboard) => sb.scenes.filter((s) => s.takeaway || s.emphasis).length;
const findingsCovered = (sb: Storyboard) =>
  new Set(sb.scenes.flatMap((s) => s.findings ?? [])).size;

/** What differs in a scene present in both versions, as words. */
function sceneDetail(a: Scene, b: Scene): string {
  const parts: string[] = [];
  if (a.title !== b.title) parts.push(`title “${a.title}” → “${b.title}”`);
  if ((a.takeaway ?? "") !== (b.takeaway ?? ""))
    parts.push(
      a.takeaway && b.takeaway
        ? "takeaway reworded"
        : b.takeaway
          ? "takeaway added"
          : "takeaway removed",
    );
  if ((a.emphasis ?? "") !== (b.emphasis ?? ""))
    parts.push(
      a.emphasis && b.emphasis
        ? "emphasis reworded"
        : b.emphasis
          ? "emphasis added"
          : "emphasis removed",
    );
  if (a.steps.length !== b.steps.length) parts.push(`steps ${a.steps.length} → ${b.steps.length}`);
  const ma = marksOf(a);
  const mb = marksOf(b);
  const gone = ma.filter((m) => !mb.includes(m));
  const fresh = mb.filter((m) => !ma.includes(m));
  if (gone.length) parts.push(`marks removed: ${gone.join(", ")}`);
  if (fresh.length) parts.push(`marks added: ${fresh.join(", ")}`);
  if (JSON.stringify(a.findings ?? []) !== JSON.stringify(b.findings ?? []))
    parts.push(`findings ${(a.findings ?? []).length} → ${(b.findings ?? []).length}`);
  if (JSON.stringify(a.narration_outline ?? []) !== JSON.stringify(b.narration_outline ?? []))
    parts.push("narration outline changed");
  if (!parts.length)
    parts.push(
      a.steps.length === b.steps.length && JSON.stringify(a.steps) !== JSON.stringify(b.steps)
        ? "steps changed (targets, text or timing)"
        : "details changed",
    );
  return parts.join("; ");
}

export function compareStoryboardData(a: Storyboard, b: Storyboard): Comparison {
  const d = diffStoryboards(a, b);
  const sa = new Map(a.scenes.map((s) => [s.id, s]));
  const sb = new Map(b.scenes.map((s) => [s.id, s]));
  const facts = [
    fact("scenes", "Scenes", a.scenes.length, b.scenes.length),
    fact("steps", "Steps", steps(a).length, steps(b).length),
    fact(
      "marks",
      "Marks (anchors for the narration)",
      a.scenes.flatMap(marksOf).length,
      b.scenes.flatMap(marksOf).length,
    ),
    fact("improvised", "Improvised inputs", improvised(a), improvised(b)),
    fact("goals", "Scenes with a goal or emphasis", goals(a), goals(b)),
    fact("findings", "Findings the scenes cover", findingsCovered(a), findingsCovered(b)),
    ...(a.title !== b.title ? [fact("title", "Title", a.title ?? null, b.title ?? null)] : []),
  ];
  const changes: CompareChange[] = [];
  for (const id of d.removed)
    changes.push({
      id: `scene:${id}`,
      kind: "removed",
      label: sa.get(id)?.title ?? id,
      detail: `scene ${id} is gone (${plural(sa.get(id)?.steps.length ?? 0, "step")})`,
    });
  for (const id of d.added)
    changes.push({
      id: `scene:${id}`,
      kind: "added",
      label: sb.get(id)?.title ?? id,
      detail: `new scene ${id} (${plural(sb.get(id)?.steps.length ?? 0, "step")})`,
    });
  for (const id of d.changed)
    changes.push({
      id: `scene:${id}`,
      kind: "changed",
      label: sb.get(id)?.title ?? id,
      detail: sceneDetail(sa.get(id) as Scene, sb.get(id) as Scene),
    });
  if (d.reordered)
    changes.push({
      id: "order",
      kind: "reordered",
      label: "Scene order",
      detail: "the scenes both versions share are in a different order",
    });
  for (const id of d.unchanged)
    changes.push({
      id: `scene:${id}`,
      kind: "same",
      label: sb.get(id)?.title ?? id,
      detail: "no change",
    });
  return {
    stage: "storyboard",
    a: a.version,
    b: b.version,
    facts,
    changes,
    evidence: evidenceOf(facts, changes),
  };
}

// ---------------------------------------------------------------- voice-over

interface VoSide {
  version: number;
  take: string;
  sections: { key: string; body: string; words: number; anchors: number }[];
  speechSec: number;
  usableSec: number;
  over: number;
  issues: number;
}

function readVoSide(projectDir: string, version: number): VoSide {
  const v = readVo(projectDir, version);
  if (!v) throw new Error(`there is no voice-over v${version}`);
  const sections = v.validated.script.sections.map((s, i) => ({
    key: s.key,
    body: s.body,
    words: wordCount(s.body),
    anchors: new Set((v.validated.resolved[i]?.segments ?? []).map((x) => x.anchor).filter(Boolean))
      .size,
  }));
  const timing = v.validated.timing;
  return {
    version,
    take: v.validated.script.take,
    sections,
    speechSec: +timing.reduce((n, t) => n + t.speechSec, 0).toFixed(1),
    usableSec: +timing.reduce((n, t) => n + t.usableSec, 0).toFixed(1),
    over: timing.filter((t) => t.ratio > 1.35).length,
    issues: v.validated.issues.length,
  };
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

export function compareVoData(a: VoSide, b: VoSide): Comparison {
  const total = (s: VoSide) => s.sections.reduce((n, x) => n + x.words, 0);
  const facts = [
    fact("sections", "Sections", a.sections.length, b.sections.length),
    fact("words", "Words", total(a), total(b)),
    fact(
      "anchors",
      "Anchors used",
      a.sections.reduce((n, x) => n + x.anchors, 0),
      b.sections.reduce((n, x) => n + x.anchors, 0),
    ),
    fact("speech", "Speech (estimate, s)", a.speechSec, b.speechSec),
    fact("footage", "Usable footage (s)", a.usableSec, b.usableSec),
    fact("overlong", "Scenes where speech runs well over the footage", a.over, b.over),
    fact("issues", "Warnings and errors", a.issues, b.issues),
    ...(a.take !== b.take ? [fact("take", "Recording it was written from", a.take, b.take)] : []),
  ];
  const byA = new Map(a.sections.map((s) => [s.key, s]));
  const byB = new Map(b.sections.map((s) => [s.key, s]));
  const changes: CompareChange[] = [];
  for (const s of a.sections)
    if (!byB.has(s.key))
      changes.push({
        id: `section:${s.key}`,
        kind: "removed",
        label: s.key,
        detail: `section ${s.key} is gone (${s.words} words)`,
      });
  for (const s of b.sections) {
    const old = byA.get(s.key);
    if (!old) {
      changes.push({
        id: `section:${s.key}`,
        kind: "added",
        label: s.key,
        detail: `new section ${s.key} (${s.words} words)`,
      });
      continue;
    }
    if (norm(old.body) === norm(s.body)) {
      changes.push({ id: `section:${s.key}`, kind: "same", label: s.key, detail: "no change" });
      continue;
    }
    const parts = wordDiff(old.body, s.body);
    const ins = parts.filter((p) => p.op === "ins").reduce((n, p) => n + wordCount(p.text), 0);
    const del = parts.filter((p) => p.op === "del").reduce((n, p) => n + wordCount(p.text), 0);
    const anchors = s.anchors === old.anchors ? "" : `; anchors ${old.anchors} → ${s.anchors}`;
    changes.push({
      id: `section:${s.key}`,
      kind: "changed",
      label: s.key,
      detail: `words ${old.words} → ${s.words} (+${ins} −${del})${anchors}`,
    });
  }
  return {
    stage: "vo",
    a: a.version,
    b: b.version,
    facts,
    changes,
    evidence: evidenceOf(facts, changes),
  };
}

/** The facts of two versions of a stage. Throws when a version does not exist or the stage is not comparable. */
export function compareVersions(
  projectDir: string,
  stage: string,
  a: number,
  b: number,
): Comparison {
  if (!(COMPARE_STAGES as readonly string[]).includes(stage))
    throw new Error(`comparing ${stage} is not available yet (storyboard and voice-over only)`);
  if (!Number.isInteger(a) || !Number.isInteger(b))
    throw new Error("two version numbers are needed");
  if (a === b) throw new Error("pick two different versions");
  if (stage === "storyboard") {
    const sa = readStoryboard(projectDir, a);
    const sb = readStoryboard(projectDir, b);
    if (!sa) throw new Error(`there is no storyboard v${a}`);
    if (!sb) throw new Error(`there is no storyboard v${b}`);
    return compareStoryboardData(sa.storyboard, sb.storyboard);
  }
  return compareVoData(readVoSide(projectDir, a), readVoSide(projectDir, b));
}
