/**
 * Edit pipeline (S4): approved VO + its voice manifest + the take analysis →
 * timeline.vN.json → out/edit-vN/scenes/NN-<id>.mp4 + full.mp4 (+ timeline copy).
 * Outputs are versioned and never overwritten.
 */

import fs from "node:fs";
import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import { fullOps, prepareAnnotations, sceneOps, takeGeometry } from "../annotations/apply.ts";
import { readAnnotations } from "../annotations/file.ts";
import type { AnnotationFile } from "../annotations/types.ts";
import { type TitleInfo, renderBrandAssets } from "../brand/assets.ts";
import { resolveBrand } from "../brand/brand.ts";
import { type Rim, edgeLuminance, resolveRim } from "../brand/rim.ts";
import type { DemoRecConfig } from "../config.ts";
import { draftStamp } from "../render/stamp.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { readManifest } from "../tts/synthesize.ts";
import { readVo } from "../vo/store.ts";
import { readApp } from "../workdir/layout.ts";
import { readState, requireSelected } from "../workdir/state.ts";
import { writeNextVersion } from "../workdir/versioning.ts";
import { type SceneFit, sceneFits } from "./fit.ts";
import { type RenderBrand, fullJob, renderJob, sceneJob } from "./render.ts";
import { type Timeline, buildTimeline } from "./timeline.ts";

export interface EditResult {
  version: number;
  timeline: Timeline;
  timelineFile: string;
  /** out/edit-vN/<variant>/ */
  outDir: string;
  variant: string;
  brand: string;
  /** Rim drawn around the footage (brand frame.border), if any. */
  rim?: Rim;
  scenes: { id: string; file: string; durationSec: number }[];
  full: { file: string; durationSec: number };
  /** Burned-in annotations (when the variant has them). */
  annotations?: { version: number; applied: number; warnings: string[] };
}

/**
 * Full-video output time of each scene anchor (for reports and tests).
 * `titleMs`: the title card's length when rendered with a brand title — the
 * video then opens on a hold at least that long (see fullJob).
 */
export function fullAnchorTimes(
  t: Timeline,
  opts: { titleMs?: number } = {},
): { scene: string; mark: string; out: number; audioAt: number }[] {
  const res: { scene: string; mark: string; out: number; audioAt: number }[] = [];
  const first = t.full[0];
  const introMs = first?.type === "card" && first.kind === "intro" ? first.durationMs : 0;
  let at = opts.titleMs && introMs < opts.titleMs ? Math.round(opts.titleMs - introMs) : 0;
  for (const item of t.full) {
    if (item.type === "card") {
      at += item.durationMs;
      continue;
    }
    const sc = t.scenes.find((s) => s.id === item.id);
    if (!sc) continue;
    for (const a of sc.anchors)
      res.push({ scene: sc.id, mark: a.mark, out: at + a.out, audioAt: at + a.audioAt });
    at += sc.durationMs;
  }
  return res;
}

export interface VariantOptions {
  /** Brand package name (default: config.brand). */
  brand?: string;
  /** Annotation version to burn in (annotations/vN.json); none = a clean render. */
  annotations?: number;
}

/** Up to `max` keyframes spread over the take's scenes (for auto brand decisions). */
export function takeKeyframes(projectDir: string, take: string, max = 6): string[] {
  const a = readAnalysis(path.join(projectDir, "takes", take));
  const all = (a?.scenes ?? [])
    .flatMap((s) => s.keyframes.map((k) => k.file))
    .filter((f) => fs.existsSync(f));
  if (all.length <= max) return all;
  return Array.from(
    { length: max },
    (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))] as string,
  );
}

/** Variant folder name: the brand for now (callouts/subtitles join in a later step). */
export function variantKey(o: { brand: string; annotations?: number }): string {
  return o.annotations ? `${o.brand}+a${o.annotations}` : o.brand;
}

/** A brief field value, unless it is still a placeholder (`_…_`, `<…>`, TODO). */
function briefField(brief: string, label: string): string | undefined {
  const v = new RegExp(`\\*\\*${label}[^*]*:?\\*\\*:?[ \\t]*(.+)`, "i").exec(brief)?.[1]?.trim();
  if (!v || /^_.*_$/.test(v) || /^<.*>$/.test(v) || /\btodo\b/i.test(v)) return undefined;
  return v;
}

const sameText = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Title card text. Title fallback chain:
 *   brief **Title:** → storyboard `title:` (approved version, else latest) →
 *   the brief's goal when it is short (≤ 60 chars) → the project name.
 * When the title would just repeat the app name, the card shows one line
 * (`title` = the app name, `app` empty) instead of "KEYCRAFT / Keycraft".
 */
export function titleInfoFor(projectDir: string, config: DemoRecConfig): TitleInfo {
  const state = readState(projectDir);
  const app = state ? readApp(config.root, state.app) : undefined;
  const briefFile = path.join(projectDir, "brief.md");
  const brief = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : "";
  const pretty = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  let storyboardTitle: string | undefined;
  try {
    storyboardTitle = readStoryboard(projectDir, state?.line.storyboard)?.storyboard.title;
  } catch {
    storyboardTitle = undefined;
  }
  const goal = briefField(brief, "Goal");
  const title =
    briefField(brief, "Title") ??
    storyboardTitle ??
    (goal && goal.length <= 60 ? goal : undefined) ??
    pretty(path.basename(projectDir));
  const appName = app?.name ?? pretty(state?.app ?? "Demo");
  const date = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const subtitle = briefField(brief, "Subtitle");
  const base = sameText(title, appName)
    ? { app: "", title: appName, date }
    : { app: appName, title, date };
  return subtitle ? { ...base, subtitle } : base;
}

/**
 * Render (or re-render) one variant of an existing timeline: no LLM, no TTS —
 * only raw.mp4 + the timeline + voice audio + brand layers. Used after an
 * edit and by the Export tab's brand switch.
 */
/** Brand assets and the footage frame for a render of `take`. */
export async function prepareBrand(
  projectDir: string,
  config: DemoRecConfig,
  take: string,
  brandName: string,
) {
  const loaded = resolveBrand(config.root, brandName);
  const size = config.output;
  const rim = resolveRim(loaded.brand, size, edgeLuminance(takeKeyframes(projectDir, take)));
  const assets = await renderBrandAssets(loaded, size, {
    cacheDir: path.join(config.root, ".cache", "brand-assets"),
    title: titleInfoFor(projectDir, config),
    ...(rim ? { rim } : {}),
  });
  const frame: RenderBrand = {
    inset: assets.inset,
    ...(assets.backdrop ? { backdrop: assets.backdrop } : {}),
    ...(assets.mask ? { mask: assets.mask } : {}),
  };
  return { loaded, size, rim, assets, frame };
}

/** What one cut (one variant folder) renders — the Render stage's unit (S5 part 9). */
export interface CutOptions {
  brand: string;
  /** The annotation file to burn in, already filtered to what this render includes. */
  annotations?: AnnotationFile;
  /** Output size (default: config.output). Drafts: 960×540. */
  size?: { width: number; height: number };
  /** Per-scene videos too (finals) or only the full video (drafts). */
  scenes: boolean;
  logoBug: boolean;
  encode?: { preset: string; crf: number };
  /** Small corner tag over everything (drafts, D60). */
  stamp?: "draft";
  outDir: string;
}

export interface CutResult {
  timeline: Timeline;
  timelineFile: string;
  outDir: string;
  brand: string;
  rim?: Rim;
  scenes: { id: string; file: string; durationSec: number }[];
  full: { file: string; durationSec: number };
  /** Title card length in the full video (for sidecars). */
  titleMs: number;
  /** Output start of each scene in the full video (for sidecars). */
  sceneStart: Record<string, number>;
  /** Output start of each `timeline.full` item (for sidecars). */
  itemStart: number[];
  annotations?: { version: number; applied: number; warnings: string[] };
}

export const sceneFileName = (id: string, i: number) =>
  `${/^\d+-/.test(id) ? id : `${String(i + 1).padStart(2, "0")}-${id}`}.mp4`;

export async function renderCut(o: {
  projectDir: string;
  config: DemoRecConfig;
  timelineVersion: number;
  cut: CutOptions;
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; label: string }) => void;
}): Promise<CutResult> {
  const timelineFile = path.join(o.projectDir, "edit", `timeline.v${o.timelineVersion}.json`);
  if (!fs.existsSync(timelineFile))
    throw new Error(`edit timeline v${o.timelineVersion} does not exist`);
  const timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8")) as Timeline;
  const raw = path.join(o.projectDir, "takes", timeline.take, "raw.mp4");
  if (!fs.existsSync(raw)) throw new Error(`${timeline.take}/raw.mp4 is missing`);
  const cfg = o.cut.size ? { ...o.config, output: o.cut.size } : o.config;
  const { loaded, size, rim, assets, frame } = await prepareBrand(
    o.projectDir,
    cfg,
    timeline.take,
    o.cut.brand,
  );
  const geo = takeGeometry(o.projectDir, timeline.take);
  const ann = o.cut.annotations;
  const prepared = ann
    ? await prepareAnnotations({
        projectDir: o.projectDir,
        timeline,
        file: ann,
        brand: loaded,
        output: size,
        footage: frame.backdrop ? frame.inset : { x: 0, y: 0, w: size.width, h: size.height },
        cacheDir: path.join(o.config.root, ".cache", "annotation-assets"),
      })
    : undefined;
  const label = path.basename(o.cut.outDir);
  fs.mkdirSync(o.cut.scenes ? path.join(o.cut.outDir, "scenes") : o.cut.outDir, {
    recursive: true,
  });
  const stamp = o.cut.stamp
    ? await draftStamp(
        loaded,
        size,
        path.join(o.config.root, ".cache", "render-assets"),
        loaded.brand.logoBug.enabled && o.cut.logoBug ? loaded.brand.logoBug.position : undefined,
      )
    : undefined;
  const base = {
    fps: o.config.fps,
    width: size.width,
    height: size.height,
    source: geo.source,
    ...(o.cut.encode ? { encode: o.cut.encode } : {}),
    ...(stamp ? { stamp } : {}),
  };
  const total = (o.cut.scenes ? timeline.scenes.length : 0) + 1;
  const scenes: CutResult["scenes"] = [];
  if (o.cut.scenes)
    for (const [i, sc] of timeline.scenes.entries()) {
      if (o.signal?.aborted) throw new Error("render cancelled");
      o.onProgress?.({ done: i, total, label: `scene ${sc.id} (${label})` });
      const file = path.join(o.cut.outDir, "scenes", sceneFileName(sc.id, i));
      const ops = sceneOps(prepared, sc.id);
      const r = await renderJob(sceneJob(timeline, sc.id, o.projectDir), raw, file, {
        ...base,
        brand: frame,
        ...(ops ? { annotations: ops } : {}),
      });
      scenes.push({ id: sc.id, file, durationSec: r.durationSec });
    }
  if (o.signal?.aborted) throw new Error("render cancelled");
  o.onProgress?.({ done: total - 1, total, label: `full video (${label})` });
  const title = assets.title
    ? {
        file: assets.title,
        durationMs: loaded.brand.title.durationMs,
        dissolveMs: loaded.brand.title.dissolveMs,
      }
    : undefined;
  const titleMs = title ? title.durationMs + title.dissolveMs : 0;
  const fullBrand: RenderBrand = {
    ...frame,
    ...(title ? { title } : {}),
    ...(assets.logoBug && o.cut.logoBug
      ? {
          logoBug: {
            file: assets.logoBug.file,
            x: assets.logoBug.x,
            y: assets.logoBug.y,
            opacity: assets.logoBug.opacity,
            fromMs: titleMs,
          },
        }
      : {}),
  };
  const fullFile = path.join(o.cut.outDir, "full.mp4");
  const fj = fullJob(timeline, o.projectDir, { titleMs });
  const fops = fullOps(prepared, fj.sceneStart);
  const r = await renderJob(fj, raw, fullFile, {
    ...base,
    brand: fullBrand,
    ...(fops ? { annotations: fops } : {}),
  });
  o.onProgress?.({ done: total, total, label: `done (${label})` });
  return {
    timeline,
    timelineFile,
    outDir: o.cut.outDir,
    brand: o.cut.brand,
    ...(rim ? { rim } : {}),
    scenes,
    full: { file: fullFile, durationSec: r.durationSec },
    titleMs,
    sceneStart: fj.sceneStart ?? {},
    itemStart: fj.itemStart ?? [],
    ...(prepared
      ? {
          annotations: {
            version: prepared.version,
            applied: prepared.resolved.length,
            warnings: prepared.warnings,
          },
        }
      : {}),
  };
}

/** Legacy (S4–S5 part 8) render into out/edit-vN/<variant>/ — kept for the CLI and old projects. */
export async function renderVariant(o: {
  projectDir: string;
  config: DemoRecConfig;
  timelineVersion: number;
  variant?: VariantOptions;
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; label: string }) => void;
}): Promise<EditResult> {
  const brandName = o.variant?.brand ?? o.config.brand;
  const annVersion = o.variant?.annotations;
  const annFile = annVersion ? readAnnotations(o.projectDir, annVersion) : undefined;
  if (annVersion && !annFile) throw new Error(`annotations v${annVersion} do not exist`);
  const variant = variantKey({
    brand: brandName,
    ...(annVersion ? { annotations: annVersion } : {}),
  });
  const editDir = path.join(o.projectDir, "out", `edit-v${o.timelineVersion}`);
  const r = await renderCut({
    projectDir: o.projectDir,
    config: o.config,
    timelineVersion: o.timelineVersion,
    cut: {
      brand: brandName,
      ...(annFile ? { annotations: annFile } : {}),
      scenes: true,
      logoBug: true,
      outDir: path.join(editDir, variant),
    },
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
  fs.copyFileSync(r.timelineFile, path.join(editDir, "timeline.json"));
  return {
    version: o.timelineVersion,
    timeline: r.timeline,
    timelineFile: r.timelineFile,
    outDir: r.outDir,
    variant,
    brand: brandName,
    ...(r.rim ? { rim: r.rim } : {}),
    scenes: r.scenes,
    full: r.full,
    ...(r.annotations ? { annotations: r.annotations } : {}),
  };
}

/** The sync edit itself: accepted VO + its voice + the take analysis → edit/timeline.vN.json. */
export function buildEdit(o: {
  projectDir: string;
  config: DemoRecConfig;
  /** Voice-over to edit (default: the working line's). Must be accepted and usable. */
  voVersion?: number;
}): { version: number; timeline: Timeline; timelineFile: string } {
  const state = readState(o.projectDir);
  if (!state) throw new Error("project state missing");
  const voVersion = requireSelected(o.projectDir, state, "vo", o.voVersion);
  const vo = readVo(o.projectDir, voVersion);
  if (!vo) throw new Error(`voice-over v${voVersion} is missing`);
  const manifest = readManifest(o.projectDir, voVersion);
  if (!manifest)
    throw new Error(`no voice for voice-over v${voVersion} yet — run demo_rec_tts first`);
  const takeDir = path.join(o.projectDir, "takes", vo.validated.script.take);
  const analysis = readAnalysis(takeDir);
  if (!analysis) throw new Error(`${vo.validated.script.take} has not been analyzed`);
  if (!fs.existsSync(path.join(takeDir, "raw.mp4")))
    throw new Error(`${vo.validated.script.take}/raw.mp4 is missing`);
  const timeline = buildTimeline(analysis, manifest, { fps: o.config.fps, size: o.config.output });
  const stored = writeNextVersion(
    path.join(o.projectDir, "edit"),
    "timeline.v",
    ".json",
    `${JSON.stringify(timeline, null, 2)}\n`,
  );
  return { version: stored.version, timeline, timelineFile: stored.file };
}

/** S4 path: the edit + a full-quality render to out/edit-vN/ (kept for the S4 tests and the CLI). */
export async function runEdit(o: {
  projectDir: string;
  config: DemoRecConfig;
  signal?: AbortSignal;
  variant?: VariantOptions;
  voVersion?: number;
  onProgress?: (p: { done: number; total: number; label: string }) => void;
}): Promise<EditResult> {
  const stored = buildEdit({
    projectDir: o.projectDir,
    config: o.config,
    ...(o.voVersion !== undefined ? { voVersion: o.voVersion } : {}),
  });
  return renderVariant({
    projectDir: o.projectDir,
    config: o.config,
    timelineVersion: stored.version,
    ...(o.variant ? { variant: o.variant } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
}

/**
 * Predicted fit of the REAL voice to the footage for a voice-over version —
 * the same solver the render uses, without rendering (cheap, pure). Undefined
 * until the voice exists for that version.
 */
export function voiceFit(
  projectDir: string,
  voVersion: number,
  config: DemoRecConfig,
): SceneFit[] | undefined {
  const manifest = readManifest(projectDir, voVersion);
  if (!manifest) return undefined;
  const analysis = readAnalysis(path.join(projectDir, "takes", manifest.take));
  if (!analysis) return undefined;
  const timeline = buildTimeline(analysis, manifest, { fps: config.fps, size: config.output });
  const voiceSec = Object.fromEntries(
    Object.values(manifest.sections).map((s) => [s.key, s.durationSec]),
  );
  const usable = Object.fromEntries(
    analysis.scenes.map((s) => [
      s.id,
      s.end - s.start - s.idle.reduce((n, r) => n + r.end - r.start, 0),
    ]),
  );
  return sceneFits(timeline, voiceSec, usable);
}
