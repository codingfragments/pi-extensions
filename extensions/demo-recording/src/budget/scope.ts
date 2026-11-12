/**
 * Discovery and scope against the length budget (item 22 PR 2, D-R3-25-15): how many scenes a target holds, and what a set of areas costs in minutes, so a direction that
 * adds or drops scope comes back with its price before anything is built.
 */

import { type LengthBudget, budgetWords, clock, lengthVerdict } from "./length.ts";

/** A scene of a demo is about 60 to 90 s of the final video. */
export const SCENE_SEC = { lo: 60, hi: 90 };

/** How many scenes a target holds: about the target over 60 to 90 s, at least one. */
export function sceneCountFor(targetSec: number): { lo: number; hi: number } {
  return {
    lo: Math.max(1, Math.round(targetSec / SCENE_SEC.hi)),
    hi: Math.max(1, Math.round(targetSec / SCENE_SEC.lo)),
  };
}

/** The budget as a plan for discovery: "10:00 (8:30 to 11:00): about 7 to 10 scenes of 60 to 90 s". */
export function budgetPlanWords(b: LengthBudget): string {
  const n = sceneCountFor(b.targetSec);
  return `${budgetWords(b)}: about ${n.lo === n.hi ? n.lo : `${n.lo} to ${n.hi}`} scene${n.hi === 1 ? "" : "s"} of ${SCENE_SEC.lo} to ${SCENE_SEC.hi} s`;
}

/** The price of a number of areas, one scene each at 60 to 90 s, against the budget. */
export function priceAreas(count: number, b: LengthBudget): string {
  const lo = count * SCENE_SEC.lo;
  const hi = count * SCENE_SEC.hi;
  const vLo = lengthVerdict(lo, b);
  const vHi = lengthVerdict(hi, b);
  const fit =
    vLo === "fits" || vHi === "fits" || (vLo === "short" && vHi === "long")
      ? "fits"
      : vHi === "short"
        ? `short: about ${clock(b.floorSec - hi)} more is needed (another area or more depth)`
        : `over: about ${clock(lo - b.ceilingSec)} too much (drop an area or keep some short)`;
  return `${count} area${count === 1 ? "" : "s"} at one scene each: about ${clock(lo)} to ${clock(hi)} against the budget of ${budgetWords(b)}: ${fit}`;
}

/** Does a direction change the scope (add or drop areas or flows)? Rough, on purpose: it only decides whether the Director is reminded to price it. */
export function changesScope(text: string): boolean {
  return /\b(add|adding|also show|more on|more of|include|cover|extend|expand|drop|remove|skip|leave out|cut|without|another (?:area|flow|path|scene))\b/i.test(
    text,
  );
}

export const PRICE_IT =
  'If this adds or drops scope, give its price first: about 60 to 90 s a scene, and the new total against the length budget (e.g. "adds about 6:30, total 11:20 against 10:00 (8:30 to 11:00): over"), before you build it.';
