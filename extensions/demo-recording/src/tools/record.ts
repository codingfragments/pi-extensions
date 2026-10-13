/**
 * demo_rec_record — record a take of the APPROVED storyboard (gate enforced
 * here, not in the prompt). S2 runs the S1 recorder in the foreground with
 * progress updates; S3 moves it to background jobs with resume.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recordTake } from "../recorder/runner.ts";
import type { Runtime } from "../runtime.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { appDir } from "../workdir/layout.ts";
import { readState, requireApproved } from "../workdir/state.ts";
import { result } from "./common.ts";

export function registerRecordTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_record",
    label: "Demo record take",
    description:
      "Record one continuous take of the approved storyboard (headless, virtual cursor, CDP screencast). Refuses unless the user approved a " +
      "storyboard version in the panel. Returns the take id, duration, anchor marks with timestamps, and file paths.",
    parameters: Type.Object({
      headed: Type.Optional(
        Type.Boolean({ description: "Show the browser while recording (default headless)" }),
      ),
      seed: Type.Optional(Type.Number({ description: "RNG seed for reproducible motion/typing" })),
    }),
    async execute(_id, params, _signal, onUpdate) {
      const p = rt.requireProject();
      const state = readState(p.dir) ?? p.state;
      const version = requireApproved(state, "storyboard");
      const sb = readStoryboard(p.dir, version);
      if (!sb) throw new Error(`approved storyboard v${version} is missing on disk`);
      const cfg = rt.getConfig();
      // Discovery and recording must not share the browser; close discovery first.
      await rt.closeDiscovery();
      const statePath = path.join(appDir(cfg.root, p.app.slug), "auth", "state.json");
      rt.bus.publish(
        "take.started",
        { version, message: `recording storyboard v${version}` },
        p.slug,
      );
      const take = await recordTake({
        projectDir: p.dir,
        storyboard: sb.storyboard,
        storyboardVersion: version,
        baseUrl: p.app.baseUrl,
        viewport: cfg.viewport,
        fps: cfg.fps,
        capture: cfg.capture,
        ...(params.headed ? { headed: true } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(fs.existsSync(statePath) ? { storageState: statePath } : {}),
        onEvent: (e) => {
          rt.bus.publish(
            "take.event",
            {
              type: e.type,
              t: e.t,
              ...(e.scene ? { scene: e.scene } : {}),
              ...(e.mark ? { mark: e.mark } : {}),
            },
            p.slug,
          );
          if (e.type === "scene-start")
            onUpdate?.({
              content: [{ type: "text", text: `recording scene ${e.scene} …` }],
              details: {},
            });
        },
      });
      const marks = take.events
        .filter((e) => e.mark)
        .map((e) => `  ${e.mark} @ ${(e.t / 1000).toFixed(2)}s (${e.scene})`);
      const latest = readStoryboard(p.dir);
      rt.bus.publish(
        "take.finished",
        {
          take: take.takeId,
          message: `${take.takeId} recorded (${(take.durationMs / 1000).toFixed(1)} s)`,
        },
        p.slug,
      );
      return result(
        [
          `Recorded ${take.takeId} of storyboard v${version}: ${(take.durationMs / 1000).toFixed(1)} s, ${take.capture.frames} frames (${take.capture.width}x${take.capture.height}).`,
          latest && latest.version !== version
            ? `Note: latest storyboard is v${latest.version}, but only v${version} is approved — recorded v${version}.`
            : "",
          `scenes: ${take.scenes.map((s) => `${s.id} ${(s.start / 1000).toFixed(1)}–${(s.end / 1000).toFixed(1)}s`).join(", ")}`,
          `marks:\n${marks.join("\n") || "  (none)"}`,
          `files: ${take.takeDir} (raw.mp4, events.jsonl, frames/)`,
          "Narration/voice-over and editing arrive in later slices.",
        ]
          .filter(Boolean)
          .join("\n"),
        { take: take.takeId, dir: take.takeDir },
      );
    },
  });
}
