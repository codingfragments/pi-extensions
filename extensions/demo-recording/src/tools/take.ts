/**
 * demo_rec_take — list takes, analyze one for the voice-over (keyframes +
 * marks + page text + dead time + motion), and accept it as the take the VO
 * is written for.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeTake, formatAnalysis, readAnalysis } from "../analysis/take.ts";
import { visionWarning } from "../models.ts";
import type { Runtime } from "../runtime.ts";
import { acceptTake, acceptedTakeId, readState } from "../workdir/state.ts";
import { type ToolContent, result, text } from "./common.ts";

export interface TakeInfo {
  id: string;
  status: string;
  storyboardVersion: number;
  durationMs?: number;
  startedAt?: string;
}

export function listTakes(projectDir: string): TakeInfo[] {
  const dir = path.join(projectDir, "takes");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => /^take-\d+$/.test(d) && fs.existsSync(path.join(dir, d, "take.json")))
    .sort()
    .map((id) => {
      const m = JSON.parse(fs.readFileSync(path.join(dir, id, "take.json"), "utf8"));
      return {
        id,
        status: m.status,
        storyboardVersion: m.storyboardVersion,
        durationMs: m.durationMs,
        startedAt: m.startedAt,
      };
    });
}

/** Latest complete take of the approved storyboard (or of any version). */
export function defaultTake(projectDir: string, approvedVersion?: number): TakeInfo | undefined {
  const ok = listTakes(projectDir).filter((t) => t.status === "ok");
  return ok.filter((t) => t.storyboardVersion === approvedVersion).at(-1) ?? ok.at(-1);
}

const MAX_IMAGES = 12;

export function registerTakeTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_take",
    label: "Demo take analysis",
    description:
      "Recorded takes. list: all takes with status. analyze: everything needed to write the voice-over FROM THE ACTUAL RUN — per scene: " +
      "timing, marks with timestamps, the exact page text at each mark (quote values from here), typed/improvised inputs, error toasts, dead time " +
      "(cut by the editor), streaming content and on-screen motion, plus keyframe images. accept: mark the take the voice-over is written for. " +
      "Default take: the latest complete take of the approved storyboard.",
    parameters: Type.Object({
      action: StringEnum(["list", "analyze", "accept"] as const),
      take: Type.Optional(
        Type.String({
          description:
            "take id, e.g. take-003 (default: latest complete take of the approved storyboard)",
        }),
      ),
      images: Type.Optional(
        Type.Boolean({ description: "analyze: attach keyframes at marks (default true)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      const state = readState(p.dir) ?? p.state;
      if (params.action === "list") {
        const takes = listTakes(p.dir);
        if (!takes.length) return result("no takes yet");
        return result(
          takes
            .map(
              (t) =>
                `${t.id}: ${t.status}, storyboard v${t.storyboardVersion}${t.durationMs ? `, ${(t.durationMs / 1000).toFixed(1)} s` : ""}` +
                `${t.id === acceptedTakeId(state) ? " (accepted)" : ""}`,
            )
            .join("\n"),
        );
      }
      const take = params.take ?? defaultTake(p.dir, state.line.storyboard)?.id;
      if (!take) throw new Error("no complete take yet — record one with demo_rec_record");
      const takeDir = path.join(p.dir, "takes", take);
      if (!fs.existsSync(path.join(takeDir, "take.json")))
        throw new Error(`unknown take "${take}"`);

      if (params.action === "accept") {
        const info = listTakes(p.dir).find((t) => t.id === take);
        if (info?.status !== "ok")
          throw new Error(`${take} is not complete (status ${info?.status})`);
        acceptTake(p.dir, take);
        rt.bus.publish(
          "take.accepted",
          { take, by: "agent", message: `${take} accepted for the voice-over` },
          p.slug,
        );
        return result(
          `${take} accepted. Next: analyze it (if not done) and write the voice-over with demo_rec_vo.`,
        );
      }

      rt.bus.publish("take.analyzing", { take, message: `analyzing ${take}` }, p.slug);
      const analysis = readAnalysis(takeDir) ?? (await analyzeTake(takeDir));
      rt.bus.publish(
        "take.analyzed",
        {
          take,
          message: `${take} analyzed · ${analysis.scenes.length} scene(s)${analysis.scenes.some((s) => s.alerts.length) ? ` · ${analysis.scenes.reduce((n, s) => n + s.alerts.length, 0)} toast(s)` : ""}`,
          scenes: analysis.scenes.map((s) => ({
            id: s.id,
            ms: s.end - s.start,
            marks: s.marks.map((m) => m.mark),
            alerts: s.alerts.map((a) => `${a.level}: ${a.text}`),
            idleMs: s.idle.reduce((n, r) => n + r.end - r.start, 0),
            improvised: s.typed.filter((t) => t.improvised).map((t) => t.text),
          })),
        },
        p.slug,
      );
      const vision = visionWarning(ctx?.model);
      if (vision) rt.bus.publish("model.warning", { message: vision }, p.slug);
      const content: ToolContent[] = [
        text(`${vision ? `${vision}\n\n` : ""}${formatAnalysis(analysis)}`),
      ];
      if (params.images !== false) {
        const shots = analysis.scenes.flatMap((s) =>
          s.keyframes.filter((k) => k.label !== "end").map((k) => ({ ...k, scene: s.id })),
        );
        // Prefer marks, then scene starts, then alerts — capped for context size.
        const ranked = [
          ...shots.filter((k) => k.label !== "start" && k.label !== "alert"),
          ...shots.filter((k) => k.label === "alert"),
          ...shots.filter((k) => k.label === "start"),
        ]
          .slice(0, MAX_IMAGES)
          .sort((a, b) => a.t - b.t);
        for (const k of ranked) {
          if (!fs.existsSync(k.file)) continue;
          content.push(text(`keyframe ${k.scene} @${k.label} ${(k.t / 1000).toFixed(2)}s`));
          content.push({
            type: "image",
            data: fs.readFileSync(k.file).toString("base64"),
            mimeType: "image/jpeg",
          });
        }
      }
      return result(content, { take, scenes: analysis.scenes.length });
    },
  });
}
