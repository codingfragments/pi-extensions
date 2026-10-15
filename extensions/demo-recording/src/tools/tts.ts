/**
 * demo_rec_tts — synthesize the APPROVED voice-over (gate enforced here) as a
 * background job; `check` shows which engine/voice would be used, for free.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatFits } from "../edit/fit.ts";
import { voiceFit } from "../edit/pipeline.ts";
import type { Job } from "../jobs.ts";
import type { Runtime } from "../runtime.ts";
import { listElevenLabsVoices, sortVoices } from "../tts/engines.ts";
import { briefVoice, buildEngines } from "../tts/factory.ts";
import { type VoiceManifest, readManifest, renderVoice, selectEngine } from "../tts/synthesize.ts";
import { firstLine, jobFacts } from "../util/events.ts";
import { readVo } from "../vo/store.ts";
import { readState, requireSelected } from "../workdir/state.ts";
import { result } from "./common.ts";

export function voiceSummary(m: VoiceManifest): string {
  const lines = [
    `Voice-over v${m.voVersion} synthesized with ${m.engine}${m.models?.length ? ` / ${m.models.join(", ")}` : ""} (voice "${m.voice.name}"): ${m.totalSec.toFixed(1)} s total, ` +
      `${m.billedChars} characters synthesized${m.engine === "elevenlabs" || m.engine === "openai" ? " (billed)" : " (local, no cost)"} (${Object.values(m.sections).filter((s) => s.cached).length}/${Object.keys(m.sections).length} sections from cache).`,
  ];
  for (const f of m.modelFallbacks ?? [])
    lines.push(`⚠ ${f.section}: fell back from ${f.from} to ${f.to} (${f.reason})`);
  if ((m.models?.length ?? 0) > 1)
    lines.push(
      `⚠ mixed models in one video: ${m.models.join(", ")} — re-render to make them consistent`,
    );
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
      "Voice for the APPROVED voice-over. voices: list every ElevenLabs voice in the account (name, id, category; yours first). " +
      "check: which engine and voice the chain would use (ElevenLabs custom voice by name → OpenAI → Kokoro), " +
      "no cost. start: synthesize every section in the background (one engine for the whole video, cached by content, word timings + anchor times " +
      "per section); you get a [demo-recording] message when done. status/cancel manage the job. Refuses unless the user approved a voice-over in the panel.",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["check", "voices", "start", "status", "cancel"] as const, {
          description: "default start",
        }),
      ),
      version: Type.Optional(
        Type.Number({
          description: "start: voice-over version (default: the working line's; must be accepted)",
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
      // voices/check work without a project (brief voice applies when one is active)
      const active = rt.activeProject();
      const cfg = rt.getConfig(true);
      const brief =
        active && fs.existsSync(path.join(active.dir, "brief.md"))
          ? fs.readFileSync(path.join(active.dir, "brief.md"), "utf8")
          : "";
      const engines = buildEngines(cfg, { brief });
      if (action === "voices") {
        const all = sortVoices(
          await listElevenLabsVoices({
            ...(process.env.ELEVENLABS_API_KEY?.trim()
              ? { apiKey: process.env.ELEVENLABS_API_KEY.trim() }
              : {}),
            ...(signal ? { signal } : {}),
          }),
        );
        const current = (briefVoice(brief) ?? cfg.voiceName).trim().toLowerCase();
        const lines = all.map((v) => {
          const on =
            current &&
            (v.name.toLowerCase() === current ||
              v.voice_id === current ||
              v.name.toLowerCase().startsWith(current));
          return `${on ? "▶" : " "} ${v.name}  (${v.category ?? "?"}, id ${v.voice_id})`;
        });
        return result(
          `${all.length} ElevenLabs voices (yours first). Current: ${briefVoice(brief) ? `brief → "${briefVoice(brief)}"` : cfg.voiceName ? `config → "${cfg.voiceName}"` : "none set"}\n` +
            `${lines.join("\n")}\n\nTo pick one: demo_rec_config set voiceName "<name>" (global or project scope), or the brief's Voice field; or run /demo voices.`,
        );
      }
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

      const p = rt.requireProject();
      const state = readState(p.dir) ?? p.state;
      const version = requireSelected(p.dir, state, "vo", params.version);
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
              ...jobFacts(j),
              voVersion: version,
              message: j.result
                ? `voice ready · ${j.result.engine} “${j.result.voice.name}” · ${j.result.totalSec.toFixed(1)} s · ${Object.keys(j.result.sections).length} section(s)`
                : `voice ${j.status}: ${firstLine(j.error ?? "")}`,
              ...(j.result
                ? {
                    engine: j.result.engine,
                    voice: j.result.voice,
                    models: j.result.models,
                    totalSec: j.result.totalSec,
                    billedChars: j.result.billedChars,
                    sections: Object.values(j.result.sections).map((s) => ({
                      key: s.key,
                      sec: +s.durationSec.toFixed(2),
                      cached: s.cached,
                      chars: s.chars,
                    })),
                    ...(j.result.skipped.length ? { skipped: j.result.skipped } : {}),
                    ...(j.result.modelFallbacks.length
                      ? { modelFallbacks: j.result.modelFallbacks }
                      : {}),
                  }
                : {}),
            },
            p.slug,
          );
          rt.setStatus(undefined, true);
          if (j.result) {
            const fits = voiceFit(p.dir, version, cfg);
            const warn = fits?.filter((f) => f.level === "warn") ?? [];
            rt.reportToAgent(
              `[demo-recording] ${voiceSummary(j.result)}${fits ? `\n\nFit of the real voice to the footage:\n${formatFits(fits)}` : ""}` +
                `${warn.length ? `\n${warn.length} scene(s) need attention before rendering — shorten those sections (new VO version) or accept.` : ""}`,
            );
          } else
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
