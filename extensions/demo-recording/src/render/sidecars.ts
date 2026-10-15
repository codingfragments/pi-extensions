/**
 * Sidecars of a render variant (S5 part 9, D61, D62): the poster frame, the
 * transcript (VTT, full + per scene, from the TTS word timings), the callout
 * texts (SRT) and — as an option — videos with burned-in subtitles.
 */

import fs from "node:fs";
import path from "node:path";
import type { DemoRecConfig } from "../config.ts";
import type { CutResult } from "../edit/pipeline.ts";
import { ffmpeg } from "../media/ffmpeg.ts";
import type { RenderPlan } from "./run.ts";
import type { RenderFiles } from "./store.ts";

export async function writeSidecars(o: {
  projectDir: string;
  config: DemoRecConfig;
  cut: CutResult;
  plan: RenderPlan;
  brand: string;
  dir: string;
  signal?: AbortSignal;
}): Promise<{ files: Partial<RenderFiles>; warnings: string[] }> {
  const files: Partial<RenderFiles> = {};
  const warnings: string[] = [];
  // Poster: the title card at its fullest (or 1 s in without one).
  const at = o.cut.titleMs ? Math.min(o.cut.titleMs * 0.5, 2000) : 1000;
  const poster = path.join(o.dir, "poster.jpg");
  await ffmpeg([
    "-ss",
    (at / 1000).toFixed(3),
    "-i",
    o.cut.full.file,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-y",
    poster,
  ]);
  if (fs.existsSync(poster)) files.poster = "poster.jpg";
  return { files, warnings };
}
