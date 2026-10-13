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
import { appDir } from "../workdir/layout.ts";
import { readState, requireApproved, setPhase } from "../workdir/state.ts";
import { result } from "./common.ts";

/** One line of audience/goal context from brief.md for the improviser. */
export function briefContext(brief: string): string | undefined {
  const pick = (label: string) =>
    new RegExp(`\\*\\*${label}:?\\*\\*:?\\s*(.+)`, "i").exec(brief)?.[1]?.trim();
  const parts = [
    pick("Audience") && `audience: ${pick("Audience")}`,
    pick("Goal / key message") && `goal: ${pick("Goal / key message")}`,
  ].filter((x): x is string => !!x && !x.includes("TODO"));
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
      const version = requireApproved(state, "storyboard");
      const sb = readStoryboard(p.dir, version);
      if (!sb) throw new Error(`approved storyboard v${version} is missing on disk`);
      const cfg = rt.getConfig();
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
                  type: e.type,
                  t: e.t,
                  ...(e.scene ? { scene: e.scene } : {}),
                  ...(e.mark ? { mark: e.mark } : {}),
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
              job: j.id,
              status: j.status,
              message: j.result
                ? `${j.result.takeId} recorded`
                : `recording ${j.status}: ${j.error}`,
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
        { job: job.id, version, message: `recording storyboard v${version}` },
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
