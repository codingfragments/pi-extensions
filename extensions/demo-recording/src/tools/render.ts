/**
 * demo_rec_render — the Render stage for the agent (S5 part 9, D59–D68):
 * start a draft or final render version (background engine job), check its
 * status, cancel it, list the history. No delete and no accept: only the user
 * does those, in the panel's Render tab.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ANNOTATION_TYPES } from "../annotations/types.ts";
import type { Job } from "../jobs.ts";
import {
  type RenderRequest,
  finalBlocker,
  formatRender,
  planRender,
  runRender,
} from "../render/run.ts";
import { type RenderRecord, legacyRenders, listRenders } from "../render/store.ts";
import type { Runtime } from "../runtime.ts";
import { readState } from "../workdir/state.ts";
import { result } from "./common.ts";

/** Start a render as a background job (one at a time). The panel and the tool both use this. */
export function startRender(rt: Runtime, request: RenderRequest): Job<RenderRecord> {
  const p = rt.requireProject();
  const cfg = rt.getConfig();
  if (rt.jobs.running("render"))
    throw new Error("a render is already running — wait for it or cancel it");
  planRender(p.dir, cfg, request); // validate (gate, inputs, brands) before starting
  return rt.jobs.start<RenderRecord>(
    "render",
    p.slug,
    (signal) =>
      runRender({
        projectDir: p.dir,
        config: cfg,
        request,
        signal,
        onProgress: (pr) =>
          rt.bus.publish(
            "render.progress",
            { ...pr, message: `🎞 ${request.kind} ${pr.label}` },
            p.slug,
          ),
      }),
    (j: Job<RenderRecord>) => {
      const rec = j.result;
      rt.bus.publish(
        "render.finished",
        {
          job: j.id,
          status: j.status,
          kind: request.kind,
          ...(rec ? { version: rec.version } : {}),
          message: rec
            ? `${request.kind} render v${rec.version} ready`
            : `render ${j.status}: ${j.error}`,
        },
        p.slug,
      );
      rt.setStatus(undefined, true);
      const text = rec
        ? `[demo-recording] ${formatRender(rec)}${request.kind === "final" ? "\nThe user can accept it as the deliverable in the Render tab." : ""}`
        : `[demo-recording] Render ${j.status}: ${j.error ?? "unknown error"}`;
      // The agent asked → it gets the report as a turn; the panel asked → a quiet note (D63).
      if (request.by === "agent") rt.reportToAgent(text);
      else rt.tellAgent(text);
    },
  );
}

export function rendersSummary(projectDir: string): string {
  const all = listRenders(projectDir);
  const legacy = legacyRenders(projectDir);
  const state = readState(projectDir);
  const accepted = state?.accepted.render ?? {};
  if (!all.length && !legacy.length) return "No renders yet.";
  const lines = all.slice(0, 12).map((r) => {
    const files = r.deleted ? " · files deleted" : r.pruned ? " · files pruned" : "";
    return `- v${r.version} ${r.kind}${accepted[String(r.version)] ? " ✔ accepted" : ""} (${r.status}) · annotations ${r.basedOn.annotations !== undefined ? `v${r.basedOn.annotations}${r.fromDraft ? "*" : ""}` : "none"} · ${r.variants.map((v) => v.key).join(", ") || "—"}${files}`;
  });
  if (all.length > 12) lines.push(`… ${all.length - 12} older`);
  if (legacy.length)
    lines.push(
      `legacy (before the Render stage): ${legacy.map((l) => `edit v${l.edit}/${l.variant}`).join(", ")}`,
    );
  const why = finalBlocker(projectDir);
  lines.push(why ? `Final: not possible yet — ${why}` : "Final: possible (annotations accepted).");
  return lines.join("\n");
}

export function registerRenderTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_render",
    label: "Demo render",
    description:
      "Render stage (background engine job, no LLM/TTS). start: a new render version — kind draft (any annotation version, full video only, " +
      "960×540, DRAFT tag) or final (needs an accepted annotation version; full + scenes + transcript VTT + callouts SRT + poster at full size). " +
      'Options: brands (several → one variant each), annotationTypes ("all" or a list, e.g. ["chapter"] or [] for none — the annotation version ' +
      "stays as approved), subtitles (also writes *.subtitled.mp4), logoBug. status / cancel / list. You get a [demo-recording] message when it's " +
      "done — don't poll. The user accepts the deliverable and deletes renders in the panel; you cannot.",
    parameters: Type.Object({
      action: StringEnum(["start", "status", "cancel", "list"] as const),
      kind: Type.Optional(
        StringEnum(["draft", "final"] as const, { description: "start: default draft" }),
      ),
      annotations: Type.Optional(
        Type.Union([Type.Number(), Type.Literal("none")], {
          description:
            'start: annotation version (default: the working line\'s); "none" = no annotations (drafts)',
        }),
      ),
      brands: Type.Optional(
        Type.Array(Type.String(), { description: "start: brand packages (default: config brand)" }),
      ),
      annotationTypes: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Array(StringEnum(ANNOTATION_TYPES))], {
          description: "start: which annotation types to include (default all enabled)",
        }),
      ),
      subtitles: Type.Optional(
        Type.Boolean({ description: "start: also write videos with burned-in subtitles" }),
      ),
      logoBug: Type.Optional(
        Type.Boolean({ description: "start: show the brand's logo bug (default true)" }),
      ),
      confirmUnredacted: Type.Optional(
        Type.Boolean({
          description:
            "start: only when the user explicitly confirmed leaving enabled redactions out",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      switch (params.action) {
        case "list":
          return result(rendersSummary(p.dir));
        case "status": {
          const j = rt.jobs.latest("render");
          return result(
            j
              ? `${j.id}: ${j.status}${j.error ? ` — ${j.error}` : ""}`
              : "no render job in this session",
          );
        }
        case "cancel": {
          const j = rt.jobs.running("render");
          if (j) j.controller.abort();
          return result(j ? `cancelling ${j.id}` : "no render running");
        }
        case "start": {
          const job = startRender(rt, {
            kind: params.kind ?? "draft",
            ...(params.annotations === "none"
              ? { annotations: null }
              : params.annotations !== undefined
                ? { annotations: params.annotations }
                : {}),
            ...(params.brands?.length ? { brands: params.brands } : {}),
            options: {
              ...(params.annotationTypes !== undefined
                ? { annotationTypes: params.annotationTypes }
                : {}),
              ...(params.subtitles !== undefined ? { subtitles: params.subtitles } : {}),
              ...(params.logoBug !== undefined ? { logoBug: params.logoBug } : {}),
            },
            ...(params.confirmUnredacted ? { confirmUnredacted: true } : {}),
            by: "agent",
          });
          return result(
            `Render started (${job.id}). You'll get a [demo-recording] message when it's done — don't poll.`,
            { job: job.id },
          );
        }
      }
    },
  });
}
