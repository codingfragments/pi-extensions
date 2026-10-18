/**
 * demo_rec_qa — the Director's side of the fix loop (P1c Q3): read what the user flagged, and propose how to fix it.
 * There is deliberately NO accept or apply action: the user decides in the panel, and applying is a later, separate step.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  FIX_STAGES,
  FIX_STAGE_WORD,
  askedRound,
  directorBrief,
  listFixSets,
  recordProposals,
} from "../qa/fixes.ts";
import type { Runtime } from "../runtime.ts";
import { result } from "./common.ts";

export function registerQaTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_qa",
    label: "Demo QA fixes",
    description:
      "The fix loop of the QA (the user flags findings in the panel and asks you for suggested fixes). context: read what they flagged " +
      "as Fix (in full), their context for this round, the earlier rounds with their decisions and notes, and what they already " +
      "decided to leave alone. propose: answer with ONE proposal per stage (the earliest stage that needs a fix first), each saying " +
      "concretely what would change, why, which findings it answers and what applying it costs; every finding to fix is answered or " +
      "named under unresolved with a reason. You cannot apply or accept anything: the user reviews, may give more context and ask you " +
      "to rethink, and decides. Stop after propose.",
    parameters: Type.Object({
      action: StringEnum(["context", "propose"] as const),
      fixset: Type.Optional(
        Type.String({
          description: "the fix set, e.g. fs-1 (default: the one the user just asked about)",
        }),
      ),
      summary: Type.Optional(
        Type.String({
          description:
            "propose: your reasoning in a few sentences: the cause, the stage, the one run",
        }),
      ),
      proposals: Type.Optional(
        Type.Array(
          Type.Object({
            stage: StringEnum(FIX_STAGES, { description: "the stage whose version would change" }),
            title: Type.String({ description: "one line" }),
            change: Type.String({
              description:
                "what would change, concretely, in plain text (the sentences, marks, steps): all the changes for this stage",
            }),
            why: Type.String({ description: "why this fixes the findings it names" }),
            findings: Type.Array(Type.String(), {
              description: "the ids of the findings it answers",
            }),
            cost: Type.Optional(
              Type.String({
                description:
                  'what applying it costs, e.g. "nothing" or "re-synthesises 2 sections (~480 characters)"',
              }),
            ),
          }),
          { description: "propose: at most one per stage" },
        ),
      ),
      unresolved: Type.Optional(
        Type.Array(Type.Object({ finding: Type.String(), why: Type.String() }), {
          description: "propose: findings you cannot fix, with an honest reason",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      const waiting = listFixSets(p.dir).find(
        (s) =>
          s.status === "open" &&
          (askedRound(s) || (s.applying && !s.applying.version && !s.applying.kept)),
      );
      const id = params.fixset ?? waiting?.id;
      if (!id)
        throw new Error(
          "no fix set is waiting for you: the user has not asked for suggested fixes or for them to be applied",
        );
      if (params.action === "context") return result(directorBrief(p.dir, id));
      if (!params.summary?.trim() || !params.proposals)
        throw new Error(
          "propose needs a summary and proposals (and unresolved, when something cannot be fixed)",
        );
      const { set, round } = recordProposals(p.dir, id, {
        summary: params.summary,
        proposals: params.proposals,
        ...(params.unresolved ? { unresolved: params.unresolved } : {}),
      });
      const n = round.proposals?.length ?? 0;
      rt.bus.publish(
        "qa.proposed",
        {
          fixset: set.id,
          round: round.n,
          proposals: n,
          earliest: round.earliest ?? null,
          by: "agent",
          message: `fixes proposed for QA of render v${set.render}: ${n} proposal${n === 1 ? "" : "s"}${round.earliest ? `, earliest stage ${FIX_STAGE_WORD[round.earliest]}` : ""} (round ${round.n})`,
        },
        p.slug,
      );
      return result(
        `Stored ${n} proposal${n === 1 ? "" : "s"} for ${set.id}, round ${round.n}; the earliest stage is ${round.earliest ? FIX_STAGE_WORD[round.earliest] : "none"}. The user reviews them in the panel (Render, Fixes), may add context and ask you to rethink, and decides. Nothing is applied. Tell them in one line what you propose, then STOP and wait for their [demo-panel] message.`,
        { fixset: set.id, round: round.n },
      );
    },
  });
}
