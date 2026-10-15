/**
 * Transcript and subtitles of a render (S5 part 9, D61): the spoken words with
 * their OUTPUT times (scene narration through the timeline's audio placement,
 * intro/bridge/outro cards at their start + 0.5 s), cut into readable cues
 * (≤ 2 lines × 42 chars, ≤ 6 s, split at sentence ends and pauses), written
 * as WebVTT, and — as an option — burned into a copy of a rendered video.
 */

import fs from "node:fs";
import path from "node:path";
import { type OverlayOp, type PngJob, overlayFilters, renderPngs } from "../annotations/render.ts";
import type { LoadedBrand } from "../brand/brand.ts";
import type { SceneTimeline, Timeline } from "../edit/timeline.ts";
import { ffmpeg } from "../media/ffmpeg.ts";
import { readManifest } from "../tts/synthesize.ts";

export interface TimedWord {
  w: string;
  startMs: number;
  endMs: number;
}

export interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
}

export const MAX_LINE = 42;
export const MAX_CUE_MS = 6000;
export const PAUSE_MS = 450;

/** Section-audio ms → scene output ms (undefined when that audio was cut). */
function audioOut(sc: SceneTimeline, ms: number): number | undefined {
  const p = sc.audio.find((a) => ms >= a.src[0] - 1 && ms <= a.src[1] + 1);
  return p ? p.at + (ms - p.src[0]) : undefined;
}

/** Words of one scene's narration in scene output time. */
export function sceneWords(projectDir: string, timeline: Timeline, sceneId: string): TimedWord[] {
  const sc = timeline.scenes.find((s) => s.id === sceneId);
  const sec = readManifest(projectDir, timeline.voVersion)?.sections[sceneId];
  if (!sc || !sec) return [];
  const out: TimedWord[] = [];
  for (const w of sec.alignment.words) {
    const s = audioOut(sc, w.s * 1000);
    const e = audioOut(sc, w.e * 1000);
    if (s !== undefined)
      out.push({ w: w.w, startMs: s, endMs: Math.max(s + 80, e ?? s + (w.e - w.s) * 1000) });
  }
  return out;
}

/** Every spoken word of the full video in output time (scenes + cards). */
export function fullWords(
  projectDir: string,
  timeline: Timeline,
  itemStart: number[],
): TimedWord[] {
  const m = readManifest(projectDir, timeline.voVersion);
  if (!m) return [];
  const byFile = new Map(Object.values(m.sections).map((s) => [s.file, s]));
  const out: TimedWord[] = [];
  timeline.full.forEach((item, i) => {
    const at = itemStart[i] ?? 0;
    if (item.type === "scene") {
      for (const w of sceneWords(projectDir, timeline, item.id))
        out.push({ ...w, startMs: w.startMs + at, endMs: w.endMs + at });
    } else if (item.audio) {
      const sec = byFile.get(item.audio.file);
      if (!sec) return;
      for (const w of sec.alignment.words) {
        const ms = w.s * 1000;
        if (ms < item.audio.src[0] || ms > item.audio.src[1]) continue;
        const s = at + 500 + (ms - item.audio.src[0]);
        out.push({ w: w.w, startMs: s, endMs: s + Math.max(80, (w.e - w.s) * 1000) });
      }
    }
  });
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Balance a text over ≤ 2 lines of ≤ MAX_LINE chars. */
export function wrap(words: string[]): string[] {
  const text = words.join(" ");
  if (text.length <= MAX_LINE) return [text];
  let best = 1;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(" ");
    const b = words.slice(k).join(" ");
    if (a.length > MAX_LINE || b.length > MAX_LINE) continue;
    const d = Math.abs(a.length - b.length);
    if (d < bestDiff) {
      bestDiff = d;
      best = k;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

/** Do these words fit in ≤ 2 lines of ≤ MAX_LINE chars? */
const fits = (words: string[]) => wrap(words).every((l) => l.length <= MAX_LINE);

/** Cut words into cues: sentence ends, pauses, ≤ 2 lines, ≤ 6 s. */
export function buildCues(words: TimedWord[]): Cue[] {
  const cues: Cue[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({
      startMs: (cur[0] as TimedWord).startMs,
      endMs: (cur.at(-1) as TimedWord).endMs,
      lines: wrap(cur.map((w) => w.w)),
    });
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    const cand = [...cur.map((x) => x.w), w.w];
    const tooLong = !fits(cand) || (cur[0] && w.endMs - cur[0].startMs > MAX_CUE_MS);
    const pause = prev && w.startMs - prev.endMs >= PAUSE_MS;
    if (cur.length && (tooLong || pause)) flush();
    cur.push(w);
    if (/[.!?…]["”’)]?$/.test(w.w)) flush();
  }
  flush();
  // Readable timing: hold each cue a little after its last word, never into the next one.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i] as Cue;
    const next = cues[i + 1];
    c.endMs = Math.min(c.endMs + 300, next ? next.startMs - 40 : c.endMs + 300);
    if (c.endMs - c.startMs < 700)
      c.endMs = Math.min(c.startMs + 700, next ? next.startMs - 40 : c.startMs + 700);
  }
  return cues.filter((c) => c.endMs > c.startMs);
}

const ts = (ms: number, sep: "." | ",") => {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = Math.floor(ms % 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(f).padStart(3, "0")}`;
};

export const toVtt = (cues: Cue[]) =>
  `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${ts(c.startMs, ".")} --> ${ts(c.endMs, ".")}\n${c.lines.join("\n")}\n`).join("\n")}`;

export const toSrt = (cues: Cue[]) =>
  cues
    .map(
      (c, i) => `${i + 1}\n${ts(c.startMs, ",")} --> ${ts(c.endMs, ",")}\n${c.lines.join("\n")}\n`,
    )
    .join("\n");

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

/**
 * Burn cues into a copy of a rendered video: bottom centre of the footage,
 * lifted above a callout shown at the same time (`avoid`: windows in ms).
 */
export async function burnSubtitles(o: {
  input: string;
  output: string;
  cues: Cue[];
  brand: LoadedBrand;
  size: { width: number; height: number };
  footage: { x: number; y: number; w: number; h: number };
  fps: number;
  cacheDir: string;
  /** Callout windows (output ms) — subtitles move up while one is visible. */
  avoid?: { startMs: number; endMs: number }[];
}): Promise<void> {
  if (!o.cues.length) {
    fs.copyFileSync(o.input, o.output);
    return;
  }
  const s = o.size.height / 1080;
  const b = o.brand.brand;
  const jobs: PngJob[] = o.cues.map((c, i) => ({
    key: `cue${i}`,
    w: o.size.width,
    h: Math.round(260 * s),
    clipSelector: "#cue",
    html: `<!doctype html><html><body style="margin:0;background:transparent;font-family:${b.font.family}"><div id="cue" style="display:inline-block;margin:4px;max-width:${Math.round(o.footage.w * 0.8)}px;padding:${Math.round(8 * s)}px ${Math.round(18 * s)}px;border-radius:${Math.round(10 * s)}px;background:${b.colors.pill};color:${b.colors.pillText};font-size:${Math.round(32 * s)}px;line-height:1.3;font-weight:${Math.max(500, b.font.weight)};text-align:center">${c.lines.map(esc).join("<br>")}</div></body></html>`,
  }));
  const pngs = await renderPngs(jobs, o.cacheDir);
  const base = o.footage.y + o.footage.h - Math.round(30 * s);
  const lift = Math.round(84 * s);
  const ops: OverlayOp[] = o.cues.map((c, i) => {
    const png = pngs.get(`cue${i}`) as { file: string; w: number; h: number };
    const busy = (o.avoid ?? []).some((a) => a.startMs < c.endMs && c.startMs < a.endMs);
    return {
      id: `cue${i}`,
      type: "callout",
      file: png.file,
      w: png.w,
      h: png.h,
      x: Math.round(o.footage.x + (o.footage.w - png.w) / 2),
      y: base - png.h - (busy ? lift : 0),
      startMs: c.startMs,
      endMs: c.endMs,
      fadeMs: 120,
    };
  });
  const lines: string[] = [];
  let cur = "0:v";
  ops.forEach((op, j) => {
    const next = j === ops.length - 1 ? "vout" : `s${j}`;
    lines.push(
      ...overlayFilters(
        op,
        `[${j + 1}:v]loop=loop=${Math.ceil((op.endMs / 1000 + 0.3) * o.fps)}:size=1:start=0,setpts=N/${o.fps}/TB,`,
        cur,
        next,
        0,
        `c${j}`,
      ),
    );
    cur = next;
  });
  const script = `${o.output}.filter.txt`;
  fs.mkdirSync(path.dirname(o.output), { recursive: true });
  fs.writeFileSync(script, lines.join(";\n"));
  try {
    await ffmpeg([
      "-i",
      o.input,
      ...ops.flatMap((op) => ["-i", op.file]),
      "-/filter_complex",
      script,
      "-map",
      "[vout]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      "-y",
      o.output,
    ]);
  } finally {
    fs.rmSync(script, { force: true });
  }
}
