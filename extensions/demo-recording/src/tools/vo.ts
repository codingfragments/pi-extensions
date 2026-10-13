/**
 * demo_rec_vo — write (validate + version + push to the panel's Voice tab),
 * get, and template the voice-over script. There is deliberately NO approve
 * action: VO approval is a human gate in the panel (it unlocks paid TTS).
 */

import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type TakeAnalysis, readAnalysis } from "../analysis/take.ts";
import type { Runtime } from "../runtime.ts";
import { formatIssues } from "../vo/script.ts";
import { readVo, voVersions, writeVo } from "../vo/store.ts";
import { getReview, readState } from "../workdir/state.ts";
import { result } from "./common.ts";
import { defaultTake } from "./take.ts";

export function voTemplate(a: TakeAnalysis): string {
  const lines = [
    "---",
    `take: ${a.take}`,
    "---",
    "",
    "## _intro",
    "<!-- full video only: 1–2 sentences, the hook from the brief -->",
    "",
  ];
  a.scenes.forEach((s, i) => {
    const dead = s.idle.reduce((n, r) => n + r.end - r.start, 0);
    const usable = (s.end - s.start - dead) / 1000;
    if (i > 0)
      lines.push(
        `## _bridge:${s.id}`,
        "<!-- optional, full video only: one short transition sentence -->",
        "",
      );
    lines.push(
      `## ${s.id} — ${s.title}`,
      `<!-- ~${usable.toFixed(1)}s usable footage → ~${Math.round(usable * 2.4)} words max. Marks: ${s.marks.map((m) => `[@${m.mark}] ${(m.t / 1000).toFixed(1)}s`).join(", ") || "none"} -->`,
      "",
    );
  });
  lines.push("## _outro", "<!-- full video only: the key message, one or two sentences -->", "");
  return lines.join("\n");
}

export function registerVoTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_vo",
    label: "Demo voice-over",
    description:
      "Voice-over script (markdown; see the demo-voiceover skill). template: a skeleton for the take with each scene's marks and word budget. " +
      "write: validate against the take (scenes, [@mark] anchors in order, {{dom:mark|regex}} bindings, speech vs footage time), store the next " +
      "immutable version, and show it in the panel's Voice tab — errors name the exact section to fix. get: a version with its review. " +
      "The user approves the voice-over in the panel; you cannot.",
    parameters: Type.Object({
      action: StringEnum(["template", "write", "get"] as const),
      markdown: Type.Optional(
        Type.String({ description: "write: the complete script incl. front matter" }),
      ),
      version: Type.Optional(Type.Number({ description: "get: version (default latest)" })),
      take: Type.Optional(
        Type.String({ description: "template: take id (default: accepted, else latest complete)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      const state = readState(p.dir) ?? p.state;
      if (params.action === "template") {
        const take =
          params.take ?? state.acceptedTake ?? defaultTake(p.dir, state.approved.storyboard)?.id;
        if (!take) throw new Error("no complete take yet");
        const analysis = readAnalysis(path.join(p.dir, "takes", take));
        if (!analysis)
          throw new Error(`${take} has not been analyzed — run demo_rec_take analyze first`);
        return result(voTemplate(analysis));
      }
      if (params.action === "get") {
        const vo = readVo(p.dir, params.version);
        if (!vo) return result("no voice-over written yet");
        const review = getReview(state, vo.version, "vo");
        const marks = Object.entries(review.scenes).map(
          ([k, r]) => `${k}: ${r.status}${r.note ? ` — "${r.note}"` : ""}`,
        );
        return result(
          `voice-over v${vo.version} (versions: ${voVersions(p.dir).join(", ")}; approved: ${state.approved.vo ?? "none"})\n` +
            `${formatIssues(vo.validated)}\n${marks.length ? `review:\n${marks.join("\n")}\n` : ""}---\n${vo.text}`,
        );
      }
      if (!params.markdown?.trim()) throw new Error("write needs markdown (the complete script)");
      const stored = writeVo(p.dir, params.markdown);
      rt.bus.publish(
        "vo.written",
        { version: stored.version, message: `voice-over v${stored.version} written`, by: "agent" },
        p.slug,
      );
      const panel = await rt.ensurePanel();
      return result(
        [
          `Stored voice-over v${stored.version} for ${stored.validated.script.take} at ${stored.file}.`,
          formatIssues(stored.validated) || "No issues.",
          `The user reviews it in the panel (Voice tab): ${panel.url}. Wait for their [demo-panel] feedback; voice synthesis needs their approval.`,
        ].join("\n"),
        { version: stored.version },
      );
    },
  });
}
