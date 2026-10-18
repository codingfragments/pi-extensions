/**
 * The fix loop over HTTP (P1c Q3): flag findings, ask the Director for suggested fixes, decide on its proposals, ask it to rethink.
 * Nothing here applies a fix.
 *
 *   GET  /api/qa-fixes?version=N     the render's open fix set (rounds, proposals, your draft) and what can be flagged
 *   POST /api/qa-fix-flag            save what you flagged and wrote (no ask yet)
 *   POST /api/qa-fix-ask             ask the Director (starts a Director turn): the first round, or a rethink with more context
 *   POST /api/qa-fix-decide          accept, reject or edit one proposal, with a note
 *   POST /api/qa-fix-cancel          give up on an ask the Director has not answered
 */

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
      "qa-fixes": (q) => {
        const p = project();
        const render = Number(q.get("version"));
        if (!Number.isInteger(render) || render < 1) throw new Error('"version" is required');
        const set = listFixSets(p.dir).find((s) => s.render === render && s.status === "open");
        return {
          fixset: set ?? null,
          flaggable: flaggable(p.dir, render).map((i) => i.id),
          stageWords: FIX_STAGE_WORD,
        };
      },
    },
    post: {
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
