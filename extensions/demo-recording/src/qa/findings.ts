/**
 * Findings of any stage version (P1a Q1b, F32): QA is not only about a render. A finding names its stage and
 * version, and one view serves every stage screen: "Checks of <stage> vN". Today the render's QA is the only
 * producer; the storyboard, recording, voice-over and annotation adapters (QS) plug in here later, over
 * detectors that already exist (confidence signals, take analysis, annotation resolve warnings).
 */

import { readRender } from "../render/store.ts";
import type { Stage } from "../workdir/stages.ts";
import { listIgnores } from "./ignores.ts";
import { readQa } from "./run.ts";
import { summarize } from "./summary.ts";
import type { QaIgnore, QaItem, QaSummary } from "./types.ts";

export interface Finding extends QaItem {
  stage: Stage;
  version: number;
}

export interface FindingsView {
  stage: Stage;
  version: number;
  /** Does this stage have checks yet? (The adapters of the other stages come later.) */
  checked: boolean;
  /** When the checks ran. */
  ranAt?: string;
  findings: Finding[];
  summary?: QaSummary;
  /** N of M anchors measured (render only). */
  coverage?: { anchors: { measured: number; total: number } };
  /** Whisper ran (render only): without it sync is not checked. */
  whisper?: boolean;
  /** What you decided to leave alone in this project (active first), with why and since when. */
  ignores?: QaIgnore[];
  /** Why there is nothing, when there is nothing. */
  note?: string;
}

export function findingsFor(projectDir: string, stage: Stage, version: number): FindingsView {
  if (stage !== "render")
    return {
      stage,
      version,
      checked: false,
      findings: [],
      note: `${stage} versions have no automatic checks yet (they come with "QA after every phase")`,
    };
  const report = readQa(projectDir, version);
  const rec = readRender(projectDir, version);
  if (!report)
    return {
      stage,
      version,
      checked: false,
      findings: [],
      note: rec?.kind === "final" ? "QA has not run on this final" : "QA runs on finals",
    };
  return {
    stage,
    version,
    checked: true,
    ranAt: report.createdAt,
    findings: report.items.map((it) => ({ ...it, stage, version })),
    // the report is the authority: the record's copy of the summary can lag behind it
    summary: summarize(report.items, report.createdAt),
    ...(report.coverage ? { coverage: report.coverage } : {}),
    whisper: report.whisper,
    ignores: [...listIgnores(projectDir)].sort((a, b) => Number(!!a.endedAt) - Number(!!b.endedAt)),
  };
}
