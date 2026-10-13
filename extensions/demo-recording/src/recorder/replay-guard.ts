/**
 * Resume replay guard (S4, carried over from the S3 keycraft review).
 *
 * Resuming a scene without `deep_link` replays the previous scenes off-camera.
 * If those scenes change app state (add to cart, send a chat message, save),
 * the replay repeats the change: the cart shows duplicate items and the re-shot
 * scene no longer matches the footage before it. Detect that statically.
 */

import { DENYLIST, MUTATING } from "../browser/safety.ts";
import type { Scene, Step, Target } from "../storyboard/types.ts";

export interface ReplayHazard {
  scene: string;
  step: number;
  reason: string;
}

function targetName(t: Target | undefined): { role?: string; name: string } {
  if (!t) return { name: "" };
  if ("role" in t) return { role: t.role, name: t.name ?? "" };
  if ("text" in t) return { name: t.text };
  if ("label" in t) return { name: t.label };
  return { name: "" };
}

const SUBMITTING_ROLES = new Set(["textbox", "combobox"]);

/** State-changing steps in a scene (static heuristic over the storyboard). */
export function stateChanges(scene: Scene): ReplayHazard[] {
  const out: ReplayHazard[] = [];
  let lastTyped: Target | undefined;
  scene.steps.forEach((step: Step, i) => {
    const at = (reason: string) => out.push({ scene: scene.id, step: i, reason });
    if (step.do === "click") {
      const { role, name } = targetName(step.target);
      if (name && (DENYLIST.test(name) || (MUTATING.test(name) && role !== "link")))
        at(`click "${name}" changes state`);
    }
    if (step.do === "type") lastTyped = step.target;
    if (step.do === "press" && /^(Enter|NumpadEnter)$/i.test(step.key)) {
      const { role, name } = targetName(lastTyped);
      if (role && SUBMITTING_ROLES.has(role))
        at(`Enter submits ${role} "${name}" (form or chat message)`);
    }
    if (step.do === "improvise" && step.submit) {
      const { role, name } = targetName(step.target);
      if (!role || SUBMITTING_ROLES.has(role)) at(`improvised input into "${name}" is submitted`);
    }
  });
  return out;
}

/**
 * Hazards when resuming scene `k` by replaying scenes 0..k-1. Empty when the
 * scene has a deep_link (no replay needed) or the replayed scenes are safe.
 */
export function replayHazards(scenes: Scene[], k: number): ReplayHazard[] {
  const scene = scenes[k];
  if (!scene || scene.deep_link) return [];
  return scenes.slice(0, k).flatMap(stateChanges);
}

/** Scenes that could not be resumed safely (for storyboard-write warnings). */
export function unsafeResumeScenes(scenes: Scene[]): { scene: string; hazards: ReplayHazard[] }[] {
  return scenes
    .map((s, k) => ({ scene: s.id, hazards: replayHazards(scenes, k) }))
    .filter((x) => x.hazards.length > 0);
}
