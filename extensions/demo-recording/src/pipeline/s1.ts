/**
 * S1 walking skeleton: storyboard file → project version → approval → take →
 * `say` narration → naive mux → out/<take>-naive.mp4.
 *
 * Deliberately exercises the real workdir contract and the approval gate: the
 * hand-written storyboard is stored as the next version (or reuses the latest
 * if identical), approved explicitly with `by: cli`, and recording goes through
 * `requireApproved`.
 */

import fs from "node:fs";
import path from "node:path";
import type { ScreencastOptions } from "../browser/capture/screencast.ts";
import type { DemoRecConfig } from "../config.ts";
import { naiveMux } from "../edit/naive.ts";
import type { TakeEvent } from "../recorder/events.ts";
import { type TakeResult, recordTake } from "../recorder/runner.ts";
import { parseStoryboard } from "../storyboard/parse.ts";
import { sayToWav } from "../tts/say.ts";
import { ensureProject } from "../workdir/layout.ts";
import { approve, readState, requireApproved } from "../workdir/state.ts";
import { latestVersion, writeNextVersion } from "../workdir/versioning.ts";

export interface S1Options {
  config: DemoRecConfig;
  project: string;
  appName: string;
  /** Runtime base URL (overrides app.json — the fixture port changes per run). */
  baseUrl: string;
  storyboardFile: string;
  capture?: ScreencastOptions;
  viewport?: DemoRecConfig["viewport"];
  headed?: boolean;
  seed?: number;
  sayVoice?: string;
  onEvent?: (e: TakeEvent) => void;
  log?: (msg: string) => void;
}

export interface S1Result {
  projectDir: string;
  storyboardVersion: number;
  take: TakeResult;
  narrationWav: string;
  output: string;
  mux: Awaited<ReturnType<typeof naiveMux>>;
}

/** Store the storyboard as the next version unless identical to the latest. */
export function storeStoryboard(projectDir: string, text: string): number {
  const dir = path.join(projectDir, "storyboard");
  const latest = latestVersion(dir, "v", ".yaml");
  if (latest !== undefined && fs.readFileSync(path.join(dir, `v${latest}.yaml`), "utf8") === text)
    return latest;
  return writeNextVersion(dir, "v", ".yaml", text).version;
}

export async function runS1(opts: S1Options): Promise<S1Result> {
  const log = opts.log ?? (() => {});
  const text = fs.readFileSync(opts.storyboardFile, "utf8");
  const storyboard = parseStoryboard(text);
  const project = ensureProject(opts.config.root, {
    project: opts.project,
    appName: opts.appName,
    appUrl: opts.baseUrl,
  });

  const version = storeStoryboard(project.dir, text);
  if (readState(project.dir)?.approved.storyboard !== version) {
    approve(project.dir, "storyboard", version);
    log(`storyboard v${version} approved (by cli: S1 walking skeleton)`);
  }
  const state = readState(project.dir);
  if (!state) throw new Error("project state missing");
  const approvedVersion = requireApproved(state, "storyboard");

  log(`recording take of storyboard v${approvedVersion} …`);
  const take = await recordTake({
    projectDir: project.dir,
    storyboard,
    storyboardVersion: approvedVersion,
    baseUrl: opts.baseUrl,
    viewport: opts.viewport ?? opts.config.viewport,
    fps: opts.config.fps,
    capture: opts.capture ?? opts.config.capture,
    ...(opts.headed ? { headed: true } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  log(
    `${take.takeId}: ${take.capture.frames} frames, ${take.capture.avgFps} fps avg, ` +
      `${(take.durationMs / 1000).toFixed(1)} s, encoded in ${((take.encodeMs ?? 0) / 1000).toFixed(1)} s`,
  );

  const narration = storyboard.scenes.map((s) => s.narration ?? s.title).join("\n\n");
  const narrationWav = path.join(project.dir, "vo", "audio", "say", `${take.takeId}.wav`);
  const audioSec = await sayToWav(
    narration,
    narrationWav,
    opts.sayVoice ? { voice: opts.sayVoice } : {},
  );
  log(`narration (say): ${audioSec.toFixed(1)} s`);

  if (!take.rawVideo) throw new Error("take was not encoded");
  const output = path.join(project.dir, "out", `${take.takeId}-naive.mp4`);
  const mux = await naiveMux(take.rawVideo, narrationWav, output, opts.config.output);
  log(`output: ${output} (${mux.total.toFixed(1)} s)`);
  return {
    projectDir: project.dir,
    storyboardVersion: approvedVersion,
    take,
    narrationWav,
    output,
    mux,
  };
}
