/**
 * Holds (item 22, D-R3-25-8): staying on a result so a scene meets its `time`. The recorder and the storyboard's projection use the same rule, so what the Storyboard tab
 * projects is what the recorder will do:
 *   - the hold points are the steps with `hold`, else (when the scene has a `time`) its last step;
 *   - at a hold point the recorder holds the step's own `hold`, or more when the scene is behind its time: the gap left, spread over the points still to come;
 *   - one hold is at most 6 s, and the holds of a scene never add up to more than a third of its time: past that the scene is too thin, and it is reported short
 *     instead of padded (the Director adds depth, it does not stretch stills).
 */

import { HOLD_MAX_MS } from "../storyboard/parse.ts";
import type { Scene } from "../storyboard/types.ts";

export { HOLD_MAX_MS };
/** The most of a scene's time its holds may take. */
export const HOLD_SHARE = 1 / 3;

/** The step indices where this scene may hold. */
export function holdPoints(scene: Pick<Scene, "steps" | "time">): number[] {
  const marked = scene.steps.flatMap((s, i) => (s.hold !== undefined ? [i] : []));
  if (marked.length) return marked;
  return scene.time !== undefined && scene.steps.length ? [scene.steps.length - 1] : [];
}

/**
 * How long to hold at one point. `elapsedMs` is the scene's time so far (this step included), `remainingMs` what the steps after it are expected to take, `heldMs` what
 * the scene has held already, `pointsLeft` the hold points from this one on (this one included).
 */
export function holdAt(o: {
  timeMs?: number;
  explicitMs?: number;
  elapsedMs: number;
  remainingMs: number;
  heldMs: number;
  pointsLeft: number;
}): { ms: number; wantedMs: number; capped: boolean } {
  const explicit = Math.min(o.explicitMs ?? 0, HOLD_MAX_MS);
  let wanted = explicit;
  if (o.timeMs !== undefined) {
    const gap = o.timeMs - o.elapsedMs - o.remainingMs;
    if (gap > 0) wanted = Math.max(explicit, gap / Math.max(1, o.pointsLeft));
  }
  const shareLeft =
    o.timeMs !== undefined
      ? Math.max(0, o.timeMs * HOLD_SHARE - o.heldMs)
      : Number.POSITIVE_INFINITY;
  const ms = Math.round(Math.max(0, Math.min(wanted, HOLD_MAX_MS, shareLeft)));
  return { ms, wantedMs: Math.round(wanted), capped: ms < Math.round(wanted) };
}

/** What a scene will take with its holds, from the steps' estimates: the projection the Storyboard tab shows and the recorder aims at. */
export function planScene(
  scene: Pick<Scene, "steps" | "time">,
  stepMs: number[],
): { stepsMs: number; heldMs: number; plannedMs: number; shortMs: number } {
  const points = holdPoints(scene);
  const stepsMs = stepMs.reduce((a, b) => a + b, 0);
  let elapsed = 0;
  let held = 0;
  for (const [i, ms] of stepMs.entries()) {
    elapsed += ms;
    const k = points.indexOf(i);
    if (k < 0) continue;
    const h = holdAt({
      ...(scene.time !== undefined ? { timeMs: scene.time } : {}),
      ...(scene.steps[i]?.hold !== undefined ? { explicitMs: scene.steps[i]?.hold } : {}),
      elapsedMs: elapsed + held,
      remainingMs: stepMs.slice(i + 1).reduce((a, b) => a + b, 0),
      heldMs: held,
      pointsLeft: points.length - k,
    });
    held += h.ms;
  }
  const plannedMs = stepsMs + held;
  return {
    stepsMs,
    heldMs: held,
    plannedMs,
    shortMs: scene.time !== undefined ? Math.max(0, scene.time - plannedMs) : 0,
  };
}
