/** The length budget of a project: its brief read with the configured tolerances. */

import fs from "node:fs";
import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import { effectiveBrand, resolveBrand } from "../brand/brand.ts";
import type { DemoRecConfig } from "../config.ts";
import { type EffectiveFacts, effectiveFacts } from "../workdir/brief.ts";
import type { LengthBudget } from "./length.ts";

export function toleranceOf(config: Pick<DemoRecConfig, "length">) {
  return { underPct: config.length.toleranceUnderPct, overPct: config.length.toleranceOverPct };
}

export function projectFacts(
  projectDir: string,
  config: Pick<DemoRecConfig, "length">,
): EffectiveFacts | undefined {
  const file = path.join(projectDir, "brief.md");
  if (!fs.existsSync(file)) return undefined;
  return effectiveFacts(fs.readFileSync(file, "utf8"), toleranceOf(config));
}

export function projectBudget(
  projectDir: string,
  config: Pick<DemoRecConfig, "length">,
): LengthBudget | undefined {
  return projectFacts(projectDir, config)?.budget;
}

/** The share of a raw take the edit cuts as dead time, measured on this project's analyzed takes (D-R3-25-6); undefined when there is none yet. */
export function measuredCutShare(projectDir: string): number | undefined {
  const dir = path.join(projectDir, "takes");
  if (!fs.existsSync(dir)) return undefined;
  let total = 0;
  let idle = 0;
  for (const t of fs.readdirSync(dir)) {
    const a = readAnalysis(path.join(dir, t));
    if (!a?.durationMs) continue;
    total += a.durationMs;
    for (const s of a.scenes) for (const r of s.idle) idle += r.end - r.start;
  }
  return total > 0 ? Math.min(0.5, idle / total) : undefined;
}

/** The title card's length in the final video, ms (the brand's, when it has one). */
export function titleCardMs(config: Pick<DemoRecConfig, "root" | "brand">): number {
  try {
    const b = resolveBrand(config.root, effectiveBrand(config.root, config.brand).name).brand.title;
    return b.enabled ? b.durationMs + b.dissolveMs : 0;
  } catch {
    return 0;
  }
}

/** Everything the projection needs for this project. */
export function timingInputs(projectDir: string, config: DemoRecConfig) {
  const facts = projectFacts(projectDir, config);
  const cut = measuredCutShare(projectDir);
  return {
    ...(facts?.budget ? { budget: facts.budget } : {}),
    budgetFromDepth: facts?.lengthFromDepth ?? false,
    ...(cut !== undefined ? { cutShare: cut, cutFrom: "takes" as const } : {}),
    titleMs: titleCardMs(config),
  };
}

/** Where a storyboard version's budget is kept: the budget it was written for (D-R3-25-12). */
const plannedFile = (projectDir: string, version: number) =>
  path.join(projectDir, "storyboard", `v${version}.length.json`);

export interface PlannedFor {
  targetSec: number;
  floorSec?: number;
  ceilingSec?: number;
  /** What the engine projected for the final video when the version was written, and its verdict (the engine's `length` finding). */
  projectedFinalMs?: number;
  verdict?: string;
  words?: string;
  /** The share of the raw take that is holds. */
  holdShare?: number;
}

export function savePlannedFor(
  projectDir: string,
  version: number,
  b: LengthBudget,
  projection?: { finalMs: number; verdict: string; words?: string; holdShare?: number },
): void {
  try {
    const rec: PlannedFor = {
      targetSec: b.targetSec,
      floorSec: b.floorSec,
      ceilingSec: b.ceilingSec,
      ...(projection
        ? {
            projectedFinalMs: projection.finalMs,
            verdict: projection.verdict,
            ...(projection.words ? { words: projection.words } : {}),
            ...(projection.holdShare !== undefined ? { holdShare: projection.holdShare } : {}),
          }
        : {}),
    };
    fs.writeFileSync(plannedFile(projectDir, version), `${JSON.stringify(rec)}\n`);
  } catch {
    // without it the tab only cannot say what it was planned for
  }
}

/** The budget a version was planned for (only the target: what the tab compares). */
export function plannedFor(projectDir: string, version: number): { targetSec: number } | undefined {
  const r = plannedRecord(projectDir, version);
  return r ? { targetSec: r.targetSec } : undefined;
}

/** Everything stored about a version's length when it was written. */
export function plannedRecord(projectDir: string, version: number): PlannedFor | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(plannedFile(projectDir, version), "utf8")) as PlannedFor;
    return typeof j.targetSec === "number" ? j : undefined;
  } catch {
    return undefined;
  }
}
