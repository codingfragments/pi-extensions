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
import {
  type RenderAnnotations,
  blurFilters,
  hasPageOps,
  overlayFilters,
  zoomFilter,
} from "../annotations/render.ts";
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
  /** Output start of each scene (ms) — to place annotations in the full video. */
  sceneStart?: Record<string, number>;
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
  return { video, audio, durationMs: sc.durationMs, sceneStart: { [sceneId]: 0 } };
}

export function fullJob(
  t: Timeline,
  projectDir: string,
  opts: { titleMs?: number } = {},
): RenderJob {
  const video: VideoPiece[] = [];
  const audio: AudioClip[] = [];
  const sceneStart: Record<string, number> = {};
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
    sceneStart[item.id] = at;
    video.push(...job.video);
    for (const a of job.audio) audio.push({ ...a, at: at + a.at });
    at += job.durationMs;
  }
  return { video, audio, durationMs: at, sceneStart };
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
  /** Annotations in this job's output time (annotations/render.ts). */
  annotations?: RenderAnnotations;
  /** Capture size (needed for zoom). */
  source?: { w: number; h: number };
}

/** A run of consecutive pieces rendered the same way. hi = source resolution (page ops/zoom). */
export interface Segment {
  first: number;
  last: number;
  hi: boolean;
  startMs: number;
  durMs: number;
}

/**
 * Group pieces: a piece overlapping a page-space annotation or a zoom window is
 * processed at source resolution; everything else is scaled first (cheap).
 */
export function planSegments(
  counts: number[],
  fps: number,
  ann: RenderAnnotations | undefined,
): Segment[] {
  const windows =
    ann && hasPageOps(ann)
      ? [...ann.page, ...ann.blurs, ...ann.zooms].map(
          (o) => [o.startMs - 50, o.endMs + 50] as const,
        )
      : [];
  const segs: Segment[] = [];
  let frames = 0;
  counts.forEach((n, i) => {
    const s = (frames * 1000) / fps;
    const e = ((frames + n) * 1000) / fps;
    frames += n;
    const hi = windows.some(([a, b]) => a < e && b > s);
    const prev = segs.at(-1);
    if (prev && prev.hi === hi) {
      prev.last = i;
      prev.durMs = e - prev.startMs;
    } else segs.push({ first: i, last: i, hi, startMs: s, durMs: e - s });
  });
  return segs;
}

/** Annotation PNG inputs (single frames, looped in the graph), after the brand images. */
export const annotationInputs = (ann: RenderAnnotations | undefined): string[] =>
  ann ? [...ann.page, ...ann.screen].map((o) => o.file) : [];

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
  const ann = opts.annotations;
  const segs = planSegments(
    live.map((x) => x.n),
    fps,
    ann,
  );
  const hiPiece = (i: number) => segs.some((g) => g.hi && i >= g.first && i <= g.last);
  const lines: string[] = [];
  lines.push(`[0:v]split=${live.length}${live.map((_, i) => `[s${i}]`).join("")}`);
  const scaleTo = `scale=${fw}:${fh}:flags=lanczos,setsar=1`;
  live.forEach(({ p, n }, i) => {
    const scale = hiPiece(i) ? "setsar=1" : scaleTo;
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
  const annBase = 1 + audioInputs.length + images.length;
  const pageOps = ann?.page ?? [];
  const screenOps = ann?.screen ?? [];
  /** Annotation image j as a looped stream long enough for `untilS` seconds. */
  const annImage = (j: number, untilS: number) =>
    `[${annBase + j}:v]loop=loop=${Math.ceil((untilS + 0.2) * fps)}:size=1:start=0,setpts=N/${fps}/TB,`;
  const hasScreen = screenOps.length > 0;
  let cur = framed || brand?.title || brand?.logoBug || hasScreen ? "vcat" : "vout";
  // Segments: low = concat of pre-scaled pieces; hi = concat at source res → page ops → zoom → scale.
  segs.forEach((g, k) => {
    const ins = live
      .slice(g.first, g.last + 1)
      .map((_, i) => `[v${g.first + i}]`)
      .join("");
    const n = g.last - g.first + 1;
    if (!g.hi) {
      lines.push(`${ins}concat=n=${n}:v=1:a=0[g${k}]`);
      return;
    }
    let c = `g${k}raw`;
    lines.push(`${ins}concat=n=${n}:v=1:a=0[${c}]`);
    // Every op overlapping this segment (an op never spans two segments: all pieces under it are hi).
    const inSeg = (o: { startMs: number; endMs: number }) =>
      o.startMs < g.startMs + g.durMs && o.endMs > g.startMs;
    let q = 0;
    const step = () => `g${k}p${q++}`;
    for (const b of (ann?.blurs ?? []).filter(inSeg)) {
      const nx = step();
      lines.push(...blurFilters(b, c, nx, g.startMs, `g${k}b${q}`));
      c = nx;
    }
    pageOps.forEach((o, j) => {
      if (!inSeg(o)) return;
      const nx = step();
      lines.push(
        ...overlayFilters(
          o,
          annImage(j, (o.endMs - g.startMs) / 1000),
          c,
          nx,
          g.startMs,
          `g${k}o${j}`,
        ),
      );
      c = nx;
    });
    for (const z of (ann?.zooms ?? []).filter(inSeg)) {
      if (!opts.source) throw new Error("render: zoom needs the source size");
      const nx = step();
      lines.push(
        `[${c}]${zoomFilter({ ...z, startMs: z.startMs - g.startMs, endMs: z.endMs - g.startMs }, opts.source, fps)}[${nx}]`,
      );
      c = nx;
    }
    lines.push(`[${c}]${scaleTo},format=yuv420p[g${k}]`);
  });
  lines.push(`${segs.map((_, k) => `[g${k}]`).join("")}concat=n=${segs.length}:v=1:a=0[${cur}]`);
  if (brand && framed) {
    const b = brand.inset;
    lines.push(`[${imgIdx("mask")}:v]format=gray,scale=${b.w}:${b.h},setsar=1[mask]`);
    lines.push(`[${cur}]format=yuva420p[vfa]`);
    lines.push("[vfa][mask]alphamerge[vrnd]");
    lines.push(
      `[${imgIdx("backdrop")}:v]scale=${opts.width}:${opts.height},setsar=1,format=yuv420p,fps=${fps}[bg]`,
    );
    const next = brand.title || brand.logoBug || hasScreen ? "vframed" : "vout";
    lines.push(`[bg][vrnd]overlay=${b.x}:${b.y}:shortest=1:format=auto,format=yuv420p[${next}]`);
    cur = next;
  }
  if (hasScreen) {
    let c = cur;
    screenOps.forEach((o, i) => {
      const j = pageOps.length + i;
      const nx =
        i === screenOps.length - 1 ? (brand?.title || brand?.logoBug ? "vann" : "vout") : `sc${i}`;
      lines.push(...overlayFilters(o, annImage(j, o.endMs / 1000), c, nx, 0, `so${i}`));
      c = nx;
    });
    cur = c;
    if (cur !== "vout") lines.push(`[${cur}]format=yuv420p[vann2]`);
    if (cur !== "vout") cur = "vann2";
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
      ...annotationInputs(opts.annotations).flatMap((f) => ["-i", f]),
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
