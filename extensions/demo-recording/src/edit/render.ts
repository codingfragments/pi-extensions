/**
 * Render a timeline with ffmpeg (S4): per-scene MP4s and the full video.
 *
 * Video pieces are cut from raw.mp4 (capture resolution), speed-changed,
 * scaled to the output size and concatenated. Frame accuracy: every piece's
 * frame count comes from the CUMULATIVE output timeline (error diffusion), so
 * rounding never accumulates across dozens of pieces. Narration clips are
 * placed at their exact millisecond, mixed without normalization, then
 * loudness-normalized to −16 LUFS (D: IMPLEMENTATION_PLAN S4).
 */

import fs from "node:fs";
import path from "node:path";
import { ffmpeg, ffprobe } from "../media/ffmpeg.ts";
import type { Piece } from "./sync.ts";
import type { FullItem, Timeline } from "./timeline.ts";

export interface VideoPiece {
  /** Source range in take time (ms), or a held frame. */
  src?: [number, number];
  speed?: number;
  hold?: number;
  /** Output duration (ms). */
  durMs: number;
}

export interface AudioClip {
  file: string;
  /** Offsets in the file (ms). */
  src: [number, number];
  /** Output time (ms). */
  at: number;
}

export interface RenderJob {
  video: VideoPiece[];
  audio: AudioClip[];
  durationMs: number;
}

const pieceDur = (p: Piece) => ("src" in p ? (p.src[1] - p.src[0]) / p.speed : p.freeze.dur);

export function sceneJob(t: Timeline, sceneId: string, projectDir: string): RenderJob {
  const sc = t.scenes.find((s) => s.id === sceneId);
  if (!sc) throw new Error(`scene ${sceneId} is not in the timeline`);
  const video = sc.pieces.map(
    (p): VideoPiece =>
      "src" in p
        ? { src: p.src, speed: p.speed, durMs: pieceDur(p) }
        : { hold: p.freeze.at, durMs: p.freeze.dur },
  );
  const audio = sc.audioFile
    ? sc.audio.map((a) => ({
        file: path.join(projectDir, sc.audioFile as string),
        src: a.src,
        at: a.at,
      }))
    : [];
  return { video, audio, durationMs: sc.durationMs };
}

export function fullJob(
  t: Timeline,
  projectDir: string,
  opts: { titleMs?: number } = {},
): RenderJob {
  const video: VideoPiece[] = [];
  const audio: AudioClip[] = [];
  let at = 0;
  // A title card covers the start: make sure the video opens on a held frame long
  // enough for it (the intro card if there is one, else a silent hold).
  const first = t.full[0];
  const firstScene = t.scenes.find(
    (s) => s.id === (t.full.find((x) => x.type === "scene") as { id: string } | undefined)?.id,
  );
  const introMs = first?.type === "card" && first.kind === "intro" ? first.durationMs : 0;
  if (opts.titleMs && introMs < opts.titleMs && firstScene) {
    const hold = Math.round(opts.titleMs - introMs);
    const startFrame =
      (firstScene.pieces.find((p) => "src" in p) as { src: [number, number] } | undefined)
        ?.src[0] ?? 0;
    video.push({ hold: first?.type === "card" ? first.holdAt : startFrame, durMs: hold });
    at += hold;
  }
  for (const item of t.full as FullItem[]) {
    if (item.type === "card") {
      video.push({ hold: item.holdAt, durMs: item.durationMs });
      if (item.audio)
        audio.push({
          file: path.join(projectDir, item.audio.file),
          src: item.audio.src,
          at: at + 500,
        });
      at += item.durationMs;
      continue;
    }
    const job = sceneJob(t, item.id, projectDir);
    video.push(...job.video);
    for (const a of job.audio) audio.push({ ...a, at: at + a.at });
    at += job.durationMs;
  }
  return { video, audio, durationMs: at };
}

/** Frame counts per piece from cumulative output time (no drift). */
export function frameCounts(pieces: VideoPiece[], fps: number): number[] {
  let t = 0;
  let frames = 0;
  return pieces.map((p) => {
    t += p.durMs;
    const target = Math.round((t * fps) / 1000);
    const n = Math.max(0, target - frames);
    frames = target;
    return n;
  });
}

/** Brand layers for one render (from brand/assets.ts). */
export interface RenderBrand {
  inset: { x: number; y: number; w: number; h: number };
  backdrop?: string;
  mask?: string;
  /** Title card over the start (full video only). */
  title?: { file: string; durationMs: number; dissolveMs: number };
  logoBug?: { file: string; x: number; y: number; opacity: number; fromMs: number };
}

export interface RenderOpts {
  fps: number;
  width: number;
  height: number;
  brand?: RenderBrand;
}

/** Image inputs (looped stills) after the audio inputs, in this order. */
export function imageInputs(
  brand: RenderBrand | undefined,
): { key: "backdrop" | "mask" | "title" | "bug"; file: string }[] {
  if (!brand) return [];
  const out: { key: "backdrop" | "mask" | "title" | "bug"; file: string }[] = [];
  if (brand.backdrop && brand.mask) {
    out.push({ key: "backdrop", file: brand.backdrop });
    out.push({ key: "mask", file: brand.mask });
  }
  if (brand.title) out.push({ key: "title", file: brand.title.file });
  if (brand.logoBug) out.push({ key: "bug", file: brand.logoBug.file });
  return out;
}

export function filterGraph(job: RenderJob, opts: RenderOpts, audioInputs: string[]): string {
  const { fps } = opts;
  const brand = opts.brand;
  const framed = !!(brand?.backdrop && brand.mask);
  // Footage size: the inset box when framed (one scaling pass), else full frame.
  const fw = framed ? (brand as RenderBrand).inset.w : opts.width;
  const fh = framed ? (brand as RenderBrand).inset.h : opts.height;
  const counts = frameCounts(job.video, fps);
  const live = job.video.map((p, i) => ({ p, n: counts[i] as number })).filter((x) => x.n > 0);
  const lines: string[] = [];
  lines.push(`[0:v]split=${live.length}${live.map((_, i) => `[s${i}]`).join("")}`);
  const scale = `scale=${fw}:${fh}:flags=lanczos,setsar=1`;
  live.forEach(({ p, n }, i) => {
    const sec = (ms: number) => (ms / 1000).toFixed(4);
    const head = p.src
      ? `[s${i}]trim=start=${sec(p.src[0])}:end=${sec(p.src[1])},setpts=(PTS-STARTPTS)/${(p.speed ?? 1).toFixed(4)}`
      : `[s${i}]trim=start=${sec(p.hold as number)}:end=${sec((p.hold as number) + 1000 / fps + 1)},setpts=PTS-STARTPTS`;
    // fps → pad with the last frame → cut to exactly n frames
    lines.push(
      `${head},${scale},fps=${fps},tpad=stop_mode=clone:stop_duration=${((n + 2) / fps).toFixed(3)},trim=end_frame=${n},setpts=PTS-STARTPTS[v${i}]`,
    );
  });
  const D = (job.durationMs / 1000).toFixed(3);
  const images = imageInputs(brand);
  const imgIdx = (key: string) => 1 + audioInputs.length + images.findIndex((x) => x.key === key);
  let cur = framed || brand?.title || brand?.logoBug ? "vcat" : "vout";
  lines.push(`${live.map((_, i) => `[v${i}]`).join("")}concat=n=${live.length}:v=1:a=0[${cur}]`);
  if (brand && framed) {
    const b = brand.inset;
    lines.push(`[${imgIdx("mask")}:v]format=gray,scale=${b.w}:${b.h},setsar=1[mask]`);
    lines.push(`[${cur}]format=yuva420p[vfa]`);
    lines.push("[vfa][mask]alphamerge[vrnd]");
    lines.push(
      `[${imgIdx("backdrop")}:v]scale=${opts.width}:${opts.height},setsar=1,format=yuv420p,fps=${fps}[bg]`,
    );
    const next = brand.title || brand.logoBug ? "vframed" : "vout";
    lines.push(`[bg][vrnd]overlay=${b.x}:${b.y}:shortest=1:format=auto,format=yuv420p[${next}]`);
    cur = next;
  }
  if (brand?.title) {
    const t = brand.title;
    const next = brand.logoBug ? "vtitled" : "vout";
    lines.push(
      `[${imgIdx("title")}:v]scale=${opts.width}:${opts.height},setsar=1,format=yuva420p,fps=${fps},` +
        `fade=t=out:st=${(t.durationMs / 1000).toFixed(3)}:d=${(t.dissolveMs / 1000).toFixed(3)}:alpha=1[title]`,
    );
    lines.push(`[${cur}][title]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[${next}]`);
    cur = next;
  }
  if (brand?.logoBug) {
    const l = brand.logoBug;
    const from = (l.fromMs / 1000).toFixed(3);
    lines.push(
      `[${imgIdx("bug")}:v]format=yuva420p,colorchannelmixer=aa=${l.opacity.toFixed(2)},fps=${fps},fade=t=in:st=${from}:d=0.5:alpha=1[bug]`,
    );
    lines.push(
      `[${cur}][bug]overlay=${l.x}:${l.y}:enable='gte(t,${from})':format=auto,format=yuv420p[vout]`,
    );
  }
  if (!job.audio.length) {
    lines.push(`anullsrc=r=48000:cl=mono,atrim=duration=${D}[aout]`);
  } else {
    job.audio.forEach((a, j) => {
      const k = audioInputs.indexOf(a.file) + 1;
      const delay = Math.max(0, Math.round(a.at));
      lines.push(
        `[${k}:a]atrim=start=${(a.src[0] / 1000).toFixed(4)}:end=${(a.src[1] / 1000).toFixed(4)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[a${j}]`,
      );
    });
    lines.push(
      `${job.audio.map((_, j) => `[a${j}]`).join("")}amix=inputs=${job.audio.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${D},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`,
    );
  }
  return lines.join(";\n");
}

export async function renderJob(
  job: RenderJob,
  rawVideo: string,
  out: string,
  opts: RenderOpts,
): Promise<{ ms: number; durationSec: number }> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const audioInputs = [...new Set(job.audio.map((a) => a.file))];
  const images = imageInputs(opts.brand);
  const D = (job.durationMs / 1000).toFixed(3);
  const script = `${out}.filter.txt`;
  fs.writeFileSync(script, filterGraph(job, opts, audioInputs));
  try {
    const { ms } = await ffmpeg([
      "-i",
      rawVideo,
      ...audioInputs.flatMap((f) => ["-i", f]),
      ...images.flatMap((im) => [
        "-loop",
        "1",
        "-framerate",
        String(opts.fps),
        "-t",
        im.key === "title" && opts.brand?.title
          ? ((opts.brand.title.durationMs + opts.brand.title.dissolveMs) / 1000 + 0.1).toFixed(3)
          : D,
        "-i",
        im.file,
      ]),
      "-/filter_complex", // value read from a file (ffmpeg ≥ 7)
      script,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(opts.fps),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      D,
      "-movflags",
      "+faststart",
      out,
    ]);
    return { ms, durationSec: (await ffprobe(out)).duration };
  } finally {
    fs.rmSync(script, { force: true });
  }
}
