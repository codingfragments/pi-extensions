/**
 * Start the Annotation designer as a separate model run (S5 part 12, D85–D90)
 * as an engine job. It replaces the agent turn after a sync edit (auto-suggest)
 * and for the panel's (Re-)suggest; when it can't deliver, `onFallback` hands
 * the work to the Director as before.
 */

import { annotationContext } from "../annotations/context.ts";
import { type DesignerRunResult, runDesigner } from "../annotations/designer-run.ts";
import { zoomLimitsOf } from "../annotations/zoom-limits.ts";
import type { Job } from "../jobs.ts";
import { reportAs } from "../roles.ts";
import type { Runtime } from "../runtime.ts";
import { firstLine, jobFacts, secs } from "../util/events.ts";
import { publishSuggested, timelineFor } from "./annotations.ts";

export interface DesignerStart {
  /** Why the separate run isn't used (not configured, no model access, busy). */
  skipped?: string;
  job?: Job<DesignerRunResult>;
}

/** Is the role configured, and can the engine reach pi's models right now? */
export function designerAvailable(rt: Runtime): { models: string[] } | { skipped: string } {
  const models = rt.getConfig().roles.annotationDesigner?.model;
  if (!models?.length) return { skipped: "roles.annotationDesigner.model is not set" };
  if (!rt.modelAccess)
    return { skipped: "pi's model access isn't available yet (open a session first)" };
  if (rt.jobs.running("design")) return { skipped: "a designer run is already going" };
  return { models };
}

export function startDesigner(
  rt: Runtime,
  o: {
    trigger: "auto" | "panel";
    base?: number;
    instructions?: string;
    /** The VO whose edit to annotate (default: the working line's). */
    voVersion?: number;
    /** The designer couldn't deliver: hand over to the Director (errors listed). */
    onFallback: (errors: string[]) => void;
  },
): DesignerStart {
  const avail = designerAvailable(rt);
  if ("skipped" in avail) return { skipped: avail.skipped };
  const access = rt.modelAccess;
  if (!access) return { skipped: "no model access" };
  const p = rt.requireProject();
  const { version, timeline } = timelineFor(p.dir, o.voVersion);
  // Run-and-tell (P1a): it starts by itself after the voice step, so it says so, with what it costs.
  if (o.trigger === "auto") {
    let pack = "";
    try {
      const text = annotationContext({
        projectDir: p.dir,
        timeline,
        timelineVersion: version,
        ...(o.base !== undefined ? { base: o.base } : {}),
        zoomLimits: zoomLimitsOf(rt.getConfig()),
      });
      pack = `, about ${Math.round(text.length / 4).toLocaleString("en-US")} tokens in, one call`;
    } catch {
      // the announcement just goes without the number
    }
    rt.bus.publish(
      "design.announced",
      {
        trigger: "auto",
        models: avail.models,
        message: `🎨 started by itself after the voice step: the annotation designer (${avail.models.join(" → ")}${pack}). Turn it off with annotations.autoSuggest.`,
      },
      p.slug,
    );
  }
  const job = rt.jobs.start<DesignerRunResult>(
    "design",
    p.slug,
    (signal) =>
      runDesigner({
        projectDir: p.dir,
        timeline,
        timelineVersion: version,
        ...(o.base !== undefined ? { base: o.base } : {}),
        ...(o.instructions ? { instructions: o.instructions } : {}),
        zoomLimits: zoomLimitsOf(rt.getConfig()),
        access,
        models: avail.models,
        signal,
        onStep: (what) => {
          rt.setStatus(`🎨 annotation designer: ${what}`);
          rt.bus.publish(
            "design.progress",
            { message: `🎨 designer · ${what}`, step: what, trigger: o.trigger },
            p.slug,
          );
        },
      }),
    (j) => {
      rt.setStatus(undefined, true);
      const facts = { ...jobFacts(j), trigger: o.trigger, models: avail.models };
      if (j.result) {
        const r = j.result;
        publishSuggested(rt, p.slug, r.report, o, `annotation-designer (${r.model})`, {
          separateRun: true,
          model: r.model,
          repaired: r.repaired,
          tried: r.tried,
          suggested: r.suggested,
        });
        rt.bus.publish(
          "design.finished",
          {
            ...facts,
            version: r.report.version,
            model: r.model,
            repaired: r.repaired,
            message: `designer v${r.report.version} on ${r.model} · ${secs(Date.now() - j.startedAt)}${r.repaired ? " · one repair round" : ""}`,
          },
          p.slug,
        );
        rt.tellAgent(
          `${reportAs("Annotation designer")} Annotations v${r.report.version} were suggested by the separate Annotation designer (${r.model}${r.repaired ? ", after one repair round" : ""}): ${r.report.added} placed, ${r.report.enabled} on${r.report.dropped.length ? `, ${r.report.dropped.length} not placed (${r.report.dropped.map((d) => d.id).join(", ")})` : ""}. The user reviews them in the Annotations tab — nothing to do unless they ask for changes.`,
        );
        return;
      }
      if (j.status === "cancelled") return;
      const errors = [j.error ?? "failed"];
      const detail = errors.join("; ");
      rt.bus.publish(
        "design.finished",
        {
          ...facts,
          fallback: true,
          message: `designer failed (${firstLine(detail)}) — the agent takes over`,
        },
        p.slug,
      );
      o.onFallback(errors);
    },
  );
  return { job };
}
