/**
 * Resolve annotation items against a recording and its edit (S5 part 7):
 * anchor → scene output time window, target → box in SOURCE px (capture
 * resolution, = CSS px × dpr). The result is what the renderer draws.
 */

import fs from "node:fs";
import path from "node:path";
import type { Piece } from "../edit/sync.ts";
import type { SceneTimeline, Timeline } from "../edit/timeline.ts";
import type { TakeEvent } from "../recorder/events.ts";
import { type LayoutSnapshot, layoutAt, readLayout } from "../recorder/layout.ts";
import {
  type AnnotationFile,
  type AnnotationItem,
  type AnnotationTarget,
  type AnnotationType,
  DEFAULT_DURATION,
  FADE_MS,
  LEAD_MS,
  MAX_ZOOM_FACTOR,
} from "./types.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedAnnotation {
  id: string;
  type: AnnotationType;
  scene: string;
  /** Scene output time (ms). */
  startMs: number;
  endMs: number;
  /** The anchor itself (ms, scene output time). */
  atMs: number;
  fadeMs: number;
  /** Target in source px. */
  box?: Box;
  text?: string;
  factor?: number;
}

export interface ResolveContext {
  timeline: Timeline;
  takeDir: string;
  /** Source (capture) size in px — raw.mp4. */
  source: { w: number; h: number };
  /** Viewport in CSS px (take.json). */
  viewport: { width: number; height: number };
}

const pieceDur = (p: Piece) => ("src" in p ? (p.src[1] - p.src[0]) / p.speed : p.freeze.dur);

/** Take time → scene output time (cut regions map to the next kept moment). */
export function takeToSceneMs(sc: SceneTimeline, t: number): number {
  let out = 0;
  for (const p of sc.pieces) {
    if ("src" in p) {
      if (t < p.src[0]) return out; // in a cut before this piece
      if (t <= p.src[1]) return out + (t - p.src[0]) / p.speed;
    }
    out += pieceDur(p);
  }
  return sc.durationMs;
}

/** Scene output time → take time (for layout lookups at a moment). */
export function sceneMsToTake(sc: SceneTimeline, ms: number): number {
  let out = 0;
  let last = 0;
  for (const p of sc.pieces) {
    const d = pieceDur(p);
    if ("src" in p) {
      if (ms <= out + d) return p.src[0] + (ms - out) * p.speed;
      last = p.src[1];
    } else if (ms <= out + d) return p.freeze.at;
    out += d;
  }
  return last;
}

function readEvents(takeDir: string): TakeEvent[] {
  const f = path.join(takeDir, "events.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TakeEvent);
}

function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

/** Find a target box in CSS px. */
export function findTargetBox(
  target: AnnotationTarget,
  ctx: { scene: string; events: TakeEvent[]; snaps: LayoutSnapshot[]; atTake: number },
): { box: Box; how: string } | { error: string } {
  if ("box" in target) return { box: target.box, how: "explicit box" };
  if ("step" in target) {
    const evs = ctx.events.filter((e) => e.scene === ctx.scene && e.step === target.step && e.box);
    const settled = evs.find((e) => e.type === "target-settled");
    const acted = evs.find((e) => e.type !== "target-settled");
    const e = settled ?? acted;
    return e?.box
      ? { box: e.box, how: settled ? "step target (settled)" : "step target" }
      : { error: `step ${target.step} of ${ctx.scene} has no target box in the take` };
  }
  if ("layout" in target) {
    const [, t, id] = /^t(\d+)#(e\d+)$/.exec(target.layout) ?? [];
    const snap = ctx.snaps.find((s) => s.t === Number(t));
    const el = snap?.els.find((e) => e.id === id);
    return el
      ? { box: el.box, how: `layout ${target.layout}` }
      : { error: `layout element ${target.layout} not found` };
  }
  const snap = layoutAt(ctx.snaps, ctx.atTake) ?? ctx.snaps.find((s) => s.t >= ctx.atTake);
  if (!snap)
    return {
      error:
        "this take has no layout snapshots (recorded before S5 part 6) — use { step } or { box }",
    };
  const needle = target.text.toLowerCase();
  const hits = snap.els
    .filter(
      (e) =>
        (!target.role || e.role === target.role) &&
        `${e.text ?? ""} ${e.name ?? ""}`.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
  const hit = hits[0];
  return hit
    ? { box: hit.box, how: `text "${target.text}" (${hit.role} ${hit.id} @t${snap.t})` }
    : {
        error: `no element with text "${target.text}"${target.role ? ` and role ${target.role}` : ""} on screen at the anchor`,
      };
}

/**
 * Resolve every enabled item. Items that can't be resolved are skipped with a
 * warning (never a silent wrong placement).
 */
export function resolveAnnotations(
  file: AnnotationFile,
  ctx: ResolveContext,
): { items: ResolvedAnnotation[]; warnings: string[] } {
  const warnings: string[] = [];
  const events = readEvents(ctx.takeDir);
  const snaps = readLayout(ctx.takeDir);
  const sx = ctx.source.w / ctx.viewport.width;
  const sy = ctx.source.h / ctx.viewport.height;
  const out: ResolvedAnnotation[] = [];
  for (const it of file.items.filter((x) => x.enabled)) {
    const sc = ctx.timeline.scenes.find((s) => s.id === it.scene);
    if (!sc) {
      warnings.push(`${it.id}: scene ${it.scene} is not in the edit — skipped`);
      continue;
    }
    // Anchor → output time (and take time, for layout lookups).
    let atMs: number;
    let atTake: number;
    if ("mark" in it.anchor) {
      const m = it.anchor.mark;
      const anchored = sc.anchors.find((a) => a.mark === m);
      const ev = events.find((e) => e.mark === m);
      if (!anchored && !ev) {
        warnings.push(`${it.id}: mark "${m}" is not in ${it.scene} — skipped`);
        continue;
      }
      atTake = anchored?.event ?? (ev as TakeEvent).t;
      atMs = anchored?.out ?? takeToSceneMs(sc, atTake);
    } else {
      atMs = 0;
      atTake = sceneMsToTake(sc, 0);
    }
    atMs += it.anchor.offsetMs ?? 0;
    if (it.anchor.offsetMs) atTake = sceneMsToTake(sc, atMs);
    const dur = it.durMs ?? DEFAULT_DURATION[it.type];
    const startMs = Math.max(0, atMs - LEAD_MS[it.type]);
    const endMs = Math.min(sc.durationMs, dur > 0 ? atMs + dur : sc.durationMs);
    if (endMs - startMs < 300) {
      warnings.push(`${it.id}: less than 0.3 s left in the scene at its anchor — skipped`);
      continue;
    }
    const r: ResolvedAnnotation = {
      id: it.id,
      type: it.type,
      scene: it.scene,
      startMs,
      endMs,
      atMs,
      fadeMs: FADE_MS[it.type],
    };
    if (it.text) r.text = it.text;
    if (it.type === "zoom") r.factor = Math.min(MAX_ZOOM_FACTOR, it.factor ?? 1.5);
    if (it.target) {
      const found = findTargetBox(it.target, { scene: it.scene, events, snaps, atTake });
      if ("error" in found) {
        warnings.push(`${it.id}: ${found.error} — skipped`);
        continue;
      }
      const b = found.box;
      r.box = {
        x: Math.round(b.x * sx),
        y: Math.round(b.y * sy),
        w: Math.round(b.w * sx),
        h: Math.round(b.h * sy),
      };
      if (it.type === "highlight" && r.box.w * r.box.h > 0.6 * ctx.source.w * ctx.source.h) {
        warnings.push(
          `${it.id}: the target covers more than 60 % of the frame — a highlight would mean nothing, skipped`,
        );
        continue;
      }
    }
    out.push(r);
  }
  // Zooms in one scene must not overlap.
  const zooms = out.filter((r) => r.type === "zoom").sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < zooms.length; i++) {
    const a = zooms[i - 1] as ResolvedAnnotation;
    const b = zooms[i] as ResolvedAnnotation;
    if (a.scene === b.scene && b.startMs < a.endMs) {
      warnings.push(`${b.id}: overlaps zoom ${a.id} — skipped`);
      out.splice(out.indexOf(b), 1);
    }
  }
  // Callouts: one at a time (a later one cuts the earlier one short).
  const callouts = out.filter((r) => r.type === "callout").sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < callouts.length; i++) {
    const a = callouts[i - 1] as ResolvedAnnotation;
    const b = callouts[i] as ResolvedAnnotation;
    if (a.scene === b.scene && b.startMs < a.endMs) a.endMs = Math.max(a.startMs + 300, b.startMs);
  }
  // Warn about a highlight and a spotlight on overlapping regions at the same time (noise).
  for (const a of out)
    for (const b of out)
      if (
        a !== b &&
        a.scene === b.scene &&
        a.type === "highlight" &&
        b.type === "spotlight" &&
        a.box &&
        b.box &&
        overlap(a.box, b.box) > 0 &&
        a.startMs < b.endMs &&
        b.startMs < a.endMs
      )
        warnings.push(
          `${a.id} and ${b.id}: a highlight inside a spotlight at the same time — pick one`,
        );
  return { items: out, warnings };
}

/** Annotations for one scene, in scene time. */
export const forScene = (items: ResolvedAnnotation[], scene: string) =>
  items.filter((r) => r.scene === scene);

/** Shift annotations of each scene by its start in the full video. */
export function forFull(
  items: ResolvedAnnotation[],
  sceneStart: Record<string, number>,
): ResolvedAnnotation[] {
  return items
    .filter((r) => sceneStart[r.scene] !== undefined)
    .map((r) => {
      const o = sceneStart[r.scene] as number;
      return { ...r, startMs: r.startMs + o, endMs: r.endMs + o, atMs: r.atMs + o };
    });
}

export type { AnnotationItem };
