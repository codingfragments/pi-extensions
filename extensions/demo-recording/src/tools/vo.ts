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
import { projectBudget, titleCardMs } from "../budget/project.ts";
import { voLength } from "../budget/vo.ts";
import { measuredWordsPerSecond } from "../budget/voice-rate.ts";
import { formatConfidence } from "../confidence/level.ts";
import { voConfidence } from "../confidence/vo.ts";
import { pendingBlock, pendingReminder } from "../qa/apply.ts";
import { askAboutVoLength } from "../question-flow.ts";
import type { Runtime } from "../runtime.ts";
import { formatIssues } from "../vo/script.ts";
import { readPendingDirection, readVo, readVoMeta, voVersions, writeVo } from "../vo/store.ts";
import { acceptedVersions } from "../workdir/stages.ts";
import { acceptedTakeId, getReview, readState } from "../workdir/state.ts";
import { result } from "./common.ts";
import { defaultTake } from "./take.ts";

export function voTemplate(
  a: TakeAnalysis,
  /** Words per second of footage: this project's measured voice when it is known (item 22), else about 2.4 (a little under 155 wpm, room for pauses). */
  wordsPerSecond = 2.4,
): string {
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
      `<!-- ~${usable.toFixed(1)}s usable footage → ~${Math.round(usable * wordsPerSecond)} words fit the footage, up to ~${Math.round(usable * wordsPerSecond * 2)} to explain (the edit holds frames). Say what it means, not what it shows. Marks: ${s.marks.map((m) => `[@${m.mark}] ${(m.t / 1000).toFixed(1)}s`).join(", ") || "none"} -->`,
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
      base: Type.Optional(
        Type.Number({
          description:
            "write: the version you rewrote (the panel diffs against it). A panel direction sets it automatically.",
        }),
      ),
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
          params.take ?? acceptedTakeId(state) ?? defaultTake(p.dir, state.line.storyboard)?.id;
        if (!take) throw new Error("no complete take yet");
        const analysis = readAnalysis(path.join(p.dir, "takes", take));
        if (!analysis)
          throw new Error(`${take} has not been analyzed — run demo_rec_take analyze first`);
        const rate = measuredWordsPerSecond(p.dir);
        return result(
          [
            voTemplate(analysis, rate ? rate.wordsPerSecond * 0.93 : undefined),
            ...(rate
              ? [
                  `<!-- word budgets use this project's voice, measured at ${Math.round(rate.wordsPerSecond * 60)} wpm over ${Math.round(rate.seconds)} s of speech -->`,
                ]
              : []),
            ...pendingBlock(p.dir, "vo"),
          ].join("\n"),
        );
      }
      if (params.action === "get") {
        const vo = readVo(p.dir, params.version);
        if (!vo) return result("no voice-over written yet");
        const review = getReview(state, vo.version, "vo");
        const marks = Object.entries(review.scenes).map(
          ([k, r]) => `${k}: ${r.status}${r.note ? ` — "${r.note}"` : ""}`,
        );
        const conf = voConfidence(p.dir, vo.version);
        const pending = readPendingDirection(p.dir);
        return result(
          `${pending ? `PENDING DIRECTION from the panel (rewrite v${pending.base} as a new version): ${JSON.stringify(pending.direction)}\n` : ""}${conf ? `${formatConfidence(conf, "section")}\n` : ""}voice-over v${vo.version} (versions: ${voVersions(p.dir).join(", ")}; accepted: ${acceptedVersions(state.accepted, "vo").join(", ") || "none"}; working line: ${state.line.vo ?? "none"})\n` +
            `${formatIssues(vo.validated)}\n${marks.length ? `review:\n${marks.join("\n")}\n` : ""}${pendingBlock(p.dir, "vo").join("\n")}---\n${vo.text}`,
        );
      }
      if (!params.markdown?.trim()) throw new Error("write needs markdown (the complete script)");
      const stored = writeVo(
        p.dir,
        params.markdown,
        params.base !== undefined ? { base: params.base } : {},
      );
      const meta = readVoMeta(p.dir, stored.version);
      // the script against the length budget (item 22 PR 2): within the window the edit stretches; past the ceiling the user decides
      const cfgNow = rt.getConfig();
      const budget = projectBudget(p.dir, cfgNow);
      const rateNow = measuredWordsPerSecond(p.dir);
      const vLen = budget
        ? voLength(stored.validated, budget, {
            titleMs: titleCardMs(cfgNow),
            ...(rateNow ? { wordsPerSecond: rateNow.wordsPerSecond } : {}),
          })
        : undefined;
      if (vLen?.verdict === "long" && budget)
        askAboutVoLength(rt, stored.version, vLen, budget.ceilingSec);
      const conf = voConfidence(p.dir, stored.version);
      rt.bus.publish(
        "vo.written",
        {
          version: stored.version,
          by: "agent",
          take: stored.validated.script.take,
          sections: stored.validated.script.sections.length,
          issues: stored.validated.issues,
          message: `voice-over v${stored.version} written · ${stored.validated.script.sections.length} section(s)${stored.validated.issues.length ? ` · ${stored.validated.issues.filter((i) => i.level === "error").length} error(s), ${stored.validated.issues.filter((i) => i.level === "warning").length} warning(s)` : ""}`,
        },
        p.slug,
      );
      const panel = await rt.ensurePanel();
      return result(
        [
          `Stored voice-over v${stored.version} for ${stored.validated.script.take} at ${stored.file}.`,
          formatIssues(stored.validated) || "No issues.",
          ...(vLen
            ? [
                `Length: ${vLen.words}.${vLen.verdict === "long" ? " Past the ceiling: the user is asked (raise the ceiling, or cut). Do not rewrite it until they answer." : ""}`,
              ]
            : []),
          ...(meta?.base !== undefined
            ? [
                `Based on v${meta.base}${meta.direction ? " (the user's direction)" : ""} — the panel shows the word diff.`,
              ]
            : []),
          ...(conf ? [formatConfidence(conf, "section")] : []),
          ...(stored.validated.script.take !== acceptedTakeId(readState(p.dir) ?? state)
            ? [
                `⚠ ${stored.validated.script.take} is not the accepted recording (${acceptedTakeId(readState(p.dir) ?? state) ?? "none accepted"}): this voice-over can only be approved after the user approves recording ${stored.validated.script.take} in the panel (the stage chain: storyboard → recording → voice-over).`,
              ]
            : []),
          `The user reviews it in the panel (Voice tab): ${panel.url}. Wait for their [demo-panel] feedback; voice synthesis needs their approval.`,
        ].join("\n") + pendingReminder(p.dir, "vo", stored.version),
        { version: stored.version },
      );
    },
  });
}
