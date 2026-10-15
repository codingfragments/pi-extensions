/**
 * Sidecars of a render variant (S5 part 9, D61, D62):
 *
 * Names: <project>_<kind>-v<N>_<flavor> + _poster.jpg (the title card at its
 * fullest), _transcript.vtt (WebVTT from the TTS word timings; per scene for
 * finals), _callouts.srt (when the render has callouts), _subtitled.mp4
 * (burned-in subtitles, in addition to the clean files; option).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveContext } from "../annotations/apply.ts";
import { resolveAnnotations } from "../annotations/resolve.ts";
import type { DemoRecConfig } from "../config.ts";
import { type CutResult, prepareBrand } from "../edit/pipeline.ts";
import { ffmpeg } from "../media/ffmpeg.ts";
import type { RenderPlan } from "./run.ts";
import type { RenderFiles, RenderNames } from "./store.ts";
import {
  type Cue,
  buildCues,
  burnSubtitles,
  fullWords,
  sceneWords,
  toSrt,
  toVtt,
} from "./subtitles.ts";

export async function writeSidecars(o: {
  projectDir: string;
  config: DemoRecConfig;
  cut: CutResult;
  plan: RenderPlan;
  brand: string;
  dir: string;
  names: RenderNames;
  signal?: AbortSignal;
}): Promise<{ files: Partial<RenderFiles>; warnings: string[] }> {
  const files: Partial<RenderFiles> = {};
  const warnings: string[] = [];
  const t = o.cut.timeline;

  // Poster
  const at = o.cut.titleMs ? Math.min(o.cut.titleMs * 0.5, 2000) : 1000;
  const n = o.names;
  const poster = path.join(o.dir, n.poster);
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
  if (fs.existsSync(poster)) files.poster = n.poster;

  // Transcript
  const fullCues = buildCues(fullWords(o.projectDir, t, o.cut.itemStart));
  if (fullCues.length) {
    fs.writeFileSync(path.join(o.dir, n.vtt), toVtt(fullCues));
    files.vtt = n.vtt;
  } else warnings.push("no word timings for this voice-over — no transcript");
  const sceneCues: Record<string, Cue[]> = {};
  if (o.cut.scenes.length) {
    files.scenesVtt = [];
    for (const sc of o.cut.scenes) {
      const cues = buildCues(sceneWords(o.projectDir, t, sc.id));
      sceneCues[sc.id] = cues;
      fs.writeFileSync(path.join(o.dir, n.sceneVtt(sc.id)), toVtt(cues));
      files.scenesVtt.push(n.sceneVtt(sc.id));
    }
  }

  // Callouts (texts + times in the full video)
  const callouts = (o.plan.file?.items ?? []).filter((it) => it.type === "callout");
  const sceneCallouts: Record<string, { startMs: number; endMs: number }[]> = {};
  let fullCallouts: { startMs: number; endMs: number; text: string }[] = [];
  if (callouts.length && o.plan.file) {
    const r = resolveAnnotations(
      { ...o.plan.file, items: callouts },
      resolveContext(o.projectDir, t),
    );
    fullCallouts = r.items.map((x) => {
      const d = o.cut.sceneStart[x.scene] ?? 0;
      const arr = sceneCallouts[x.scene] ?? [];
      arr.push({ startMs: x.startMs, endMs: x.endMs });
      sceneCallouts[x.scene] = arr;
      return { startMs: x.startMs + d, endMs: x.endMs + d, text: x.text ?? "" };
    });
    if (fullCallouts.length) {
      fs.writeFileSync(
        path.join(o.dir, n.callouts),
        toSrt(fullCallouts.map((c) => ({ startMs: c.startMs, endMs: c.endMs, lines: [c.text] }))),
      );
      files.callouts = n.callouts;
    }
  }

  // Burned-in subtitles: overlays on copies of the rendered files.
  if (o.plan.options.subtitles && fullCues.length) {
    const cfg = { ...o.config, output: o.plan.size };
    const b = await prepareBrand(o.projectDir, cfg, t.take, o.brand);
    const footage = b.frame.backdrop
      ? b.frame.inset
      : { x: 0, y: 0, w: o.plan.size.width, h: o.plan.size.height };
    const common = {
      brand: b.loaded,
      size: o.plan.size,
      footage,
      fps: o.config.fps,
      cacheDir: path.join(o.config.root, ".cache", "render-assets"),
    };
    if (o.signal?.aborted) throw new Error("render cancelled");
    const full = path.join(o.dir, n.fullSubtitled);
    await burnSubtitles({
      ...common,
      input: o.cut.full.file,
      output: full,
      cues: fullCues,
      avoid: fullCallouts,
    });
    files.fullSubtitled = n.fullSubtitled;
    if (o.cut.scenes.length) {
      files.scenesSubtitled = [];
      for (const sc of o.cut.scenes) {
        if (o.signal?.aborted) throw new Error("render cancelled");
        const out = path.join(o.dir, n.sceneSubtitled(sc.id));
        await burnSubtitles({
          ...common,
          input: sc.file,
          output: out,
          cues: sceneCues[sc.id] ?? [],
          avoid: sceneCallouts[sc.id] ?? [],
        });
        files.scenesSubtitled.push(n.sceneSubtitled(sc.id));
      }
    }
  }
  return { files, warnings };
}
