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
import { annotationVersions, readAnnotations } from "../annotations/file.ts";
import {
  ANNOTATION_TYPES,
  type AnnotationFile,
  type AnnotationType,
} from "../annotations/types.ts";
import { resolveBrand } from "../brand/brand.ts";
import type { DemoRecConfig } from "../config.ts";
import { preferredAnnotationDraft, readAnnotationDraft } from "../drafts/annotations.ts";
import { type CutResult, renderCut } from "../edit/pipeline.ts";
import type { Timeline } from "../edit/timeline.ts";
import { type RenderOverrides, applyShifts } from "../qa/overrides.ts";
import { runQaSafe } from "../qa/run.ts";
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
  renderNames,
  saveRecord,
  startRecord,
  variantName,
  variantPresent,
  versionDir,
} from "./store.ts";

/** Bump when render output changes for the same inputs, so older variants aren't reused. */
export const RENDER_REVISION = "r3";

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
  /** Mechanical fixes on a copy of the timeline (D74). */
  overrides?: RenderOverrides;
  /** Skip the automatic QA of a final (tests). */
  skipQa?: boolean;
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
  overrides?: RenderOverrides;
  /** True when `timeline` is a modified copy (overrides). */
  modified: boolean;
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
    return "a final render needs an approved annotation version — approve one in the Annotations tab (or “Use no annotations” there)";
  if (!state.accepted.annotations?.[String(v)])
    return `annotations v${v} are not approved — approve them in the Annotations tab first`;
  if (!isUsable(projectDir, state.accepted, "annotations", v))
    return `annotations v${v} can't be used: an earlier stage of its line is no longer approved`;
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
        "a final can't be rendered from unsaved changes — save them as a version and approve it",
      );
    const why = finalBlocker(projectDir, req.annotations);
    if (why) throw new Error(why);
    annotationVersion = (req.annotations ?? state.line.annotations) as number;
    file = readAnnotations(projectDir, annotationVersion);
  } else if (fromDraft) {
    // the draft of the version asked for, else the one on the line's version, else the latest edited
    const d =
      req.annotations !== undefined && req.annotations !== null
        ? readAnnotationDraft(projectDir, req.annotations)
        : preferredAnnotationDraft(projectDir, state.line.annotations);
    if (!d?.changes) throw new Error("there are no unsaved annotation changes to render");
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
  let timeline = readTimeline(projectDir, timelineVersion);
  if (req.overrides?.shifts.length)
    timeline = applyShifts(projectDir, timeline, req.overrides.shifts).timeline;
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
    ...(req.overrides?.shifts.length ? { overrides: req.overrides } : {}),
    modified: !!req.overrides?.shifts.length,
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
        plan.overrides?.shifts ?? [],
        fps,
        RENDER_REVISION,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

/** Hard-link a variant folder (copy if linking fails), renaming its files from one base to another. */
function linkTree(from: string, to: string, rename: (name: string) => string = (n) => n): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.isDirectory() ? e.name : rename(e.name));
    if (e.isDirectory()) linkTree(a, b, rename);
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
    ...(plan.overrides
      ? {
          overrides: {
            fromRender: plan.overrides.fromRender,
            shifts: plan.overrides.shifts.length,
          },
        }
      : {}),
  });
  if (plan.overrides)
    fs.writeFileSync(
      path.join(o.projectDir, "render", `v${rec.version}.overrides.json`),
      `${JSON.stringify(plan.overrides, null, 2)}\n`,
    );
  const earlier = listRenders(o.projectDir).filter(
    (r) => r.version !== rec.version && r.status === "done" && !r.deleted && !r.pruned,
  );
  try {
    for (const [bi, brand] of plan.brands.entries()) {
      const key = variantName(brand, plan.options);
      const names = renderNames(path.basename(o.projectDir), plan.kind, rec.version, key);
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
        const oldBase = renderNames(
          path.basename(o.projectDir),
          same.r.kind,
          same.r.version,
          same.v.key,
        ).base;
        const rn = (n: string) =>
          n.startsWith(oldBase) ? names.base + n.slice(oldBase.length) : n;
        linkTree(path.join(o.projectDir, same.v.dir), dir, rn);
        const f = same.v.files;
        variant = {
          ...same.v,
          key,
          dir: rel,
          reusedFrom: same.r.version,
          files: {
            full: rn(f.full),
            scenes: f.scenes.map((x) => path.join(path.dirname(x), rn(path.basename(x)))),
            ...(f.fullSubtitled ? { fullSubtitled: rn(f.fullSubtitled) } : {}),
            ...(f.scenesSubtitled
              ? {
                  scenesSubtitled: f.scenesSubtitled.map((x) =>
                    path.join(path.dirname(x), rn(path.basename(x))),
                  ),
                }
              : {}),
            ...(f.vtt ? { vtt: rn(f.vtt) } : {}),
            ...(f.scenesVtt
              ? {
                  scenesVtt: f.scenesVtt.map((x) =>
                    path.join(path.dirname(x), rn(path.basename(x))),
                  ),
                }
              : {}),
            ...(f.callouts ? { callouts: rn(f.callouts) } : {}),
            ...(f.poster ? { poster: rn(f.poster) } : {}),
          },
        };
      } else {
        const cut: CutResult = await renderCut({
          projectDir: o.projectDir,
          config: o.config,
          timelineVersion: plan.timelineVersion,
          ...(plan.modified ? { timeline: plan.timeline } : {}),
          cut: {
            brand,
            ...(plan.file ? { annotations: plan.file } : {}),
            size: plan.size,
            scenes: plan.kind === "final",
            logoBug: plan.options.logoBug,
            ...(plan.kind === "draft" ? { encode: DRAFT_ENCODE, stamp: "draft" as const } : {}),
            outDir: dir,
            names: { full: names.full, scene: (id) => names.scene(id) },
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
          names,
          ...(o.signal ? { signal: o.signal } : {}),
        });
        variant = {
          key,
          brand,
          dir: rel,
          files: {
            full: names.full,
            scenes: cut.scenes.map((s) => path.relative(dir, s.file)),
            ...side.files,
          },
          bytes: 0,
          durationSec: cut.full.durationSec,
          timing: { titleMs: cut.titleMs, sceneStart: cut.sceneStart, itemStart: cut.itemStart },
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
    // QA every final (D69): same job, right after the render.
    if (plan.kind === "final" && !o.request.skipQa) {
      o.onProgress?.({ done: plan.brands.length, total: plan.brands.length, label: "QA" });
      rec.qa = await runQaSafe({
        projectDir: o.projectDir,
        config: o.config,
        rec,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      saveRecord(o.projectDir, rec);
    }
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
    r.basedOn.annotations === undefined
      ? ""
      : r.options.annotationTypes === "all"
        ? "all annotations"
        : r.options.annotationTypes.length
          ? `only ${r.options.annotationTypes.join(", ")}`
          : "none included",
    r.options.subtitles ? "+ burned-in subtitles" : "",
    r.options.logoBug ? "" : "no logo bug",
  ].filter(Boolean);
  const lines = [
    head,
    `options: ${opts.join(", ") || "defaults"}${r.kind === "final" ? ` · QA: ${r.qa ? `${r.qa.status}${r.qa.blocking ? ` (${r.qa.blocking} blocking${r.qa.confirmed ? `, ${r.qa.confirmed} confirmed` : ""})` : ""}` : "not run"}` : ""}${r.overrides ? ` · ${r.overrides.shifts} fix(es) on render v${r.overrides.fromRender}` : ""}`,
  ];
  for (const v of r.variants)
    lines.push(
      `- ${v.key}: ${path.join(v.dir, v.files.full)} (${v.durationSec.toFixed(1)} s, ${(v.bytes / 1e6).toFixed(1)} MB${v.reusedFrom ? `, reused from v${v.reusedFrom}` : ""})${v.files.vtt ? ` · transcript ${v.files.vtt}` : ""}${v.files.fullSubtitled ? ` · subtitled ${v.files.fullSubtitled}` : ""}`,
    );
  if (r.error) lines.push(`error: ${r.error}`);
  for (const v of r.variants) for (const w of v.warnings ?? []) lines.push(`  ! ${v.key}: ${w}`);
  return lines.join("\n");
}
