/**
 * Annotation previews (D35 card previews): a short clip around one annotation
 * (its window ± 1 s, with narration) and a still at its peak, rendered on a
 * slice of the scene — fast, cached by content hash.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LoadedBrand } from "../brand/brand.ts";
import type { RenderBrand, RenderJob, VideoPiece } from "../edit/render.ts";
import { renderJob, sceneJob } from "../edit/render.ts";
import type { Timeline } from "../edit/timeline.ts";
import { ffmpeg } from "../media/ffmpeg.ts";
import { takeGeometry } from "./apply.ts";
import { type RenderAnnotations, buildRenderAnnotations } from "./render.ts";
import { resolveAnnotations } from "./resolve.ts";
import type { AnnotationFile } from "./types.ts";

/** The part of a job between two output times (ms). */
export function sliceJob(job: RenderJob, fromMs: number, toMs: number): RenderJob {
  const video: VideoPiece[] = [];
  let at = 0;
  for (const p of job.video) {
    const s = at;
    const e = at + p.durMs;
    at = e;
    const a = Math.max(s, fromMs);
    const b = Math.min(e, toMs);
    if (b - a <= 0) continue;
    if (p.src) {
      const speed = p.speed ?? 1;
      video.push({
        src: [p.src[0] + (a - s) * speed, p.src[0] + (b - s) * speed],
        speed,
        durMs: b - a,
      });
    } else video.push({ hold: p.hold as number, durMs: b - a });
  }
  const audio = job.audio.flatMap((c) => {
    const len = c.src[1] - c.src[0];
    const a = Math.max(c.at, fromMs);
    const b = Math.min(c.at + len, toMs);
    if (b - a <= 0) return [];
    return [
      {
        file: c.file,
        src: [c.src[0] + (a - c.at), c.src[0] + (b - c.at)] as [number, number],
        at: a - fromMs,
      },
    ];
  });
  return { video, audio, durationMs: toMs - fromMs };
}

const shiftOps = (o: RenderAnnotations, d: number): RenderAnnotations => {
  const sh = <T extends { startMs: number; endMs: number }>(xs: T[]) =>
    xs.map((x) => ({ ...x, startMs: x.startMs + d, endMs: x.endMs + d }));
  return { page: sh(o.page), blurs: sh(o.blurs), zooms: sh(o.zooms), screen: sh(o.screen) };
};

export interface AnnotationPreview {
  id: string;
  clip: string;
  still: string;
  /** Peak moment inside the clip (ms) — where the still is taken. */
  peakMs: number;
  warnings: string[];
}

export async function previewAnnotation(o: {
  projectDir: string;
  timeline: Timeline;
  file: AnnotationFile;
  id: string;
  brand: LoadedBrand;
  frame: RenderBrand;
  fps: number;
  output: { width: number; height: number };
  cacheDir: string;
  outDir: string;
}): Promise<AnnotationPreview> {
  const item = o.file.items.find((x) => x.id === o.id);
  if (!item) throw new Error(`annotation ${o.id} is not in v${o.file.version}`);
  const takeDir = path.join(o.projectDir, "takes", o.timeline.take);
  const geo = takeGeometry(o.projectDir, o.timeline.take);
  const r = resolveAnnotations(
    { ...o.file, items: [{ ...item, enabled: true }] },
    { timeline: o.timeline, takeDir, ...geo },
  );
  const res = r.items[0];
  if (!res) throw new Error(`annotation ${o.id} can't be placed: ${r.warnings.join("; ")}`);
  const footage = o.frame.backdrop
    ? o.frame.inset
    : { x: 0, y: 0, w: o.output.width, h: o.output.height };
  const built = await buildRenderAnnotations([res], {
    brand: o.brand,
    source: geo.source,
    out: o.output,
    footage,
    cacheDir: o.cacheDir,
  });
  const sc = o.timeline.scenes.find((s) => s.id === item.scene) as Timeline["scenes"][number];
  const from = Math.max(0, res.startMs - 1000);
  const to = Math.min(sc.durationMs, res.endMs + 1000);
  const peakMs =
    (res.type === "zoom"
      ? (res.startMs + res.endMs) / 2
      : Math.min(res.atMs + 400, res.endMs - 100)) - from;
  const key = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        o.timeline.take,
        sc.pieces,
        sc.audio,
        res,
        built.ops,
        o.frame,
        o.output,
        o.fps,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  fs.mkdirSync(o.outDir, { recursive: true });
  const clip = path.join(o.outDir, `${o.id}-${key}.mp4`);
  const still = path.join(o.outDir, `${o.id}-${key}.png`);
  if (!fs.existsSync(clip)) {
    const job = sliceJob(sceneJob(o.timeline, item.scene, o.projectDir), from, to);
    await renderJob(job, path.join(takeDir, "raw.mp4"), clip, {
      fps: o.fps,
      width: o.output.width,
      height: o.output.height,
      source: geo.source,
      brand: o.frame,
      annotations: shiftOps(built.ops, -from),
    });
  }
  if (!fs.existsSync(still))
    await ffmpeg(["-ss", (peakMs / 1000).toFixed(3), "-i", clip, "-frames:v", "1", "-y", still]);
  return { id: o.id, clip, still, peakMs, warnings: [...r.warnings, ...built.warnings] };
}
