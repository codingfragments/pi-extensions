/**
 * demo_rec_edit — audio-led sync edit + render (background job).
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { annotationVersions, readAnnotations } from "../annotations/file.ts";
import { resolveBrand } from "../brand/brand.ts";
import { type EditResult, buildEdit } from "../edit/pipeline.ts";
import type { Timeline } from "../edit/timeline.ts";
import type { Job } from "../jobs.ts";
import { renderEvent } from "../qa/run.ts";
import { formatRender, runRender } from "../render/run.ts";
import type { RenderRecord } from "../render/store.ts";
import type { Runtime } from "../runtime.ts";
import { firstLine, jobFacts, secs } from "../util/events.ts";
import { latestVersion } from "../workdir/versioning.ts";
import { result } from "./common.ts";
import { startDesigner } from "./designer.ts";

function latestTimeline(projectDir: string): number {
  const v = latestVersion(path.join(projectDir, "edit"), "timeline.v", ".json");
  if (v === undefined) throw new Error("no edit yet — run demo_rec_edit start first");
  return v;
}

/** The sync edit's stats (no outputs). */
export function timelineSummary(version: number, timeline: Timeline): string[] {
  const t = timeline.totals;
  const lines = [
    `Edit v${version}: ${(t.fullMs / 1000).toFixed(1)} s · ${(t.cutMs / 1000).toFixed(1)} s cut, ${(t.frozenMs / 1000).toFixed(1)} s held, narration pauses ${(t.silenceMs / 1000).toFixed(1)} s; worst anchor drift ${t.worstDriftMs} ms.`,
  ];
  for (const s of timeline.scenes) {
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
  if (t.worstDriftMs > 150)
    lines.push(
      "Narration runs past its moment somewhere: shorten that section's text before the anchor, or move the anchor.",
    );
  return lines;
}

/** S4 report (legacy full render into out/edit-vN/). */
export function editSummary(r: EditResult): string {
  const lines = [
    `Rendered edit v${r.version} (brand ${r.brand}${r.rim ? `, footage rim ${r.rim.color} (${r.rim.reason})` : ""}): full video ${r.full.durationSec.toFixed(1)} s (${r.full.file}).`,
    ...timelineSummary(r.version, r.timeline),
    `per-scene videos: ${r.outDir}/scenes/`,
  ];
  if (r.annotations) {
    lines.push(`annotations v${r.annotations.version}: ${r.annotations.applied} burned in`);
    for (const w of r.annotations.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join("\n");
}

/** What a demo_rec_edit job produces (S5 part 9, D65): the timeline and a DRAFT render version. */
export interface EditJobResult {
  version: number;
  timeline: Timeline;
  /** The draft render, when it worked. */
  render?: RenderRecord;
  /**
   * Why the draft render did not come, when it failed AFTER the edit worked (R2-8, D-R2-4): the edit (the timeline, the sync numbers, the hand-off
   * to the annotations) stands either way, and the draft can be re-run (`demo_rec_edit rerender`).
   */
  renderError?: string;
}

export const editJobSummary = (r: EditJobResult) =>
  [
    ...timelineSummary(r.version, r.timeline),
    "",
    r.render
      ? formatRender(r.render)
      : `⚠ The draft render did not come: ${r.renderError ?? "unknown error"}. The edit itself worked (edit v${r.version}); fix that, then demo_rec_edit action=rerender makes the draft.`,
    ...(r.render?.variants.flatMap((v) => (v.warnings ?? []).map((w) => `⚠ ${v.key}: ${w}`)) ?? []),
    "Drafts are for watching; the final render (full quality, scenes, transcripts) comes from the Render stage once annotations are accepted.",
  ].join("\n");

/**
 * D53: after a new sync edit whose voice-over has no annotations yet, hand
 * over to the Annotation designer (unless `annotations.autoSuggest` is off).
 */
export function autoSuggestPending(
  projectDir: string,
  enabled: boolean,
  action: "start" | "rerender",
  r: { timeline: Timeline },
): boolean {
  if (!enabled || action !== "start") return false;
  return !annotationVersions(projectDir).some(
    (v) => readAnnotations(projectDir, v)?.basedOn.vo === r.timeline.voVersion,
  );
}

export function autoSuggestNote(
  projectDir: string,
  enabled: boolean,
  action: "start" | "rerender",
  r: { timeline: Timeline },
): string {
  if (!autoSuggestPending(projectDir, enabled, action, r)) return "";
  return (
    "\n\nNext — Annotations (automatic, config annotations.autoSuggest): load the demo-annotations skill, read " +
    "demo_rec_annotations action=context and submit suggestions with action=suggest. Then tell the user v1 is waiting in the panel's Annotations tab."
  );
}

/**
 * Start an edit (new timeline + a draft render) or a re-render of the latest
 * timeline (a draft render with another brand / annotations) as a background job.
 */
export function startEdit(
  rt: Runtime,
  action: "start" | "rerender",
  brand?: string,
  annotations?: number,
): Job<EditJobResult> {
  const p = rt.requireProject();
  const cfg = rt.getConfig();
  if (brand) resolveBrand(cfg.root, brand); // fail fast on unknown brands
  const progress = (verb: string) => (pr: { done: number; total: number; label: string }) =>
    rt.bus.publish(
      "edit.progress",
      { ...pr, message: `✂ ${verb} ${pr.done.toFixed(0)}/${pr.total} · ${pr.label}` },
      p.slug,
    );
  return rt.jobs.start<EditJobResult>(
    "edit",
    p.slug,
    async (signal) => {
      const edit =
        action === "rerender"
          ? { version: latestTimeline(p.dir) }
          : buildEdit({ projectDir: p.dir, config: cfg });
      // The draft is for watching; the edit (the timeline) is what the next step needs. A draft that fails (a missing brand, a full disk, ffmpeg)
      // must not take the edit's report and the hand-off to the annotations with it (R2-8): it is a warning, and can be re-run.
      let render: RenderRecord | undefined;
      let renderError: string | undefined;
      try {
        render = await runRender({
          projectDir: p.dir,
          config: cfg,
          request: {
            kind: "draft",
            timeline: edit.version,
            ...(annotations !== undefined ? { annotations } : {}),
            ...(brand ? { brands: [brand] } : {}),
            by: "edit",
          },
          signal,
          onProgress: progress(action === "rerender" ? "draft render" : "rendering a draft"),
        });
      } catch (err) {
        if (signal.aborted) throw err; // a cancel is a cancel
        renderError = firstLine((err as Error).message);
      }
      const timeline = JSON.parse(
        fs.readFileSync(path.join(p.dir, "edit", `timeline.v${edit.version}.json`), "utf8"),
      ) as Timeline;
      return {
        version: edit.version,
        timeline,
        ...(render ? { render } : {}),
        ...(renderError ? { renderError } : {}),
      };
    },
    (j: Job<EditJobResult>) => {
      rt.bus.publish(
        "edit.finished",
        {
          ...jobFacts(j),
          action,
          ...(j.result
            ? {
                version: j.result.version,
                ...(j.result.render ? { render: j.result.render.version } : {}),
                ...(j.result.renderError ? { renderError: j.result.renderError } : {}),
                voVersion: j.result.timeline.voVersion,
                take: j.result.timeline.take,
                totals: j.result.timeline.totals,
                offSync: j.result.timeline.scenes.flatMap((s) =>
                  s.anchors
                    .filter((a) => Math.abs(a.drift) > 150)
                    .map((a) => ({ scene: s.id, mark: a.mark, driftMs: a.drift })),
                ),
                scenes: j.result.timeline.scenes.map((s) => ({
                  id: s.id,
                  ms: s.durationMs,
                  ...s.stats,
                })),
              }
            : {}),
          message: j.result
            ? `edit v${j.result.version} · ${secs(j.result.timeline.totals.fullMs)} · cut ${secs(j.result.timeline.totals.cutMs)} · worst drift ${j.result.timeline.totals.worstDriftMs} ms · ${j.result.render ? `draft render v${j.result.render.version}` : `⚠ the draft render failed: ${j.result.renderError ?? "unknown error"}`}`
            : `edit ${j.status}: ${firstLine(j.error ?? "")}`,
        },
        p.slug,
      );
      if (j.result?.render)
        rt.bus.publish(
          "render.finished",
          { ...renderEvent(p.dir, j.result.render), by: "edit" },
          p.slug,
        );
      rt.setStatus(undefined, true);
      if (j.result) {
        const edit = j.result;
        const note = () => autoSuggestNote(p.dir, cfg.annotations.autoSuggest, action, edit);
        let tail = note();
        if (tail) {
          // D85–D90: the Annotation designer as a separate run when the role has a model.
          const started = startDesigner(rt, {
            trigger: "auto",
            voVersion: edit.timeline.voVersion,
            onFallback: (errors) =>
              rt.reportToAgent(
                `[demo-recording] The separate Annotation designer couldn't suggest (${errors.join("; ")}), so it is yours now.${note()}`,
              ),
          });
          if (started.job)
            tail = `\n\nNext — Annotations: the separate Annotation designer (roles.annotationDesigner → ${rt.getConfig().roles.annotationDesigner?.model.join(" → ")}) is suggesting them now. Don't start it yourself; you'll get a note when the version is ready.`;
        }
        rt.reportToAgent(`[demo-recording] ${editJobSummary(edit)}${tail}`);
      } else rt.reportToAgent(`[demo-recording] Edit ${j.status}: ${j.error ?? "unknown error"}`);
    },
  );
}

export function registerEditTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_edit",
    label: "Demo sync edit",
    description:
      "Audio-led edit (background). start: bends the take to the approved voice-over — cuts dead time, gently speeds up or slows down " +
      "static stretches, holds settled frames, never alters typing/clicks or freezes in-app motion — so every [@mark] phrase lands on its event — " +
      "then makes a DRAFT render version (full video, 960×540, DRAFT tag) to watch. rerender: a new draft of the latest edit with another brand " +
      "or annotation version (no LLM/TTS, fast). Final renders (full quality, scenes, transcripts) come from demo_rec_render. You get a [demo-recording] message with sync stats.",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["start", "rerender", "status", "cancel"] as const, {
          description: "default start",
        }),
      ),
      annotations: Type.Optional(
        Type.Number({
          description:
            "rerender: the annotations version for the draft (default: the working line's, else the newest for this voice-over)",
        }),
      ),
      brand: Type.Optional(
        Type.String({
          description: "brand package for the draft (default: config brand) — no LLM, no TTS",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      rt.bindModels((ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry);
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
