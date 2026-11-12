/**
 * A take against the length budget (item 22, D-R3-25-6 and -11): the final video it will make is the raw take less the dead time the edit cuts (its own loading ranges)
 * plus the title card; a take whose final falls outside the budget is flagged before it is offered, and the user is asked.
 */

import fs from "node:fs";
import path from "node:path";
import { observerIdle } from "../analysis/take.ts";
import type { DemoRecConfig } from "../config.ts";
import type { TakeEvent } from "../recorder/events.ts";
import { type LengthBudget, type LengthVerdict, againstBudget, lengthVerdict } from "./length.ts";
import { projectBudget, titleCardMs } from "./project.ts";

export interface TakeLength {
  rawMs: number;
  /** The dead time the edit will cut (the take's loading ranges). */
  cutMs: number;
  titleMs: number;
  finalMs: number;
  budget?: { targetSec: number; floorSec: number; ceilingSec: number };
  verdict?: LengthVerdict;
  /** "projected final 6:10 for a target of 10:00 (8:30 to 11:00): 2:20 short of the floor" */
  words?: string;
  /** Scenes that stayed short of their `time` (the hold caps): they need depth. */
  thinScenes?: { id: string; shortMs: number }[];
}

export function takeLength(o: {
  rawMs: number;
  events: TakeEvent[];
  titleMs: number;
  budget?: LengthBudget;
  sceneTimes?: Record<string, { shortMs: number }>;
}): TakeLength {
  const cutMs = observerIdle(o.events).reduce((n, r) => n + (r.end - r.start), 0);
  const finalMs = Math.max(0, o.rawMs - cutMs) + o.titleMs;
  const thin = Object.entries(o.sceneTimes ?? {})
    .filter(([, t]) => t.shortMs > 1000)
    .map(([id, t]) => ({ id, shortMs: t.shortMs }));
  return {
    rawMs: o.rawMs,
    cutMs,
    titleMs: o.titleMs,
    finalMs,
    ...(o.budget
      ? {
          budget: {
            targetSec: o.budget.targetSec,
            floorSec: o.budget.floorSec,
            ceilingSec: o.budget.ceilingSec,
          },
          verdict: lengthVerdict(finalMs / 1000, o.budget),
          words: againstBudget(finalMs / 1000, o.budget, "projected final"),
        }
      : {}),
    ...(thin.length ? { thinScenes: thin } : {}),
  };
}

/** Measure a finished take against the project's budget and write it into its take.json (`length`). */
export function measureTake(
  projectDir: string,
  config: DemoRecConfig,
  take: { takeId: string; takeDir: string; durationMs: number; events: TakeEvent[] },
): TakeLength {
  const file = path.join(take.takeDir, "take.json");
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // a take without its file is measured all the same
  }
  const budget = projectBudget(projectDir, config);
  const l = takeLength({
    rawMs: take.durationMs,
    events: take.events,
    titleMs: titleCardMs(config),
    ...(budget ? { budget } : {}),
    ...(meta.sceneTimes
      ? { sceneTimes: meta.sceneTimes as Record<string, { shortMs: number }> }
      : {}),
  });
  if (Object.keys(meta).length) {
    meta.length = l;
    fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
  }
  return l;
}
