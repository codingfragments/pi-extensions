/**
 * demo_rec_edit — audio-led sync edit + render (background job).
 */

import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { annotationVersions, readAnnotations } from "../annotations/file.ts";
import { resolveBrand } from "../brand/brand.ts";
import { type EditResult, renderVariant, runEdit } from "../edit/pipeline.ts";
import type { Job } from "../jobs.ts";
import type { Runtime } from "../runtime.ts";
import { latestVersion } from "../workdir/versioning.ts";
import { result } from "./common.ts";

function latestTimeline(projectDir: string): number {
  const v = latestVersion(path.join(projectDir, "edit"), "timeline.v", ".json");
  if (v === undefined) throw new Error("no edit yet — run demo_rec_edit start first");
  return v;
}

export function editSummary(r: EditResult): string {
  const t = r.timeline.totals;
  const lines = [
    `Rendered edit v${r.version} (brand ${r.brand}${r.rim ? `, footage rim ${r.rim.color} (${r.rim.reason})` : ""}): full video ${r.full.durationSec.toFixed(1)} s (${r.full.file}).`,
    `edits: ${(t.cutMs / 1000).toFixed(1)} s cut, ${(t.frozenMs / 1000).toFixed(1)} s held, narration pauses ${(t.silenceMs / 1000).toFixed(1)} s; worst anchor drift ${t.worstDriftMs} ms.`,
  ];
  for (const s of r.timeline.scenes) {
    const late = s.anchors.filter((a) => Math.abs(a.drift) > 150);
    lines.push(
      `- ${s.id}: ${(s.durationMs / 1000).toFixed(1)} s` +
        `${s.stats.cutMs ? `, cut ${(s.stats.cutMs / 1000).toFixed(1)} s` : ""}${s.stats.frozenMs ? `, held ${(s.stats.frozenMs / 1000).toFixed(1)} s` : ""}` +
        `${s.stats.silenceMs ? `, narrator waits ${(s.stats.silenceMs / 1000).toFixed(1)} s` : ""}` +
        `${s.stats.stretchMs > 100 ? `, end stretched +${(s.stats.stretchMs / 1000).toFixed(1)} s` : ""}` +
        `${s.stats.overrunMs > 100 ? ` ⚠ overrun ${(s.stats.overrunMs / 1000).toFixed(1)} s over moving content` : ""}` +
        `${late.length ? ` ⚠ off-sync: ${late.map((a) => `@${a.mark} ${a.drift > 0 ? "+" : ""}${a.drift} ms`).join(", ")}` : ""}`,
    );
  }
  lines.push(`per-scene videos: ${r.outDir}/scenes/`);
  if (r.annotations) {
    lines.push(`annotations v${r.annotations.version}: ${r.annotations.applied} burned in`);
    for (const w of r.annotations.warnings) lines.push(`  ! ${w}`);
  }
  if (r.timeline.totals.worstDriftMs > 150) {
    lines.push(
      "Narration runs past its moment somewhere: shorten that section's text before the anchor, or move the anchor.",
    );
  }
  return lines.join("\n");
}

/**
 * D53: after a new sync edit whose voice-over has no annotations yet, hand
 * over to the Annotation designer (unless `annotations.autoSuggest` is off).
 */
export function autoSuggestNote(
  projectDir: string,
  enabled: boolean,
  action: "start" | "rerender",
  r: EditResult,
): string {
  if (!enabled || action !== "start") return "";
  const has = annotationVersions(projectDir).some(
    (v) => readAnnotations(projectDir, v)?.basedOn.vo === r.timeline.voVersion,
  );
  if (has) return "";
  return (
    "\n\nNext — Annotations (automatic, config annotations.autoSuggest): load the demo-annotations skill, read " +
    "demo_rec_annotations action=context and submit suggestions with action=suggest. Then tell the user v1 is waiting in the panel's Annotations tab."
  );
}

/** Start an edit (new timeline) or a re-render of the latest timeline as a background job. */
export function startEdit(
  rt: Runtime,
  action: "start" | "rerender",
  brand?: string,
  annotations?: number,
): Job<EditResult> {
  const p = rt.requireProject();
  const cfg = rt.getConfig();
  if (brand) resolveBrand(cfg.root, brand); // fail fast on unknown brands
  const timelineVersion = action === "rerender" ? latestTimeline(p.dir) : 0;
  const progress = (verb: string) => (pr: { done: number; total: number; label: string }) =>
    rt.bus.publish(
      "edit.progress",
      { ...pr, message: `✂ ${verb} ${pr.done}/${pr.total} · ${pr.label}` },
      p.slug,
    );
  return rt.jobs.start<EditResult>(
    "edit",
    p.slug,
    (signal) =>
      action === "rerender"
        ? renderVariant({
            projectDir: p.dir,
            config: cfg,
            timelineVersion,
            variant: { brand: brand ?? cfg.brand, ...(annotations ? { annotations } : {}) },
            signal,
            onProgress: progress("re-rendering"),
          })
        : runEdit({
            projectDir: p.dir,
            config: cfg,
            ...(brand ? { variant: { brand } } : {}),
            signal,
            onProgress: progress("rendering"),
          }),
    (j: Job<EditResult>) => {
      rt.bus.publish(
        "edit.finished",
        {
          job: j.id,
          status: j.status,
          ...(j.result
            ? { version: j.result.version, variant: j.result.variant, file: j.result.full.file }
            : {}),
          message: j.result
            ? `edit v${j.result.version} rendered (${j.result.variant})`
            : `edit ${j.status}: ${j.error}`,
        },
        p.slug,
      );
      rt.setStatus(undefined, true);
      if (j.result)
        rt.reportToAgent(
          `[demo-recording] ${editSummary(j.result)}${autoSuggestNote(p.dir, cfg.annotations.autoSuggest, action, j.result)}`,
        );
      else rt.reportToAgent(`[demo-recording] Edit ${j.status}: ${j.error ?? "unknown error"}`);
    },
  );
}

export function registerEditTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_edit",
    label: "Demo sync edit",
    description:
      "Audio-led edit and render (background). rerender: re-render the latest edit with another brand only (no LLM/TTS, fast). start: bends the take to the approved voice-over — cuts dead time, gently speeds up or slows down " +
      "static stretches, holds settled frames, never alters typing/clicks or freezes in-app motion — so every [@mark] phrase lands on its event. " +
      "Renders per-scene MP4s and the full video (intro, bridges, outro) to out/edit-vN/. You get a [demo-recording] message with sync stats.",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["start", "rerender", "status", "cancel"] as const, {
          description: "default start",
        }),
      ),
      annotations: Type.Optional(
        Type.Number({
          description:
            "rerender: burn in this annotations version (out/edit-vN/<brand>+aN/, next to the clean render)",
        }),
      ),
      brand: Type.Optional(
        Type.String({
          description:
            "brand package for this render (default: config brand); rerender: re-render the latest edit with this brand — no LLM, no TTS",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const action = params.action ?? "start";
      if (action === "status") {
        const j = rt.jobs.latest("edit");
        return result(
          j
            ? `${j.id}: ${j.status}${j.error ? ` — ${j.error}` : ""}`
            : "no edit job in this session",
        );
      }
      if (action === "cancel") {
        const j = rt.jobs.running("edit");
        if (j) j.controller.abort();
        return result(j ? `cancelling ${j.id}` : "no edit running");
      }
      if (params.annotations !== undefined && action !== "rerender")
        throw new Error(
          "annotations go with action=rerender (re-render the latest edit with them)",
        );
      const job = startEdit(rt, action, params.brand, params.annotations);
      return result(
        `Edit started (${job.id}). You'll get a [demo-recording] message with the output paths and sync stats — don't poll.`,
        { job: job.id },
      );
    },
  });
}
