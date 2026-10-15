/**
 * The Render stage's engine (S5 part 9, D59–D68): plan a render (gate, inputs,
 * annotation selection, variants) and run it as one render version.
 *
 *   draft  any annotation version (or the panel's unsaved draft, or none yet);
 *          full video only, 960×540, fast preset, a DRAFT corner tag
 *   final  an accepted, usable annotation version; full + scenes + sidecars at
 *          output size; qa = null until part 10
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readDraft } from "../annotations/draft.ts";
import { annotationVersions, readAnnotations } from "../annotations/file.ts";
import {
  ANNOTATION_TYPES,
  type AnnotationFile,
  type AnnotationType,
} from "../annotations/types.ts";
import { resolveBrand } from "../brand/brand.ts";
import type { DemoRecConfig } from "../config.ts";
import { type CutResult, renderCut } from "../edit/pipeline.ts";
import type { Timeline } from "../edit/timeline.ts";
import { isUsable } from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import { listVersions } from "../workdir/versioning.ts";
import { writeSidecars } from "./sidecars.ts";
import {
  type RenderKind,
  type RenderOptionsRec,
  type RenderRecord,
  type RenderVariantRec,
  dirBytes,
  listRenders,
  pruneDrafts,
  saveRecord,
  startRecord,
  variantName,
  variantPresent,
  versionDir,
} from "./store.ts";

export const DRAFT_SIZE = { width: 960, height: 540 };
export const DRAFT_ENCODE = { preset: "veryfast", crf: 26 };

export interface RenderRequest {
  kind: RenderKind;
  /** Annotation version (default: the working line's; drafts fall back to the newest for the VO). null = none (drafts only). */
  annotations?: number | null;
  /** Use the panel's unsaved annotation draft (drafts only). */
  fromDraft?: boolean;
  /** Explicit timeline (the sync edit passes its new one). */
  timeline?: number;
  brands?: string[];
  options?: Partial<RenderOptionsRec>;
  /** Required when enabled redactions would be left out (D66). */
  confirmUnredacted?: boolean;
  by: RenderRecord["by"];
}

export interface RenderPlan {
  kind: RenderKind;
  annotationVersion?: number;
  fromDraft: boolean;
  /** Filtered to what this render includes. */
  file?: AnnotationFile;
  included: number;
  timelineVersion: number;
  timeline: Timeline;
  brands: string[];
  options: RenderOptionsRec;
  size: { width: number; height: number };
}

const readTimeline = (projectDir: string, v: number) =>
  JSON.parse(
    fs.readFileSync(path.join(projectDir, "edit", `timeline.v${v}.json`), "utf8"),
  ) as Timeline;

/** The newest timeline for a voice-over version. */
export function latestTimelineFor(projectDir: string, vo?: number): number | undefined {
  for (const v of listVersions(path.join(projectDir, "edit"), "timeline.v", ".json").reverse())
    if (vo === undefined || readTimeline(projectDir, v).voVersion === vo) return v;
  return undefined;
}

export function normalizeOptions(o: Partial<RenderOptionsRec> | undefined): RenderOptionsRec {
  const t = o?.annotationTypes;
  if (
    t !== undefined &&
    t !== "all" &&
    (!Array.isArray(t) || t.some((x) => !ANNOTATION_TYPES.includes(x)))
  )
    throw new Error(`annotationTypes must be "all" or a list of ${ANNOTATION_TYPES.join(", ")}`);
  return {
    annotationTypes: t === undefined ? "all" : Array.isArray(t) ? [...new Set(t)].sort() : "all",
    subtitles: o?.subtitles === true,
    logoBug: o?.logoBug !== false,
  };
}

/** Why a final render isn't possible right now (undefined = it is). */
export function finalBlocker(projectDir: string, annotations?: number | null): string | undefined {
  const state = readState(projectDir);
  if (!state) return "project state missing";
  const v = annotations ?? state.line.annotations;
  if (v === undefined || v === null)
    return "a final render needs an accepted annotation version — accept one in the Annotations tab (or “Use no annotations” there)";
  if (!state.accepted.annotations?.[String(v)])
    return `annotations v${v} are not accepted — accept them in the Annotations tab first`;
  if (!isUsable(projectDir, state.accepted, "annotations", v))
    return `annotations v${v} can't be used: an earlier stage of its line is no longer accepted`;
  return undefined;
}

export function planRender(
  projectDir: string,
  config: DemoRecConfig,
  req: RenderRequest,
): RenderPlan {
  const state = readState(projectDir);
  if (!state) throw new Error("project state missing");
  const options = normalizeOptions(req.options);
  let file: AnnotationFile | undefined;
  let annotationVersion: number | undefined;
  const fromDraft = req.kind === "draft" && req.fromDraft === true;
  if (req.kind === "final") {
    if (req.fromDraft)
      throw new Error(
        "a final can't be rendered from unsaved changes — save them as a version and accept it",
      );
    const why = finalBlocker(projectDir, req.annotations);
    if (why) throw new Error(why);
    annotationVersion = (req.annotations ?? state.line.annotations) as number;
    file = readAnnotations(projectDir, annotationVersion);
  } else if (fromDraft) {
    const d = readDraft(projectDir);
    if (!d) throw new Error("there are no unsaved annotation changes to render");
    annotationVersion = d.base;
    file = d.file;
  } else if (req.annotations !== null) {
    annotationVersion = req.annotations ?? state.line.annotations;
    if (annotationVersion === undefined) {
      // A draft follows the newest annotations for the VO it renders (none yet right after an edit).
      const vo =
        req.timeline !== undefined
          ? readTimeline(projectDir, req.timeline).voVersion
          : state.line.vo;
      annotationVersion = annotationVersions(projectDir)
        .reverse()
        .find((v) => readAnnotations(projectDir, v)?.basedOn.vo === vo);
    }
    if (annotationVersion !== undefined) {
      file = readAnnotations(projectDir, annotationVersion);
      if (!file) throw new Error(`annotations v${annotationVersion} do not exist`);
    }
  }
  const timelineVersion =
    req.timeline ?? latestTimelineFor(projectDir, file ? file.basedOn.vo : state.line.vo);
  if (timelineVersion === undefined)
    throw new Error(
      file
        ? `no edit for VO v${file.basedOn.vo} yet — run the sync edit first`
        : "no edit yet — run the sync edit first",
    );
  const timeline = readTimeline(projectDir, timelineVersion);
  if (file && file.take !== timeline.take)
    throw new Error(
      `annotations v${annotationVersion} are for ${file.take}, the edit uses ${timeline.take}`,
    );
  // Annotation selection (D66): enabled items of the included types.
  let included = 0;
  if (file) {
    const keep = (t: AnnotationType) =>
      options.annotationTypes === "all" || options.annotationTypes.includes(t);
    const leftOutRedactions = file.items.filter(
      (it) => it.enabled && it.type === "redact" && !keep(it.type),
    ).length;
    if (leftOutRedactions && !req.confirmUnredacted)
      throw new Error(
        `this render would leave out ${leftOutRedactions} enabled redaction(s) — it shows what was redacted. Confirm to render anyway.`,
      );
    file = { ...file, items: file.items.filter((it) => it.enabled && keep(it.type)) };
    included = file.items.length;
  }
  const brands = [...new Set(req.brands?.length ? req.brands : [config.brand])];
  for (const b of brands) resolveBrand(config.root, b); // fail fast on unknown brands
  return {
    kind: req.kind,
    ...(annotationVersion !== undefined ? { annotationVersion } : {}),
    fromDraft,
    ...(file ? { file } : {}),
    included,
    timelineVersion,
    timeline,
    brands,
    options,
    size: req.kind === "draft" ? DRAFT_SIZE : config.output,
  };
}

/** What a variant is made of: equal keys render identical files (D68). */
export function reuseKey(plan: RenderPlan, brand: string, fps: number): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        plan.kind,
        plan.timelineVersion,
        plan.timeline.take,
        plan.file?.items ?? [],
        brand,
        plan.options,
        plan.size,
        fps,
        "r1",
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

function linkTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) linkTree(a, b);
    else
      try {
        fs.linkSync(a, b);
      } catch {
        fs.copyFileSync(a, b);
      }
  }
}

export async function runRender(o: {
  projectDir: string;
  config: DemoRecConfig;
  request: RenderRequest;
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; label: string }) => void;
}): Promise<RenderRecord> {
  const plan = planRender(o.projectDir, o.config, o.request);
  const rec = startRecord(o.projectDir, {
    kind: plan.kind,
    basedOn: plan.annotationVersion !== undefined ? { annotations: plan.annotationVersion } : {},
    ...(plan.fromDraft ? { fromDraft: true } : {}),
    timeline: plan.timelineVersion,
    voVersion: plan.timeline.voVersion,
    take: plan.timeline.take,
    by: o.request.by,
    options: plan.options,
    brands: plan.brands,
    size: plan.size,
  });
  const earlier = listRenders(o.projectDir).filter(
    (r) => r.version !== rec.version && r.status === "done" && !r.deleted && !r.pruned,
  );
  try {
    for (const [bi, brand] of plan.brands.entries()) {
      const key = variantName(brand, plan.options);
      const rel = path.join("render", `v${rec.version}`, key);
      const dir = path.join(o.projectDir, rel);
      const rk = reuseKey(plan, brand, o.config.fps);
      const same = earlier
        .flatMap((r) => r.variants.map((v) => ({ r, v })))
        .find(({ v }) => v.reuseKey === rk && variantPresent(o.projectDir, v));
      let variant: RenderVariantRec;
      if (same) {
        o.onProgress?.({
          done: bi,
          total: plan.brands.length,
          label: `${key}: reusing render v${same.r.version}`,
        });
        linkTree(path.join(o.projectDir, same.v.dir), dir);
        variant = { ...same.v, key, dir: rel, reusedFrom: same.r.version };
      } else {
        const cut: CutResult = await renderCut({
          projectDir: o.projectDir,
          config: o.config,
          timelineVersion: plan.timelineVersion,
          cut: {
            brand,
            ...(plan.file ? { annotations: plan.file } : {}),
            size: plan.size,
            scenes: plan.kind === "final",
            logoBug: plan.options.logoBug,
            ...(plan.kind === "draft" ? { encode: DRAFT_ENCODE, stamp: "draft" as const } : {}),
            outDir: dir,
          },
          ...(o.signal ? { signal: o.signal } : {}),
          onProgress: (p) =>
            o.onProgress?.({
              done: bi + p.done / Math.max(1, p.total),
              total: plan.brands.length,
              label: p.label,
            }),
        });
        const side = await writeSidecars({
          projectDir: o.projectDir,
          config: o.config,
          cut,
          plan,
          brand,
          dir,
          ...(o.signal ? { signal: o.signal } : {}),
        });
        variant = {
          key,
          brand,
          dir: rel,
          files: {
            full: "full.mp4",
            scenes: cut.scenes.map((s) => path.relative(dir, s.file)),
            ...side.files,
          },
          bytes: 0,
          durationSec: cut.full.durationSec,
          reuseKey: rk,
          ...(cut.annotations?.warnings.length || side.warnings.length
            ? { warnings: [...(cut.annotations?.warnings ?? []), ...side.warnings] }
            : {}),
        };
      }
      variant.bytes = dirBytes(dir);
      rec.variants.push(variant);
      saveRecord(o.projectDir, rec);
    }
    rec.status = "done";
    rec.finishedAt = new Date().toISOString();
    saveRecord(o.projectDir, rec);
    pruneDrafts(o.projectDir, o.config.render.keepDrafts);
    return rec;
  } catch (err) {
    rec.status = o.signal?.aborted ? "cancelled" : "failed";
    rec.error = (err as Error).message;
    rec.finishedAt = new Date().toISOString();
    saveRecord(o.projectDir, rec);
    if (rec.status === "cancelled")
      fs.rmSync(versionDir(o.projectDir, rec.version), { recursive: true, force: true });
    throw err;
  }
}

export function formatRender(r: RenderRecord): string {
  const head = `${r.kind === "final" ? "Final" : "Draft"} render v${r.version} (${r.status})${r.basedOn.annotations !== undefined ? ` of annotations v${r.basedOn.annotations}${r.fromDraft ? " (unsaved changes)" : ""}` : ", no annotations"} · edit v${r.timeline} · ${r.size.width}×${r.size.height}`;
  const opts = [
    r.options.annotationTypes === "all"
      ? "all annotations"
      : r.options.annotationTypes.length
        ? `only ${r.options.annotationTypes.join(", ")}`
        : "no annotations",
    r.options.subtitles ? "+ burned-in subtitles" : "",
    r.options.logoBug ? "" : "no logo bug",
  ].filter(Boolean);
  const lines = [
    head,
    `options: ${opts.join(", ")}${r.kind === "final" ? " · QA: not checked (part 10)" : ""}`,
  ];
  for (const v of r.variants)
    lines.push(
      `- ${v.key}: ${path.join(v.dir, v.files.full)} (${v.durationSec.toFixed(1)} s, ${(v.bytes / 1e6).toFixed(1)} MB${v.reusedFrom ? `, reused from v${v.reusedFrom}` : ""})${v.files.vtt ? ` · transcript ${v.files.vtt}` : ""}${v.files.fullSubtitled ? ` · subtitled ${v.files.fullSubtitled}` : ""}`,
    );
  if (r.error) lines.push(`error: ${r.error}`);
  for (const v of r.variants) for (const w of v.warnings ?? []) lines.push(`  ! ${v.key}: ${w}`);
  return lines.join("\n");
}
