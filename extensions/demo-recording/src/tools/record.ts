/**
 * demo_rec_record — record a take of the APPROVED storyboard as a background
 * job (S3). The gate is enforced here, not in the prompt. Progress streams to
 * the panel (take.progress) and pi's footer; the result is reported back into
 * the session when the take finishes.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Job } from "../jobs.ts";
import { createImproviser, modelAccessFrom } from "../recorder/improvise.ts";
import { formatProgress } from "../recorder/progress.ts";
import { type TakeResult, recordTake } from "../recorder/runner.ts";
import type { Runtime } from "../runtime.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { firstLine, jobFacts, secs } from "../util/events.ts";
import { briefFieldValue } from "../workdir/brief.ts";
import { appDir } from "../workdir/layout.ts";
import { readState, requireSelected, setPhase } from "../workdir/state.ts";
import { result } from "./common.ts";
import { askFirst, notAllowed, spendTarget } from "./spend.ts";

/** One line of audience/goal context from brief.md for the improviser. */
export function briefContext(brief: string): string | undefined {
  const persona = briefFieldValue(brief, "Persona", ["Audience"]);
  const goal = briefFieldValue(brief, "Goal / key message", ["Goal"]);
  const parts = [persona && `audience: ${persona}`, goal && `goal: ${goal}`].filter(
    (x): x is string => !!x,
  );
  return parts.length ? parts.join("; ").slice(0, 300) : undefined;
}

export function takeSummary(take: TakeResult, version: number): string {
  const marks = take.events
    .filter((e) => e.mark)
    .map((e) => `  ${e.mark} @ ${(e.t / 1000).toFixed(2)}s (${e.scene})`);
  const alerts = take.events.filter((e) => e.type === "alert" && e.data?.level === "error");
  const idle = take.events.filter((e) => e.type === "idle-start").length;
  const improvised = take.events.filter((e) => e.type === "type-start" && e.data?.improvised);
  const resumes = take.segments.filter((s) => s.resumedAfter);
  return [
    `Recorded ${take.takeId} of storyboard v${version}: ${(take.durationMs / 1000).toFixed(1)} s, ${take.capture.frames} frames (${take.capture.width}x${take.capture.height}).`,
    `scenes: ${take.scenes.map((s) => `${s.id} ${(s.start / 1000).toFixed(1)}–${(s.end / 1000).toFixed(1)}s`).join(", ")}`,
    `marks:\n${marks.join("\n") || "  (none)"}`,
    improvised.length
      ? `improvised inputs: ${improvised.map((e) => `"${e.data?.text}" (${e.scene}, ${e.data?.source})`).join("; ")}`
      : "",
    resumes.length
      ? `resumed ${resumes.length}×: ${resumes.map((s) => `${s.resumedAfter?.scene} after "${s.resumedAfter?.error}"`).join("; ")}`
      : "",
    idle ? `loading/dead-time ranges: ${idle} (cut in the edit later)` : "",
    alerts.length
      ? `⚠ error toasts during the take: ${alerts.map((e) => `"${e.data?.text}" @ ${(e.t / 1000).toFixed(1)}s`).join("; ")}`
      : "",
    `files: ${take.takeDir} (raw.mp4, events.jsonl, frames/)`,
    "Voice-over and editing arrive in S4.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerRecordTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_record",
    label: "Demo record take",
    description:
      "Record one continuous take of the APPROVED storyboard in the background (headless, human-like cursor and typing, live improvised inputs, " +
      "auto-retry/resume of failing scenes). action start returns immediately — progress shows in the panel and footer, and you get a message " +
      "with the result (duration, scene spans, mark timestamps, improvised inputs, error toasts) when it finishes. status/cancel manage the job. " +
      "Refuses unless the user approved a storyboard version in the panel.",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["start", "status", "cancel"] as const, { description: "default start" }),
      ),
      headed: Type.Optional(
        Type.Boolean({ description: "Show the browser while recording (default headless)" }),
      ),
      seed: Type.Optional(Type.Number({ description: "RNG seed for reproducible motion/typing" })),
      storyboard: Type.Optional(
        Type.Number({
          description:
            "storyboard version to record (default: the working line's; must be accepted)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const action = params.action ?? "start";
      if (action === "status") {
        const j = rt.jobs.latest("record");
        if (!j) return result("no recording job in this session");
        const p = j.progress
          ? `\n${formatProgress(j.progress as Parameters<typeof formatProgress>[0])}`
          : "";
        return result(`${j.id}: ${j.status}${j.error ? ` — ${j.error}` : ""}${p}`);
      }
      if (action === "cancel") {
        const j = rt.jobs.cancel();
        return result(j ? `cancelling ${j.id}` : "no recording running");
      }

      const p = rt.requireProject();
      const state = readState(p.dir) ?? p.state;
      const version = requireSelected(p.dir, state, "storyboard", params.storyboard);
      const sb = readStoryboard(p.dir, version);
      if (!sb) throw new Error(`approved storyboard v${version} is missing on disk`);
      const cfg = rt.getConfig();
      if (rt.jobs.running("record")) throw new Error("a recording is already running");
      const target = spendTarget("take", version);
      if (!rt.grants.has("take", p.slug, target)) {
        const improvise = sb.storyboard.scenes.reduce(
          (n, s) => n + s.steps.filter((st) => st.do === "improvise").length,
          0,
        );
        return askFirst(
          rt,
          "take",
          target,
          `record a new take of storyboard v${version} (${sb.storyboard.scenes.length} scene(s)${improvise ? `, ${improvise} live input(s) from ${cfg.improvise.models.join(" → ")}` : ""})`,
        );
      }
      await rt.closeDiscovery(); // discovery and recording never share a browser
      const statePath = path.join(appDir(cfg.root, p.app.slug), "auth", "state.json");
      const registry = (
        ctx as { modelRegistry?: Parameters<typeof modelAccessFrom>[0] } | undefined
      )?.modelRegistry;
      const needsModel = sb.storyboard.scenes.some((s) =>
        s.steps.some((st) => st.do === "improvise" && !st.fallback),
      );
      const improviser = registry
        ? createImproviser(modelAccessFrom(registry), cfg.improvise.models, cfg.improvise.timeoutMs)
        : undefined;
      if (needsModel && !improviser)
        throw new Error(
          "this storyboard has improvise steps without a fallback, but no model registry is available",
        );
      const brief = fs.existsSync(path.join(p.dir, "brief.md"))
        ? fs.readFileSync(path.join(p.dir, "brief.md"), "utf8")
        : "";
      const context = briefContext(brief);
      const latest = readStoryboard(p.dir);
      if (["brief", "discovery", "storyboard-review"].includes(state.phase))
        setPhase(p.dir, "recording");

      if (!rt.grants.consume("take", p.slug, target)) throw notAllowed("take", target);
      const job = rt.jobs.start<TakeResult>(
        "record",
        p.slug,
        (signal, j) =>
          recordTake({
            projectDir: p.dir,
            storyboard: sb.storyboard,
            storyboardVersion: version,
            baseUrl: p.app.baseUrl,
            viewport: cfg.viewport,
            fps: cfg.fps,
            capture: cfg.capture,
            signal,
            maxRetriesPerScene: cfg.recording.maxRetriesPerScene,
            typoRate: cfg.recording.typoRate,
            keepFrames: cfg.recording.keepFrames,
            hesitateMs: cfg.improvise.hesitateMs,
            ...(improviser ? { improviser } : {}),
            ...(context ? { improviseContext: context } : {}),
            ...(params.headed ? { headed: true } : {}),
            ...(params.seed !== undefined ? { seed: params.seed } : {}),
            ...(fs.existsSync(statePath) ? { storageState: statePath } : {}),
            onEvent: (e) =>
              rt.bus.publish(
                "take.event",
                {
                  message: `${e.type}${e.mark ? ` @${e.mark}` : ""}${e.scene ? ` · ${e.scene}` : ""} · ${(e.t / 1000).toFixed(2)} s`,
                  type: e.type,
                  t: e.t,
                  ...(e.scene ? { scene: e.scene } : {}),
                  ...(e.step !== undefined ? { step: e.step } : {}),
                  ...(e.mark ? { mark: e.mark } : {}),
                  ...(e.box ? { box: e.box } : {}),
                  ...(e.data ? { detail: e.data } : {}),
                },
                p.slug,
              ),
            onProgress: (snap) => {
              j.progress = snap;
              rt.bus.publish(
                "take.progress",
                { progress: snap, message: formatProgress(snap) },
                p.slug,
              );
            },
          }),
        (j: Job<TakeResult>) => {
          rt.bus.publish(
            "take.finished",
            {
              ...jobFacts(j),
              storyboard: version,
              message: j.result
                ? `${j.result.takeId} recorded · ${secs(j.result.durationMs)} · ${j.result.scenes.length} scene(s)${j.result.segments.length > 1 ? ` · ${j.result.segments.length - 1} resume(s)` : ""}`
                : `recording ${j.status}: ${firstLine(j.error ?? "")}`,
              ...(j.result
                ? {
                    take: j.result.takeId,
                    lengthMs: j.result.durationMs,
                    scenes: j.result.scenes.map((sc) => ({
                      id: sc.id,
                      title: sc.title,
                      ms: sc.end - sc.start,
                    })),
                    resumes: j.result.segments
                      .filter((g) => g.resumedAfter)
                      .map((g) => g.resumedAfter),
                    capture: j.result.capture,
                  }
                : {}),
            },
            p.slug,
          );
          if (j.result) rt.reportToAgent(`[demo-recording] ${takeSummary(j.result, version)}`);
          else
            rt.reportToAgent(
              `[demo-recording] Recording ${j.status}: ${j.error ?? "unknown error"}. Evidence: takes/ (take.json, attempts.jsonl).`,
            );
        },
      );
      rt.bus.publish(
        "take.started",
        {
          job: job.id,
          version,
          url: p.app.baseUrl,
          ...(params.headed ? { headed: true } : {}),
          message: `recording storyboard v${version} on ${p.app.baseUrl}`,
        },
        p.slug,
      );
      return result(
        [
          `Recording started (${job.id}) for storyboard v${version}${latest && latest.version !== version ? ` — note: latest is v${latest.version}, but only v${version} is approved` : ""}.`,
          "Progress is in the panel's Live tab and the footer. You'll receive a [demo-recording] message with the result — don't poll.",
        ].join("\n"),
        { job: job.id },
      );
    },
  });
}
