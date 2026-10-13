/**
 * Scene-level storyboard diff (shown in the panel and returned to the director
 * after each write, so both sides see what a new version changed).
 */

import type { Storyboard, Target } from "./types.ts";

export interface StoryboardDiff {
  from: number;
  to: number;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
  /** Scene order changed among scenes present in both versions. */
  reordered: boolean;
}

export function diffStoryboards(prev: Storyboard, next: Storyboard): StoryboardDiff {
  const prevById = new Map(prev.scenes.map((s) => [s.id, s]));
  const nextIds = new Set(next.scenes.map((s) => s.id));
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const scene of next.scenes) {
    const old = prevById.get(scene.id);
    if (!old) added.push(scene.id);
    else if (JSON.stringify(old) !== JSON.stringify(scene)) changed.push(scene.id);
    else unchanged.push(scene.id);
  }
  const removed = prev.scenes.filter((s) => !nextIds.has(s.id)).map((s) => s.id);
  const commonPrev = prev.scenes.map((s) => s.id).filter((id) => nextIds.has(id));
  const commonNext = next.scenes.map((s) => s.id).filter((id) => prevById.has(id));
  return {
    from: prev.version,
    to: next.version,
    added,
    removed,
    changed,
    unchanged,
    reordered: commonPrev.join("\u0000") !== commonNext.join("\u0000"),
  };
}

export function formatDiff(d: StoryboardDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`added ${d.added.join(", ")}`);
  if (d.removed.length) parts.push(`removed ${d.removed.join(", ")}`);
  if (d.changed.length) parts.push(`changed ${d.changed.join(", ")}`);
  if (d.reordered) parts.push("reordered");
  return parts.length
    ? `v${d.from} → v${d.to}: ${parts.join("; ")}`
    : `v${d.from} → v${d.to}: no scene changes`;
}

/** Every target referenced by a storyboard (for linting against discovery). */
export function storyboardTargets(
  sb: Storyboard,
): { scene: string; step: number; target: Target }[] {
  const out: { scene: string; step: number; target: Target }[] = [];
  for (const scene of sb.scenes) {
    scene.steps.forEach((step, i) => {
      if ("target" in step && step.target)
        out.push({ scene: scene.id, step: i, target: step.target });
      if (step.do === "wait" && !("ms" in step.for))
        out.push({ scene: scene.id, step: i, target: step.for });
    });
  }
  return out;
}
