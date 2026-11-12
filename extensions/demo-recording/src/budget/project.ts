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

export function savePlannedFor(projectDir: string, version: number, b: LengthBudget): void {
  try {
    fs.writeFileSync(
      plannedFile(projectDir, version),
      `${JSON.stringify({ targetSec: b.targetSec, floorSec: b.floorSec, ceilingSec: b.ceilingSec })}\n`,
    );
  } catch {
    // without it the tab only cannot say what it was planned for
  }
}

export function plannedFor(projectDir: string, version: number): { targetSec: number } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(plannedFile(projectDir, version), "utf8")) as {
      targetSec?: number;
    };
    return typeof j.targetSec === "number" ? { targetSec: j.targetSec } : undefined;
  } catch {
    return undefined;
  }
}
