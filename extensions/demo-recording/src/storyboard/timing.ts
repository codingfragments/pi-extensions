/**
 * How long a storyboard will be, and how that compares with the length budget of the brief (item 22, R3-25). Two numbers:
 *   - the RAW take: the recorder's own step estimates (`estimateStepMs`: cursor moves, typing at human speed, dwells, waits at a nominal 1.5 s), the holds the recorder
 *     will make to meet each scene's `time` (the same rule it uses, `planScene`), and the lead-in and the tail;
 *   - the FINAL video, which is what the budget is about (D-R3-25-6): the raw take less the dead time the edit cuts (measured from this project's own takes, else 10 %),
 *     plus the title card.
 * The verdict is the final against the budget's floor and ceiling.
 */

import { planScene } from "../budget/holds.ts";
import { type LengthBudget, againstBudget, clock, lengthVerdict } from "../budget/length.ts";
import { LEAD_IN_MS, TAIL_MS, estimateStepMs } from "../recorder/progress.ts";
import type { Storyboard } from "./types.ts";

export type TimingVerdict = "short" | "fits" | "long" | "no-target";

/** The share of a raw take the edit cuts as dead time when the project has no analyzed take yet. */
export const DEFAULT_CUT_SHARE = 0.1;

export interface SceneTiming {
  id: string;
  /** What the scene will take, holds included, ms. */
  ms: number;
  steps: number;
  /** The steps alone, ms. */
  stepsMs: number;
  /** The scene's `time`, ms, when it has one. */
  timeMs?: number;
  /** Held to meet it. */
  heldMs: number;
  /** Still short of its time after the holds (the caps): the scene needs depth, not stills. */
  shortMs: number;
}

export interface StoryboardTiming {
  /** Projected length of the raw take, ms. */
  totalMs: number;
  steps: number;
  scenes: SceneTiming[];
  /** Waits for something to appear: counted at 1.5 s, they may take longer. */
  openWaits: number;
  /** The scenes' `time` hints added up (only the scenes that have one), ms. */
  timesMs: number;
  /** The final video: the raw take less the dead time the edit cuts, plus the title card. */
  final: { ms: number; cutShare: number; cutFrom: "takes" | "default"; titleMs: number };
  /** The length budget the verdict is against. */
  budget?: LengthBudget;
  /** The same as [floor, ceiling] seconds, and whether it is only the depth's default (the tab's older field). */
  target?: { lo: number; hi: number; fromDepth: boolean };
  /** final / target, rounded to a percent (undefined without a budget). */
  percentOfTarget?: number;
  verdict: TimingVerdict;
  /** One line for the Director and the tab: "projected 6:10 for a target of 10:00 (8:30 to 11:00): 2:20 short of the floor". */
  words?: string;
  /** The newest finished take of this storyboard: what the estimate was up against. */
  lastTake?: { id: string; ms: number };
  /** The budget this storyboard was written for, when it is not the current one (D-R3-25-12): "planned for 4:00, the target is now 10:00". */
  plannedFor?: { targetSec: number };
}

export function storyboardTiming(
  sb: Storyboard,
  o: {
    budget?: LengthBudget;
    budgetFromDepth?: boolean;
    lastTake?: { id: string; ms: number };
    cutShare?: number;
    cutFrom?: "takes" | "default";
    titleMs?: number;
    plannedFor?: { targetSec: number };
  } = {},
): StoryboardTiming {
  const scenes: SceneTiming[] = sb.scenes.map((s) => {
    const stepMs = s.steps.map((st) => estimateStepMs(st));
    const p = planScene(s, stepMs);
    return {
      id: s.id,
      ms: p.plannedMs,
      steps: s.steps.length,
      stepsMs: p.stepsMs,
      ...(s.time !== undefined ? { timeMs: s.time } : {}),
      heldMs: p.heldMs,
      shortMs: p.shortMs,
    };
  });
  const totalMs = scenes.reduce((n, s) => n + s.ms, 0) + LEAD_IN_MS + TAIL_MS;
  const openWaits = sb.scenes.reduce(
    (n, s) => n + s.steps.filter((st) => st.do === "wait" && !("ms" in st.for)).length,
    0,
  );
  const cutShare = o.cutShare ?? DEFAULT_CUT_SHARE;
  const titleMs = o.titleMs ?? 0;
  const finalMs = Math.round(totalMs * (1 - cutShare) + titleMs);
  const b = o.budget;
  const verdict: TimingVerdict = b ? lengthVerdict(finalMs / 1000, b) : "no-target";
  return {
    totalMs,
    steps: scenes.reduce((n, s) => n + s.steps, 0),
    scenes,
    openWaits,
    timesMs: scenes.reduce((n, s) => n + (s.timeMs ?? 0), 0),
    final: { ms: finalMs, cutShare, cutFrom: o.cutFrom ?? "default", titleMs },
    ...(b
      ? {
          budget: b,
          target: { lo: b.floorSec, hi: b.ceilingSec, fromDepth: o.budgetFromDepth ?? false },
          percentOfTarget: Math.round((finalMs / (b.targetSec * 1000)) * 100),
          words: againstBudget(finalMs / 1000, b, "projected final"),
        }
      : {}),
    verdict,
    ...(o.lastTake ? { lastTake: o.lastTake } : {}),
    ...(o.plannedFor && b && o.plannedFor.targetSec !== b.targetSec
      ? { plannedFor: o.plannedFor }
      : {}),
  };
}

/** What the Director is told when it writes a storyboard (D-R3-25-2, -7, -10): the projection, what is off, and what to do about it. */
export function timingForDirector(t: StoryboardTiming): string {
  const lines = t.budget
    ? [
        `Length: ${t.words} (raw ${clock(t.totalMs / 1000)} less about ${Math.round(t.final.cutShare * 100)} % dead time${t.final.cutFrom === "takes" ? " measured on this project's takes" : ""}${t.final.titleMs ? `, plus a ${clock(t.final.titleMs / 1000)} title card` : ""}).`,
      ]
    : [
        `Projected: raw ${clock(t.totalMs / 1000)}, final about ${clock(t.final.ms / 1000)}. The brief has no target length: ask the user for one (one number, e.g. "10 min").`,
      ];
  const untimed = t.scenes.filter((s) => s.timeMs === undefined).length;
  if (untimed && t.budget)
    lines.push(
      `${untimed} of ${t.scenes.length} scenes have no \`time:\` yet: give every scene one, weighted by importance, so they add up to the target.`,
    );
  const thin = t.scenes.filter((s) => s.shortMs > 0);
  if (thin.length)
    lines.push(
      `Too thin for their time even with the holds (at most 6 s each, a third of a scene): ${thin.map((s) => `${s.id} (${clock(s.shortMs / 1000)} short)`).join(", ")}. Add depth there (more steps, more of the payoff), not stills.`,
    );
  if (t.verdict === "short")
    lines.push(
      "Short of the budget: plan the difference BEFORE the user sees this draft, depth first (more of what matters, another relevant path), holds only for the rest; say what you added. If the app has no more real content, say so with evidence and propose a shorter target or areas to add: never pad.",
    );
  if (t.verdict === "long")
    lines.push("Over the budget: trim scenes or steps, or ask the user to raise the target.");
  if (t.plannedFor && t.budget)
    lines.push(
      `The earlier version was planned for ${clock(t.plannedFor.targetSec)}; the target is now ${clock(t.budget.targetSec)}.`,
    );
  return lines.join("\n");
}
