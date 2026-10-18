/**
 * demo_rec_qa — the Director's side of the fix loop (P1c Q3): read what the user flagged, and propose how to fix it.
 * There is deliberately NO accept or apply action: the user decides in the panel, and applying is a later, separate step.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatPending, resolvePending } from "../qa/apply.ts";
import {
  FIX_STAGES,
  FIX_STAGE_WORD,
  LIMITS,
  askedRound,
  directorBrief,
  listFixSets,
  proposeReply,
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
      "named under unresolved with a reason. Be STRUCTURED, never a wall of text: a short summary, bullets for the changes, and nextSteps (2-7 " +
      "short steps from the fix to a NEW RENDER, with the cost of each). Say which stage you address. You cannot apply or accept anything: the " +
      "user reviews, may give more context and ask you to rethink, and decides. Stop after propose. pending: the fixes the user accepted for later " +
      "stages and that are still open. resolve: settle one pending fix when you wrote the draft of its stage: applied (with the version that " +
      "carries it and how) or dropped (with why it no longer applies); the user sees what you did and can drop any of them.",
    parameters: Type.Object({
      action: StringEnum(["context", "propose", "pending", "resolve"] as const),
      pendingId: Type.Optional(Type.String({ description: "resolve: the pending fix, e.g. pf-1" })),
      status: Type.Optional(
        StringEnum(["applied", "dropped"] as const, {
          description:
            "resolve: applied (this draft carries it) or dropped (it does not apply any more)",
        }),
      ),
      why: Type.Optional(
        Type.String({
          description: "resolve: one sentence: how it was applied, or why it is dropped",
        }),
      ),
      version: Type.Optional(
        Type.Number({ description: "resolve applied: the version of its stage that carries it" }),
      ),
      fixset: Type.Optional(
        Type.String({
          description: "the fix set, e.g. fs-1 (default: the one the user just asked about)",
        }),
      ),
      summary: Type.Optional(
        Type.String({
          description: `propose: the cause and the one run, one or two sentences (at most ${LIMITS.summary} characters)`,
        }),
      ),
      nextSteps: Type.Optional(
        Type.Array(Type.String(), {
          description: `propose: ${LIMITS.steps[0]}-${LIMITS.steps[1]} short steps (at most ${LIMITS.step} characters each) from the fix to a new render, in order: what the user does, what asks for their Allow and what it costs, what happens by itself`,
        }),
      ),
      proposals: Type.Optional(
        Type.Array(
          Type.Object({
            stage: StringEnum(FIX_STAGES, { description: "the stage whose version would change" }),
            title: Type.String({ description: `one line, at most ${LIMITS.title} characters` }),
            change: Type.String({
              description:
                "all the changes for this stage as bullet lines, one per edit, each concrete (old text → new text; the marks, the steps)",
            }),
            why: Type.String({
              description: `why this fixes the findings it names, one or two sentences (at most ${LIMITS.why} characters)`,
            }),
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
      if (params.action === "pending") {
        const lines = formatPending(p.dir);
        return result(lines.length ? lines.join("\n") : "No pending fixes.");
      }
      if (params.action === "resolve") {
        if (!params.pendingId || !params.status)
          throw new Error("resolve needs pendingId and status (applied or dropped), and why");
        const pf = resolvePending(p.dir, params.pendingId, {
          status: params.status,
          by: "agent",
          ...(params.why ? { why: params.why } : {}),
          ...(params.version !== undefined ? { version: params.version } : {}),
        });
        rt.bus.publish(
          "qa.pending",
          {
            id: pf.id,
            stage: pf.stage,
            status: pf.status,
            by: "agent",
            message: `pending fix ${pf.id} (${FIX_STAGE_WORD[pf.stage]}) ${pf.status}${pf.version ? ` in v${pf.version}` : ""}: ${pf.resolvedWhy}`,
          },
          p.slug,
        );
        return result(
          `${pf.id} is ${pf.status}${pf.version ? ` (v${pf.version})` : ""}: ${pf.resolvedWhy}`,
        );
      }
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
          "propose needs a summary, proposals and nextSteps (and unresolved, when something cannot be fixed)",
        );
      const { set, round } = recordProposals(p.dir, id, {
        summary: params.summary,
        nextSteps: params.nextSteps ?? [],
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
        `Stored ${n} proposal${n === 1 ? "" : "s"} for ${set.id}, round ${round.n}; the earliest stage is ${round.earliest ? FIX_STAGE_WORD[round.earliest] : "none"}. The user reviews them in the panel (Render, Fixes), may add context and ask you to rethink, and decides. Nothing is applied.\n\nYour reply to the user is this structured text (tighten it if you like, keep the shape, at most 12 lines), then STOP and wait for their [demo-panel] message:\n\n${proposeReply(set, round)}`,
        { fixset: set.id, round: round.n },
      );
    },
  });
}
