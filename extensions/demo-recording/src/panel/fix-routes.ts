/**
 * The fix loop over HTTP (P1c Q3): flag findings, ask the Director for suggested fixes, decide on its proposals, ask it to rethink.
 * Nothing here applies a fix.
 *
 *   GET  /api/qa-fixes?version=N     the render's open fix set (rounds, proposals, your draft) and what can be flagged
 *   POST /api/qa-fix-flag            save what you flagged and wrote (no ask yet)
 *   POST /api/qa-fix-ask             ask the Director (starts a Director turn): the first round, or a rethink with more context
 *   POST /api/qa-fix-decide          accept, reject or edit one proposal, with a note
 *   POST /api/qa-fix-cancel          give up on an ask the Director has not answered
 *   GET  /api/qa-pending?stage=      the pending fixes (open first, then what was settled), for one stage or all
 *   POST /api/qa-pending-drop        drop a pending fix, with an optional reason (the Director settles the others itself)
 */

import {
  applyFixSet,
  applyMessage,
  listPending,
  openPending,
  resolvePending,
} from "../qa/apply.ts";
import {
  FIX_STAGE_WORD,
  type Flag,
  askRound,
  askedRound,
  decideProposal,
  failRound,
  flaggable,
  listFixSets,
  openFixSet,
  readFixSet,
  saveDraft,
} from "../qa/fixes.ts";
import type { Runtime } from "../runtime.ts";
import { PANEL_PREFIX } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

const flagsOf = (v: unknown): Flag[] =>
  Array.isArray(v)
    ? v.map((f) => ({ id: String((f as Flag).id), choice: (f as Flag).choice }))
    : [];

/** What the Director is told when you ask: where to read, and the rule of one run at the earliest stage. */
export function askMessage(setId: string, render: number, round: number, fix: number): string {
  return `${PANEL_PREFIX} The user flagged ${fix} QA finding${fix === 1 ? "" : "s"} of render v${render} to fix and asks for suggested fixes (fix set ${setId}, round ${round}${round > 1 ? ": they added context and ask you to rethink, so read the earlier rounds and their decisions" : ""}). Call demo_rec_qa context, think about the cause of each finding, then call demo_rec_qa propose with ONE proposal per stage: the earliest stage that needs a fix first, fixing as many of the findings as possible in that one run. Do not apply anything; stop after propose.`;
}

export function fixRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const project = () => rt.requireProject();
  return {
    get: {
      "qa-pending": (q) => {
        const p = project();
        const stage = q.get("stage");
        const all = listPending(p.dir).filter((x) => !stage || x.stage === stage);
        return {
          open: all.filter((x) => x.status === "open"),
          settled: all.filter((x) => x.status !== "open").slice(-5),
        };
      },
      "qa-fixes": (q) => {
        const p = project();
        const render = Number(q.get("version"));
        if (!Number.isInteger(render) || render < 1) throw new Error('"version" is required');
        // the open fix set of this render, else the one that was applied last (so what you did stays readable)
        const sets = listFixSets(p.dir).filter((s) => s.render === render);
        const set =
          sets.find((s) => s.status === "open") ??
          sets.filter((s) => s.status === "applied").at(-1);
        return {
          fixset: set ?? null,
          pending: set ? openPending(p.dir).filter((x) => x.fixset === set.id) : [],
          flaggable: flaggable(p.dir, render).map((i) => i.id),
          stageWords: FIX_STAGE_WORD,
        };
      },
    },
    post: {
      "qa-pending-drop": (body) => {
        const p = project();
        const pf = resolvePending(p.dir, String(body.id), {
          status: "dropped",
          by: "user",
          ...(body.why ? { why: String(body.why) } : {}),
        });
        rt.bus.publish(
          "qa.pending",
          {
            id: pf.id,
            stage: pf.stage,
            status: pf.status,
            by: "user",
            message: `pending fix ${pf.id} (${FIX_STAGE_WORD[pf.stage]}) dropped: ${pf.resolvedWhy}`,
          },
          p.slug,
        );
        return { pending: pf };
      },
      "qa-fix-flag": (body) => {
        const p = project();
        const set = saveDraft(p.dir, Number(body.version), {
          flags: flagsOf(body.flags),
          guidance: String(body.guidance ?? ""),
        });
        return { fixset: set };
      },
      "qa-fix-ask": (body) => {
        const p = project();
        const render = Number(body.version);
        const draft = { flags: flagsOf(body.flags), guidance: String(body.guidance ?? "") };
        const { set, round } = askRound(p.dir, render, draft);
        const fix = round.flags.filter((f) => f.choice === "fix").length;
        rt.bus.publish(
          "qa.asked",
          {
            fixset: set.id,
            round: round.n,
            flagged: fix,
            by: "panel",
            message: `asked the Director for suggested fixes (${set.id}, round ${round.n}, ${fix} finding${fix === 1 ? "" : "s"})`,
          },
          p.slug,
        );
        rt.notifyAgent(askMessage(set.id, render, round.n, fix));
        return { fixset: set, round };
      },
      "qa-fix-decide": (body) => {
        const p = project();
        const { set, proposal } = decideProposal(
          p.dir,
          String(body.fixset ?? ""),
          String(body.proposal ?? ""),
          {
            ...(body.decision !== undefined ? { decision: body.decision as never } : {}),
            ...(body.edited !== undefined ? { edited: String(body.edited) } : {}),
            ...(body.note !== undefined ? { note: String(body.note) } : {}),
          },
        );
        rt.bus.publish(
          "qa.decided",
          {
            fixset: set.id,
            proposal: proposal.id,
            decision: proposal.decision,
            by: "panel",
            message: `${proposal.decision} the ${FIX_STAGE_WORD[proposal.stage]} proposal "${proposal.title}"`,
          },
          p.slug,
        );
        return { fixset: set, proposal };
      },
      /**
       * Apply the accepted proposals (Q4): the Director writes ONE new draft at the earliest accepted stage (a visible turn; no render,
       * no synthesis); the accepted proposals of later stages become pending fixes. A recording or a discovery fix is only kept.
       */
      "qa-fix-apply": (body) => {
        const p = project();
        const plan = applyFixSet(p.dir, String(body.fixset ?? ""));
        const word = FIX_STAGE_WORD[plan.stage];
        rt.bus.publish(
          "qa.applying",
          {
            fixset: plan.set.id,
            stage: plan.stage,
            accepted: plan.now.length,
            pending: plan.pending.length,
            by: "panel",
            message: plan.writes
              ? `applying ${plan.now.length} accepted proposal${plan.now.length === 1 ? "" : "s"}: the Director writes one new ${word} draft${plan.pending.length ? `; ${plan.pending.length} for later stages kept as pending fixes` : ""}`
              : `the earliest accepted fix is for the ${word}, which you start yourself: ${plan.pending.length} kept as pending fixes`,
          },
          p.slug,
        );
        if (plan.writes) rt.notifyAgent(applyMessage(plan, PANEL_PREFIX));
        return { fixset: plan.set, stage: plan.stage, writes: plan.writes, pending: plan.pending };
      },
      "qa-fix-cancel": (body) => {
        const p = project();
        const set = readFixSet(p.dir, String(body.fixset ?? ""));
        if (!set || !askedRound(set)) throw new Error("there is no ask waiting for the Director");
        failRound(p.dir, set.id, "you cancelled this ask");
        return { fixset: readFixSet(p.dir, set.id) };
      },
    },
  };
}

export { openFixSet };
