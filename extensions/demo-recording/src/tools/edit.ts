/**
 * demo_rec_edit — audio-led sync edit + render (background job).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type EditResult, runEdit } from "../edit/pipeline.ts";
import type { Job } from "../jobs.ts";
import type { Runtime } from "../runtime.ts";
import { result } from "./common.ts";

export function editSummary(r: EditResult): string {
  const t = r.timeline.totals;
  const lines = [
    `Rendered edit v${r.version}: full video ${r.full.durationSec.toFixed(1)} s (${r.full.file}).`,
    `edits: ${(t.cutMs / 1000).toFixed(1)} s cut, ${(t.frozenMs / 1000).toFixed(1)} s held, narration pauses ${(t.silenceMs / 1000).toFixed(1)} s; worst anchor drift ${t.worstDriftMs} ms.`,
  ];
  for (const s of r.timeline.scenes) {
    const late = s.anchors.filter((a) => Math.abs(a.drift) > 150);
    lines.push(
      `- ${s.id}: ${(s.durationMs / 1000).toFixed(1)} s` +
        `${s.stats.cutMs ? `, cut ${(s.stats.cutMs / 1000).toFixed(1)} s` : ""}${s.stats.frozenMs ? `, held ${(s.stats.frozenMs / 1000).toFixed(1)} s` : ""}` +
        `${s.stats.silenceMs ? `, narrator waits ${(s.stats.silenceMs / 1000).toFixed(1)} s` : ""}` +
        `${late.length ? ` ⚠ off-sync: ${late.map((a) => `@${a.mark} ${a.drift > 0 ? "+" : ""}${a.drift} ms`).join(", ")}` : ""}`,
    );
  }
  lines.push(`per-scene videos: ${r.outDir}/scenes/`);
  if (r.timeline.totals.worstDriftMs > 150) {
    lines.push(
      "Narration runs past its moment somewhere: shorten that section's text before the anchor, or move the anchor.",
    );
  }
  return lines.join("\n");
}

export function registerEditTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_edit",
    label: "Demo sync edit",
    description:
      "Audio-led edit and render (background): bends the take to the approved voice-over — cuts dead time, gently speeds up or slows down " +
      "static stretches, holds settled frames, never alters typing/clicks or freezes in-app motion — so every [@mark] phrase lands on its event. " +
      "Renders per-scene MP4s and the full video (intro, bridges, outro) to out/edit-vN/. You get a [demo-recording] message with sync stats.",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["start", "status", "cancel"] as const, { description: "default start" }),
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
      const p = rt.requireProject();
      const cfg = rt.getConfig();
      const job = rt.jobs.start<EditResult>(
        "edit",
        p.slug,
        (signal) =>
          runEdit({
            projectDir: p.dir,
            config: cfg,
            signal,
            onProgress: (pr) =>
              rt.bus.publish(
                "edit.progress",
                { ...pr, message: `✂ rendering ${pr.done}/${pr.total} · ${pr.label}` },
                p.slug,
              ),
          }),
        (j: Job<EditResult>) => {
          rt.bus.publish(
            "edit.finished",
            {
              job: j.id,
              status: j.status,
              message: j.result
                ? `edit v${j.result.version} rendered`
                : `edit ${j.status}: ${j.error}`,
            },
            p.slug,
          );
          rt.setStatus(undefined, true);
          if (j.result) rt.reportToAgent(`[demo-recording] ${editSummary(j.result)}`);
          else rt.reportToAgent(`[demo-recording] Edit ${j.status}: ${j.error ?? "unknown error"}`);
        },
      );
      return result(
        `Edit started (${job.id}). You'll get a [demo-recording] message with the output paths and sync stats — don't poll.`,
        { job: job.id },
      );
    },
  });
}
