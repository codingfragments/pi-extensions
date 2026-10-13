/**
 * Take analysis (S4, Phase 3 input): everything the director needs to write
 * an anchored voice-over from the ACTUAL run — per scene: span, marks with
 * timestamps and the page text at that moment, improvised inputs, alerts,
 * dead-time (idle) ranges, motion ranges, and keyframes.
 *
 *   takes/take-NNN/analysis/  motion.json  analysis.json  keyframes/<scene>/*.jpg
 */

import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../media/ffmpeg.ts";
import { type TakeEvent, readEvents } from "../recorder/events.ts";
import type { SceneSpan } from "../recorder/runner.ts";
import { type MotionMap, type MotionRange, computeMotion } from "./motion.ts";

export interface Range {
  start: number;
  end: number;
}

export interface MarkInfo {
  mark: string;
  t: number;
  type: string;
  box?: TakeEvent["box"];
  /** Page text (aria snapshot) captured at the mark, trimmed. */
  dom?: string;
  keyframe?: string;
}

export interface SceneAnalysis {
  id: string;
  title: string;
  start: number;
  end: number;
  marks: MarkInfo[];
  /** Typed text, incl. improvised inputs (with source). */
  typed: { t: number; text: string; improvised: boolean; source?: string }[];
  alerts: { t: number; text: string; level: string }[];
  /** Dead time: page busy indicators (observer) and loading-like motion between an action and its result. */
  idle: (Range & { source: "observer" | "motion" })[];
  /** Content arriving while the page is busy (streamed chat answers): never cut. */
  streaming: (Range & { growth: number })[];
  /** Sustained independent screen motion (in-app video, animation). */
  motion: MotionRange[];
  /** Typing/click moments that must never be altered by the editor. */
  protected: (Range & { reason: string })[];
  keyframes: { t: number; label: string; file: string }[];
}

export interface TakeAnalysis {
  take: string;
  takeDir: string;
  storyboardVersion: number;
  durationMs: number;
  viewport: { width: number; height: number; dpr: number };
  scenes: SceneAnalysis[];
  /** Events outside any scene (lead-in/tail). */
  createdAt: string;
}

const KEYFRAME_TYPES = new Set(["alert"]);
const KEYFRAME_WIDTH = 960;

export function analysisDir(takeDir: string): string {
  return path.join(takeDir, "analysis");
}

function trimDom(text: string, max = 2500): string {
  // Drop link urls and placeholders: noise for VO writing.
  const lines = text.split("\n").filter((l) => !/^\s*- \/(url|placeholder):/.test(l));
  const joined = lines.join("\n");
  return joined.length > max ? `${joined.slice(0, max)}\n…` : joined;
}

/** Text growth (chars) above which a busy range is streaming content, not loading. */
export const STREAMING_CHARS = 24;

/** Busy ranges from observer events (idle-start/idle-end pairs) with text growth. */
export function observerBusy(events: TakeEvent[]): (Range & { growth: number })[] {
  const out: (Range & { growth: number })[] = [];
  let open: number | undefined;
  for (const e of events) {
    if (e.type === "idle-start" && open === undefined) open = e.t;
    if (e.type === "idle-end" && open !== undefined) {
      if (e.t - open >= 150)
        out.push({ start: open, end: e.t, growth: Number(e.data?.textGrowth ?? 0) });
      open = undefined;
    }
  }
  return out;
}

/** Dead time (spinners): busy ranges whose text did not grow. */
export function observerIdle(events: TakeEvent[]): Range[] {
  return observerBusy(events)
    .filter((r) => r.growth < STREAMING_CHARS)
    .map(({ start, end }) => ({ start, end }));
}

/** Content arriving while busy (streamed answers): keep, may be sped up gently, never cut. */
export function observerStreaming(events: TakeEvent[]): (Range & { growth: number })[] {
  return observerBusy(events).filter((r) => r.growth >= STREAMING_CHARS);
}

/**
 * Loading-like motion the observer missed: a small-area motion range that
 * starts after an action (click/press) and ends at the next result
 * (wait-satisfied) — e.g. a spinner without a recognizable class name.
 */
export function motionIdle(events: TakeEvent[], motion: MotionRange[], known: Range[]): Range[] {
  const out: Range[] = [];
  for (const m of motion) {
    if (m.area > 0.02) continue; // big changes are content, not spinners
    if (known.some((k) => k.start < m.end && m.start < k.end)) continue;
    const action = [...events]
      .reverse()
      .find((e) => (e.type === "press" || e.type === "click") && e.t <= m.start + 150);
    const result = events.find((e) => e.type === "wait-satisfied" && e.t >= m.end - 250);
    if (action && result && m.start - action.t < 1500 && result.t - m.end < 600)
      out.push({ start: m.start, end: Math.min(m.end, result.t) });
  }
  return out;
}

/** Moments the editor must not cut, speed up or freeze: typing and clicks. */
export function protectedRanges(events: TakeEvent[]): (Range & { reason: string })[] {
  const out: (Range & { reason: string })[] = [];
  let typing: TakeEvent | undefined;
  for (const e of events) {
    if (e.type === "type-start") typing = e;
    if (e.type === "type-end" && typing) {
      out.push({ start: typing.t, end: e.t + 150, reason: "typing" });
      typing = undefined;
    }
    if (e.type === "click") out.push({ start: e.t - 250, end: e.t + 350, reason: "click" });
  }
  return out;
}

async function keyframe(video: string, t: number, file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg([
    "-ss",
    (t / 1000).toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    `scale=${KEYFRAME_WIDTH}:-2`,
    "-q:v",
    "4",
    file,
  ]);
}

export async function analyzeTake(
  takeDir: string,
  opts: { keyframes?: boolean } = {},
): Promise<TakeAnalysis> {
  const meta = JSON.parse(fs.readFileSync(path.join(takeDir, "take.json"), "utf8"));
  if (meta.status !== "ok")
    throw new Error(`take ${path.basename(takeDir)} is not complete (status: ${meta.status})`);
  const video = path.join(takeDir, "raw.mp4");
  const events = readEvents(path.join(takeDir, "events.jsonl"));
  const spans: SceneSpan[] = JSON.parse(fs.readFileSync(path.join(takeDir, "scenes.json"), "utf8"));
  const dir = analysisDir(takeDir);
  fs.mkdirSync(dir, { recursive: true });

  const motion: MotionMap = await computeMotion(video, meta.fps, meta.viewport);
  fs.writeFileSync(
    path.join(dir, "motion.json"),
    JSON.stringify({ fps: motion.fps, ranges: motion.ranges, scores: motion.scores }),
  );

  const idleObs = observerIdle(events);
  const streaming = observerStreaming(events);
  const idleMotion = motionIdle(events, motion.ranges, [...idleObs, ...streaming]);
  const prot = protectedRanges(events);

  const scenes: SceneAnalysis[] = [];
  for (const span of spans) {
    const inScene = (t: number) => t >= span.start && t <= span.end;
    const evs = events.filter(
      (e) => e.scene === span.id || (e.scene === undefined && inScene(e.t)),
    );
    const marks: MarkInfo[] = evs
      .filter((e) => e.mark)
      .map((e) => {
        const domFile = path.join(takeDir, "dom", `${e.mark}.yaml`);
        return {
          mark: e.mark as string,
          t: e.t,
          type: e.type,
          ...(e.box ? { box: e.box } : {}),
          ...(fs.existsSync(domFile) ? { dom: trimDom(fs.readFileSync(domFile, "utf8")) } : {}),
        };
      });
    const kfTimes: { t: number; label: string }[] = [
      { t: span.start + 300, label: "start" },
      ...marks.map((m) => ({ t: Math.min(span.end, m.t + 350), label: m.mark })),
      ...evs
        .filter((e) => KEYFRAME_TYPES.has(e.type))
        .map((e) => ({ t: e.t + 300, label: e.type })),
      { t: Math.max(span.start, span.end - 200), label: "end" },
    ];
    const keyframes: SceneAnalysis["keyframes"] = [];
    if (opts.keyframes !== false) {
      for (const k of kfTimes) {
        const file = path.join(
          dir,
          "keyframes",
          span.id,
          `${String(k.t).padStart(6, "0")}-${k.label}.jpg`,
        );
        await keyframe(video, k.t, file);
        keyframes.push({ ...k, file });
      }
      for (const m of marks) m.keyframe = keyframes.find((k) => k.label === m.mark)?.file;
    }
    const overlaps = (r: Range) => r.start < span.end && span.start < r.end;
    scenes.push({
      id: span.id,
      title: span.title,
      start: span.start,
      end: span.end,
      marks,
      typed: evs
        .filter((e) => e.type === "type-start")
        .map((e) => ({
          t: e.t,
          text: String(e.data?.text ?? ""),
          improvised: !!e.data?.improvised,
          ...(e.data?.source ? { source: String(e.data.source) } : {}),
        })),
      alerts: evs
        .filter((e) => e.type === "alert")
        .map((e) => ({
          t: e.t,
          text: String(e.data?.text ?? ""),
          level: String(e.data?.level ?? "info"),
        })),
      idle: [
        ...idleObs.filter(overlaps).map((r) => ({ ...r, source: "observer" as const })),
        ...idleMotion.filter(overlaps).map((r) => ({ ...r, source: "motion" as const })),
      ].sort((a, b) => a.start - b.start),
      streaming: streaming.filter(overlaps),
      motion: motion.ranges.filter(overlaps),
      protected: prot.filter(overlaps),
      keyframes,
    });
  }

  const analysis: TakeAnalysis = {
    take: path.basename(takeDir),
    takeDir,
    storyboardVersion: meta.storyboardVersion,
    durationMs: meta.durationMs,
    viewport: meta.viewport,
    scenes,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`);
  return analysis;
}

export function readAnalysis(takeDir: string): TakeAnalysis | undefined {
  const file = path.join(analysisDir(takeDir), "analysis.json");
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as TakeAnalysis)
    : undefined;
}

/** Compact text for the director (one block per scene). */
export function formatAnalysis(a: TakeAnalysis): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const lines = [
    `${a.take} (storyboard v${a.storyboardVersion}), ${s(a.durationMs)} total. Times are take time.`,
  ];
  for (const sc of a.scenes) {
    const len = sc.end - sc.start;
    const idle = sc.idle.reduce((n, r) => n + (r.end - r.start), 0);
    lines.push(
      "",
      `## ${sc.id} — ${sc.title}  [${s(sc.start)}–${s(sc.end)}, ${s(len)}; dead time ${s(idle)} → ~${s(len - idle)} usable]`,
    );
    for (const m of sc.marks) lines.push(`- mark @${m.mark} ${s(m.t)} (${m.type})`);
    for (const t of sc.typed)
      lines.push(
        `- typed ${s(t.t)}: "${t.text}"${t.improvised ? ` (improvised, ${t.source})` : ""}`,
      );
    for (const al of sc.alerts) lines.push(`- ⚠ ${al.level} toast ${s(al.t)}: "${al.text}"`);
    for (const r of sc.idle)
      lines.push(`- dead time ${s(r.start)}–${s(r.end)} (${r.source}) — will be cut`);
    for (const r of sc.streaming)
      lines.push(
        `- content streaming in ${s(r.start)}–${s(r.end)} (+${r.growth} chars) — kept, may be sped up gently`,
      );
    for (const r of sc.motion) {
      if (sc.idle.some((i) => i.start < r.end && r.start < i.end)) continue;
      lines.push(
        `- on-screen motion ${s(r.start)}–${s(r.end)} (area ${(r.area * 100).toFixed(1)}%) — not frozen/sped up`,
      );
    }
    for (const m of sc.marks.filter((x) => x.dom))
      lines.push(
        `  page text at @${m.mark}:\n${(m.dom as string)
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`,
      );
  }
  return lines.join("\n");
}
