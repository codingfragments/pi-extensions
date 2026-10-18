/**
 * demo_rec_render — the Render stage for the agent (S5 part 9, D59–D68):
 * start a draft or final render version (background engine job), check its
 * status, cancel it, list the history. No delete and no accept: only the user
 * does those, in the panel's Render tab.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ANNOTATION_TYPES } from "../annotations/types.ts";
import type { Job } from "../jobs.ts";
import { fixRequest, formatQa, readQa, renderEvent, runQaSafe } from "../qa/run.ts";
import {
  type RenderRequest,
  finalBlocker,
  formatRender,
  planRender,
  runRender,
} from "../render/run.ts";
import {
  type RenderRecord,
  legacyRenders,
  listRenders,
  readRender,
  saveRecord,
} from "../render/store.ts";
import type { Runtime } from "../runtime.ts";
import { firstLine, jobFacts } from "../util/events.ts";
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
          ...jobFacts(j),
          by: request.by,
          ...(rec
            ? renderEvent(p.dir, rec)
            : {
                kind: request.kind,
                message: `${request.kind} render ${j.status}: ${firstLine(j.error ?? "")}`,
              }),
        },
        p.slug,
      );
      rt.setStatus(undefined, true);
      const q = rec?.qa ? readQa(p.dir, rec.version) : undefined;
      const text = rec
        ? `[demo-recording] ${formatRender(rec)}${q && rec.qa ? `\n${formatQa(q, rec.qa)}` : ""}${request.kind === "final" ? `\n${rec.qa?.status === "blocked" ? "QA blocks accepting it: the user fixes (Apply fixes) or confirms each blocking item in the Render tab." : "The user can accept it as the deliverable in the Render tab."}` : ""}`
        : `[demo-recording] Render ${j.status}: ${j.error ?? "unknown error"}`;
      // The agent asked → it gets the report as a turn; the panel asked → a quiet note (D63).
      if (request.by === "agent") rt.reportToAgent(text);
      else rt.tellAgent(text);
    },
  );
}

/** Re-run QA of a final as a background job (shares the render slot: one at a time). */
export function startQa(rt: Runtime, version: number, by: RenderRecord["by"]): Job<RenderRecord> {
  const p = rt.requireProject();
  const cfg = rt.getConfig();
  if (rt.jobs.running("render")) throw new Error("a render is running — wait for it");
  const rec = readRender(p.dir, version);
  if (!rec) throw new Error(`render v${version} does not exist`);
  if (rec.kind !== "final") throw new Error("QA is for final renders");
  const job = rt.jobs.start<RenderRecord>(
    "render",
    p.slug,
    async (signal) => {
      rt.bus.publish(
        "render.progress",
        {
          done: 0,
          total: 1,
          label: "QA",
          message: `🔎 Checking render v${version}: nothing is rendered`,
        },
        p.slug,
      );
      rec.qa = await runQaSafe({ projectDir: p.dir, config: cfg, rec, signal });
      saveRecord(p.dir, rec);
      return rec;
    },
    (j: Job<RenderRecord>) => {
      rt.bus.publish(
        "render.qa",
        {
          ...jobFacts(j),
          version,
          ...(j.result?.qa ? { qa: renderEvent(p.dir, j.result).qa } : {}),
          message: j.result?.qa
            ? `QA of render v${version}: ${j.result.qa.status} · ${j.result.qa.blocking} hard stop(s)${j.result.qa.confirmed ? ` (${j.result.qa.confirmed} confirmed)` : ""} · ${j.result.qa.warnings} warning(s)`
            : `QA of render v${version} ${j.status}: ${firstLine(j.error ?? "")}`,
        },
        p.slug,
      );
      const r = j.result;
      const q = r ? readQa(p.dir, version) : undefined;
      const text =
        r?.qa && q
          ? `[demo-recording] ${formatQa(q, r.qa)}`
          : `[demo-recording] QA of render v${version} ${j.status}: ${j.error ?? ""}`;
      if (by === "agent") rt.reportToAgent(text);
      else rt.tellAgent(text);
    },
  );
  job.label = "Quality check";
  return job;
}

/** Apply proposed fixes (D74): a new final render with overrides on the same annotations, options and brands. */
export function startFixes(
  rt: Runtime,
  version: number,
  ids: string[] | "all",
  by: RenderRecord["by"],
): Job<RenderRecord> {
  const p = rt.requireProject();
  return startRender(rt, fixRequest(p.dir, version, ids, by));
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
      "stays as approved), subtitles (also writes *.subtitled.mp4), logoBug. Every final gets QA automatically (values said vs. shown, error " +
      "toasts, sync drift, frozen/black/silent stretches, redaction gaps); qa: show a final's report. status / cancel / list. You get a [demo-recording] message when it's " +
      "done — don't poll. The user accepts the deliverable and deletes renders in the panel; you cannot.",
    parameters: Type.Object({
      action: StringEnum(["start", "status", "cancel", "list", "qa"] as const),
      version: Type.Optional(
        Type.Number({
          description: "qa: the final render whose QA report to show (default: newest final)",
        }),
      ),
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
        case "qa": {
          const v = params.version ?? listRenders(p.dir).find((r) => r.kind === "final")?.version;
          if (v === undefined) return result("No final render yet.");
          const rec = readRender(p.dir, v);
          const q = readQa(p.dir, v);
          return result(rec?.qa && q ? formatQa(q, rec.qa) : `render v${v}: QA not run yet`);
        }
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
