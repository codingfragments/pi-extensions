/**
 * How long a storyboard will take to record, and how that compares with the length the brief asks for. The estimate is the one the recorder's progress bar uses
 * (`estimateStepMs`: cursor moves, typing at human speed, dwells, waits at a nominal 1.5 s) plus the lead-in and the tail of the take, so it is the RAW take, not the
 * finished video: the video follows the voice-over, which is written from the take, and the edit bends the take to it.
 */

import { LEAD_IN_MS, TAIL_MS, estimateStepMs } from "../recorder/progress.ts";
import type { Storyboard } from "./types.ts";

export type TimingVerdict = "short" | "fits" | "long" | "no-target";

export interface StoryboardTiming {
  /** Projected length of the raw take, ms. */
  totalMs: number;
  steps: number;
  /** Per scene, ms, in the storyboard's order. */
  scenes: { id: string; ms: number; steps: number }[];
  /** Waits for something to appear: counted at 1.5 s, they may take longer. */
  openWaits: number;
  /** Target length from the brief, seconds [low, high], and whether it is only the depth's default. */
  target?: { lo: number; hi: number; fromDepth: boolean };
  /** projected / target low end, rounded to a percent (undefined without a target). */
  percentOfTarget?: number;
  verdict: TimingVerdict;
  /** The newest finished take of this storyboard: what the estimate was up against. */
  lastTake?: { id: string; ms: number };
}

/** Within 70 % of the low end up to 115 % of the high end counts as fitting: the edit absorbs the rest. */
export function timingVerdict(totalMs: number, target?: { lo: number; hi: number }): TimingVerdict {
  if (!target) return "no-target";
  if (totalMs < target.lo * 1000 * 0.7) return "short";
  if (totalMs > target.hi * 1000 * 1.15) return "long";
  return "fits";
}

export function storyboardTiming(
  sb: Storyboard,
  target?: { lo: number; hi: number; fromDepth: boolean },
  lastTake?: { id: string; ms: number },
): StoryboardTiming {
  const scenes = sb.scenes.map((s) => ({
    id: s.id,
    ms: s.steps.reduce((n, st) => n + estimateStepMs(st), 0),
    steps: s.steps.length,
  }));
  const totalMs = scenes.reduce((n, s) => n + s.ms, 0) + LEAD_IN_MS + TAIL_MS;
  const openWaits = sb.scenes.reduce(
    (n, s) => n + s.steps.filter((st) => st.do === "wait" && !("ms" in st.for)).length,
    0,
  );
  return {
    totalMs,
    steps: scenes.reduce((n, s) => n + s.steps, 0),
    scenes,
    openWaits,
    ...(target
      ? { target, percentOfTarget: Math.round((totalMs / (target.lo * 1000)) * 100) }
      : {}),
    verdict: timingVerdict(totalMs, target),
    ...(lastTake ? { lastTake } : {}),
  };
}
