/**
 * Edit pipeline (S4): approved VO + its voice manifest + the take analysis →
 * timeline.vN.json → out/edit-vN/scenes/NN-<id>.mp4 + full.mp4 (+ timeline copy).
 * Outputs are versioned and never overwritten.
 */

import fs from "node:fs";
import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import type { DemoRecConfig } from "../config.ts";
import { readManifest } from "../tts/synthesize.ts";
import { readVo } from "../vo/store.ts";
import { readState, requireApproved } from "../workdir/state.ts";
import { writeNextVersion } from "../workdir/versioning.ts";
import { type SceneFit, sceneFits } from "./fit.ts";
import { fullJob, renderJob, sceneJob } from "./render.ts";
import { type Timeline, buildTimeline } from "./timeline.ts";

export interface EditResult {
  version: number;
  timeline: Timeline;
  timelineFile: string;
  outDir: string;
  scenes: { id: string; file: string; durationSec: number }[];
  full: { file: string; durationSec: number };
}

/** Full-video output time of each scene anchor (for reports and tests). */
export function fullAnchorTimes(
  t: Timeline,
): { scene: string; mark: string; out: number; audioAt: number }[] {
  const res: { scene: string; mark: string; out: number; audioAt: number }[] = [];
  let at = 0;
  for (const item of t.full) {
    if (item.type === "card") {
      at += item.durationMs;
      continue;
    }
    const sc = t.scenes.find((s) => s.id === item.id);
    if (!sc) continue;
    for (const a of sc.anchors)
      res.push({ scene: sc.id, mark: a.mark, out: at + a.out, audioAt: at + a.audioAt });
    at += sc.durationMs;
  }
  return res;
}

export async function runEdit(o: {
  projectDir: string;
  config: DemoRecConfig;
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; label: string }) => void;
}): Promise<EditResult> {
  const state = readState(o.projectDir);
  if (!state) throw new Error("project state missing");
  const voVersion = requireApproved(state, "vo");
  const vo = readVo(o.projectDir, voVersion);
  if (!vo) throw new Error(`approved voice-over v${voVersion} is missing`);
  const manifest = readManifest(o.projectDir, voVersion);
  if (!manifest)
    throw new Error(`no voice for voice-over v${voVersion} yet — run demo_rec_tts first`);
  const takeDir = path.join(o.projectDir, "takes", vo.validated.script.take);
  const analysis = readAnalysis(takeDir);
  if (!analysis) throw new Error(`${vo.validated.script.take} has not been analyzed`);
  const raw = path.join(takeDir, "raw.mp4");
  if (!fs.existsSync(raw)) throw new Error(`${vo.validated.script.take}/raw.mp4 is missing`);

  const timeline = buildTimeline(analysis, manifest, { fps: o.config.fps, size: o.config.output });
  const stored = writeNextVersion(
    path.join(o.projectDir, "edit"),
    "timeline.v",
    ".json",
    `${JSON.stringify(timeline, null, 2)}\n`,
  );
  const outDir = path.join(o.projectDir, "out", `edit-v${stored.version}`);
  fs.mkdirSync(path.join(outDir, "scenes"), { recursive: true });
  fs.copyFileSync(stored.file, path.join(outDir, "timeline.json"));
  const opts = { fps: o.config.fps, width: o.config.output.width, height: o.config.output.height };
  const total = timeline.scenes.length + 1;

  const scenes: EditResult["scenes"] = [];
  for (const [i, sc] of timeline.scenes.entries()) {
    if (o.signal?.aborted) throw new Error("edit cancelled");
    o.onProgress?.({ done: i, total, label: `scene ${sc.id}` });
    const file = path.join(outDir, "scenes", `${String(i + 1).padStart(2, "0")}-${sc.id}.mp4`);
    const r = await renderJob(sceneJob(timeline, sc.id, o.projectDir), raw, file, opts);
    scenes.push({ id: sc.id, file, durationSec: r.durationSec });
  }
  if (o.signal?.aborted) throw new Error("edit cancelled");
  o.onProgress?.({ done: timeline.scenes.length, total, label: "full video" });
  const fullFile = path.join(outDir, "full.mp4");
  const r = await renderJob(fullJob(timeline, o.projectDir), raw, fullFile, opts);
  o.onProgress?.({ done: total, total, label: "done" });
  return {
    version: stored.version,
    timeline,
    timelineFile: stored.file,
    outDir,
    scenes,
    full: { file: fullFile, durationSec: r.durationSec },
  };
}

/**
 * Predicted fit of the REAL voice to the footage for a voice-over version —
 * the same solver the render uses, without rendering (cheap, pure). Undefined
 * until the voice exists for that version.
 */
export function voiceFit(
  projectDir: string,
  voVersion: number,
  config: DemoRecConfig,
): SceneFit[] | undefined {
  const manifest = readManifest(projectDir, voVersion);
  if (!manifest) return undefined;
  const analysis = readAnalysis(path.join(projectDir, "takes", manifest.take));
  if (!analysis) return undefined;
  const timeline = buildTimeline(analysis, manifest, { fps: config.fps, size: config.output });
  const voiceSec = Object.fromEntries(
    Object.values(manifest.sections).map((s) => [s.key, s.durationSec]),
  );
  const usable = Object.fromEntries(
    analysis.scenes.map((s) => [
      s.id,
      s.end - s.start - s.idle.reduce((n, r) => n + r.end - r.start, 0),
    ]),
  );
  return sceneFits(timeline, voiceSec, usable);
}
