/**
 * demo_rec_compare: the Director's side of "Compare two versions" (item 9b). context: the pair, the facts the engine counted, the
 * ids a point may cite and the rules. answer: the verdict, which the tool REFUSES unless it is honest in a checkable way
 * (see compare/verdict.ts). There is deliberately no way to use, approve or change a version from here.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CHOICES,
  LIMITS,
  VERDICTS,
  askedVerdict,
  recordVerdict,
  verdictBrief,
} from "../compare/verdict.ts";
import type { Runtime } from "../runtime.ts";
import { result } from "./common.ts";

export function registerCompareTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_compare",
    label: "Demo compare versions",
    description:
      "Compare two versions of the storyboard or the voice-over when the user asked for a verdict in the panel. context: the pair, the " +
      "facts the engine counted (do not recount), the evidence ids you may cite and the rules. answer: your verdict. BE HONEST, NOT KIND: say " +
      "plainly when the newer version is worse, when a change is not an improvement, when nothing meaningful changed. The tool refuses an answer " +
      "that cites evidence that is not in the facts, gives a better/worse verdict without a measured fact, leaves out `against` (the strongest " +
      "argument against your own recommendation) or recommends against its own verdict; it says why, so fix it and answer again. You cannot use, " +
      "approve or change any version: the user reads your verdict and decides. Stop after answer.",
    parameters: Type.Object({
      action: StringEnum(["context", "answer"] as const),
      verdict: Type.Optional(
        StringEnum(VERDICTS, {
          description: "answer: the newer version (b) compared with the older (a)",
        }),
      ),
      headline: Type.Optional(
        Type.String({
          description: `answer: the verdict in one sentence (at most ${LIMITS.headline} characters)`,
        }),
      ),
      points: Type.Optional(
        Type.Array(
          Type.Object({
            evidence: Type.String({
              description:
                "an id from the facts: fact:words, scene:02-search, section:01-dash, order",
            }),
            said: Type.String({ description: `what it shows, at most ${LIMITS.said} characters` }),
          }),
          {
            description: `answer: ${LIMITS.points[0]}-${LIMITS.points[1]} points, each citing a different piece of evidence`,
          },
        ),
      ),
      against: Type.Optional(
        Type.String({
          description: `answer: the strongest argument against your own recommendation (at most ${LIMITS.against} characters)`,
        }),
      ),
      recommendation: Type.Optional(
        Type.Object({
          choice: StringEnum(CHOICES, { description: "a = the older version, b = the newer one" }),
          why: Type.String({ description: `why, at most ${LIMITS.why} characters` }),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      if (params.action === "context") return result(verdictBrief(p.dir));
      const waiting = askedVerdict(p.dir);
      const v = recordVerdict(p.dir, {
        verdict: params.verdict,
        headline: params.headline,
        points: params.points,
        against: params.against,
        recommendation: params.recommendation,
      });
      rt.bus.publish(
        "compare.answered",
        {
          id: v.id,
          stage: v.stage,
          a: v.a,
          b: v.b,
          verdict: v.verdict,
          by: "agent",
          message: `verdict on ${v.stage === "vo" ? "voice-over" : "storyboard"} v${v.a} → v${v.b}: ${v.verdict} (recommends ${v.recommendation?.choice})`,
        },
        p.slug,
      );
      void waiting;
      return result(
        `Stored your verdict on v${v.a} → v${v.b}: ${v.verdict}. The user reads it in the Compare window and decides; you changed nothing. Stop here.`,
        { id: v.id },
      );
    },
  });
}
