/**
 * Prepare an annotation file for a render (S5 part 7): resolve against the
 * take and timeline, build the overlay PNGs once (in scene time), then shift
 * per job (scene video = 0, full video = the scene's start).
 */

import fs from "node:fs";
import path from "node:path";
import type { LoadedBrand } from "../brand/brand.ts";
import type { Timeline } from "../edit/timeline.ts";
import { readManifest } from "../tts/synthesize.ts";
import { type RenderAnnotations, buildRenderAnnotations } from "./render.ts";
import {
  type ResolveContext,
  type ResolvedAnnotation,
  type SpokenWord,
  resolveAnnotations,
} from "./resolve.ts";
import type { AnnotationFile } from "./types.ts";

export interface PreparedAnnotations {
  version: number;
  resolved: ResolvedAnnotation[];
  /** Ops per scene, in scene output time. */
  scenes: Record<string, RenderAnnotations>;
  warnings: string[];
}

const empty = (): RenderAnnotations => ({ page: [], blurs: [], zooms: [], screen: [] });

export function takeGeometry(projectDir: string, take: string) {
  const meta = JSON.parse(
    fs.readFileSync(path.join(projectDir, "takes", take, "take.json"), "utf8"),
  ) as {
    viewport: { width: number; height: number; dpr?: number };
    captureStats?: { width?: number; height?: number };
  };
  const dpr = meta.viewport.dpr ?? 1;
  return {
    viewport: { width: meta.viewport.width, height: meta.viewport.height },
    source: {
      w: meta.captureStats?.width ?? Math.round(meta.viewport.width * dpr),
      h: meta.captureStats?.height ?? Math.round(meta.viewport.height * dpr),
    },
  };
}

/** Voice-over word timings per scene section (for `{ word }` anchors). */
export function voWords(projectDir: string, voVersion: number): Record<string, SpokenWord[]> {
  const m = readManifest(projectDir, voVersion);
  const out: Record<string, SpokenWord[]> = {};
  for (const [key, sec] of Object.entries(m?.sections ?? {}))
    if (!key.startsWith("_")) out[key] = sec.alignment.words.map((w) => ({ w: w.w, s: w.s }));
  return out;
}

/** Everything the resolver needs for a timeline (take geometry, events dir, word timings). */
export function resolveContext(projectDir: string, timeline: Timeline): ResolveContext {
  return {
    timeline,
    takeDir: path.join(projectDir, "takes", timeline.take),
    ...takeGeometry(projectDir, timeline.take),
    words: voWords(projectDir, timeline.voVersion),
  };
}

export async function prepareAnnotations(o: {
  projectDir: string;
  timeline: Timeline;
  file: AnnotationFile;
  brand: LoadedBrand;
  output: { width: number; height: number };
  /** Where the footage sits (the brand inset; the whole frame when unframed). */
  footage: { x: number; y: number; w: number; h: number };
  cacheDir: string;
}): Promise<PreparedAnnotations> {
  const warnings: string[] = [];
  if (o.file.take !== o.timeline.take)
    throw new Error(
      `annotations v${o.file.version} are for ${o.file.take}, but this edit uses ${o.timeline.take}`,
    );
  if (o.file.basedOn.vo !== o.timeline.voVersion)
    warnings.push(
      `annotations v${o.file.version} were made for VO v${o.file.basedOn.vo}, this edit uses VO v${o.timeline.voVersion} — anchors still map through marks, check the timing`,
    );
  const geo = resolveContext(o.projectDir, o.timeline);
  const r = resolveAnnotations(o.file, geo);
  warnings.push(...r.warnings);
  const scenes: Record<string, RenderAnnotations> = {};
  for (const sc of o.timeline.scenes) {
    const items = r.items.filter((x) => x.scene === sc.id);
    if (!items.length) continue;
    const b = await buildRenderAnnotations(items, {
      brand: o.brand,
      source: geo.source,
      out: o.output,
      footage: o.footage,
      cacheDir: o.cacheDir,
    });
    warnings.push(...b.warnings);
    scenes[sc.id] = b.ops;
  }
  return { version: o.file.version, resolved: r.items, scenes, warnings };
}

const shift = <T extends { startMs: number; endMs: number }>(xs: T[], d: number): T[] =>
  xs.map((x) => ({ ...x, startMs: x.startMs + d, endMs: x.endMs + d }));

/**
 * Ops for one scene video. Chapter titles belong to the full video (they
 * introduce a scene in the sequence); per-scene clips get them only on request.
 */
export function sceneOps(
  p: PreparedAnnotations | undefined,
  scene: string,
  o: { chapters?: boolean } = {},
): RenderAnnotations | undefined {
  const ops = p?.scenes[scene];
  if (!ops || o.chapters) return ops;
  return { ...ops, screen: ops.screen.filter((x) => x.type !== "chapter") };
}

/** Ops for the full video (scene ops shifted by each scene's start). */
export function fullOps(
  p: PreparedAnnotations | undefined,
  sceneStart: Record<string, number> | undefined,
): RenderAnnotations | undefined {
  if (!p || !sceneStart) return undefined;
  const all = empty();
  for (const [id, ops] of Object.entries(p.scenes)) {
    const d = sceneStart[id];
    if (d === undefined) continue;
    all.page.push(...shift(ops.page, d));
    all.blurs.push(...shift(ops.blurs, d));
    all.zooms.push(...shift(ops.zooms, d));
    all.screen.push(...shift(ops.screen, d));
  }
  return all;
}
