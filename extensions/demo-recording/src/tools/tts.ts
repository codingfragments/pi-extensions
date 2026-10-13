/**
 * demo_rec_tts — synthesize the APPROVED voice-over (gate enforced here) as a
 * background job; `check` shows which engine/voice would be used, for free.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Job } from "../jobs.ts";
import type { Runtime } from "../runtime.ts";
import { buildEngines } from "../tts/factory.ts";
import { type VoiceManifest, readManifest, renderVoice, selectEngine } from "../tts/synthesize.ts";
import { readVo } from "../vo/store.ts";
import { readState, requireApproved } from "../workdir/state.ts";
import { result } from "./common.ts";

export function voiceSummary(m: VoiceManifest): string {
  const lines = [
    `Voice-over v${m.voVersion} synthesized with ${m.engine} (voice "${m.voice.name}"): ${m.totalSec.toFixed(1)} s total, ` +
      `${m.billedChars} characters billed (${Object.values(m.sections).filter((s) => s.cached).length}/${Object.keys(m.sections).length} sections from cache).`,
  ];
  if (m.skipped.length)
    lines.push(`skipped engines: ${m.skipped.map((s) => `${s.engine} (${s.reason})`).join("; ")}`);
  for (const s of Object.values(m.sections)) {
    const anchors = Object.entries(s.alignment.anchors).map(([k, t]) => `@${k} +${t.toFixed(2)}s`);
    lines.push(
      `- ${s.key}: ${s.durationSec.toFixed(1)} s${anchors.length ? ` (${anchors.join(", ")})` : ""}${s.cached ? " · cached" : ""}`,
    );
  }
  lines.push("Next: the sync edit (demo_rec_edit) bends the take to this narration.");
  return lines.join("\n");
}

export function registerTtsTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_tts",
    label: "Demo voice synthesis",
    description:
      "Voice for the APPROVED voice-over. check: which engine and voice the chain would use (ElevenLabs custom voice by name → OpenAI → Kokoro), " +
      "no cost. start: synthesize every section in the background (one engine for the whole video, cached by content, word timings + anchor times " +
      "per section); you get a [demo-recording] message when done. status/cancel manage the job. Refuses unless the user approved a voice-over in the panel.",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["check", "start", "status", "cancel"] as const, {
          description: "default start",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const action = params.action ?? "start";
      if (action === "status") {
        const j = rt.jobs.latest("tts");
        return result(
          j
            ? `${j.id}: ${j.status}${j.error ? ` — ${j.error}` : ""}`
            : "no voice job in this session",
        );
      }
      if (action === "cancel") {
        const j = rt.jobs.running("tts");
        if (j) j.controller.abort();
        return result(j ? `cancelling ${j.id}` : "no voice job running");
      }
      const p = rt.requireProject();
      const cfg = rt.getConfig(true);
      const brief = fs.existsSync(path.join(p.dir, "brief.md"))
        ? fs.readFileSync(path.join(p.dir, "brief.md"), "utf8")
        : "";
      const engines = buildEngines(cfg, { brief });
      if (action === "check") {
        const lines: string[] = [];
        for (const e of engines) {
          const h = await e.health(signal);
          lines.push(`${h.ok ? "✔" : "✖"} ${e.id}: ${h.reason}`);
        }
        const pick = await selectEngine(engines, signal).catch(() => undefined);
        lines.push(
          pick ? `→ would use ${pick.engine.id} (${pick.health.reason})` : "→ no engine available",
        );
        return result(lines.join("\n"));
      }

      const state = readState(p.dir) ?? p.state;
      const version = requireApproved(state, "vo");
      const vo = readVo(p.dir, version);
      if (!vo) throw new Error(`approved voice-over v${version} is missing on disk`);
      const job = rt.jobs.start<VoiceManifest>(
        "tts",
        p.slug,
        (jobSignal) =>
          renderVoice({
            projectDir: p.dir,
            voVersion: version,
            take: vo.validated.script.take,
            sections: vo.validated.resolved,
            engines,
            alignModel: cfg.align.model,
            signal: jobSignal,
            onProgress: (pr) =>
              rt.bus.publish(
                "tts.progress",
                {
                  ...pr,
                  message: `🎙 voice ${pr.done}/${pr.total} · ${pr.section} · ${pr.engine}${pr.cached ? " (cached)" : ""}`,
                },
                p.slug,
              ),
          }),
        (j: Job<VoiceManifest>) => {
          rt.bus.publish(
            "tts.finished",
            {
              job: j.id,
              status: j.status,
              message: j.result
                ? `voice ready (${j.result.engine})`
                : `voice ${j.status}: ${j.error}`,
            },
            p.slug,
          );
          rt.setStatus(undefined, true);
          if (j.result) rt.reportToAgent(`[demo-recording] ${voiceSummary(j.result)}`);
          else
            rt.reportToAgent(
              `[demo-recording] Voice synthesis ${j.status}: ${j.error ?? "unknown error"}`,
            );
        },
      );
      const existing = readManifest(p.dir, version);
      return result(
        `Voice synthesis started (${job.id}) for voice-over v${version}${existing ? " (re-render: unchanged sections come from the cache)" : ""}. Progress is in the panel and the footer; you'll get a [demo-recording] message when it's done — don't poll.`,
        { job: job.id },
      );
    },
  });
}
