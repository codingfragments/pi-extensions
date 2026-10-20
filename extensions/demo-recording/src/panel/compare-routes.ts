/**
 * Compare two versions over HTTP (item 9b). The facts are `GET /api/compare` (stage-routes.ts, free). Here: the Director's verdict.
 *
 *   GET  /api/compare-verdicts?stage=   every stored verdict and open ask of the project (for "Past comparisons (n)" and the window)
 *   POST /api/compare-ask               ask the Director for a verdict on a pair (starts a Director turn; costs model tokens only)
 *   POST /api/compare-cancel            give up on an ask the Director has not answered
 */

import { askVerdict, cancelVerdict, listVerdicts, readVerdict } from "../compare/verdict.ts";
import { PANEL_PREFIX } from "../roles.ts";
import type { Runtime } from "../runtime.ts";
import type { GetRoute, PostRoute } from "./server.ts";

const WORD = { storyboard: "storyboard", vo: "voice-over" } as const;

/** What the Director is told when you ask. */
export function compareMessage(stage: "storyboard" | "vo", a: number, b: number): string {
  return `${PANEL_PREFIX} The user asks for an honest verdict on the ${WORD[stage]}: v${b} (newer) compared with v${a}. Call demo_rec_compare context (the facts are counted for you), then demo_rec_compare answer with a verdict that names its evidence, states the strongest argument against your own recommendation and says plainly when the newer version is worse or when nothing meaningful changed. Do not use, approve or change any version; stop after answer.`;
}

export function compareRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const project = () => rt.requireProject();
  const pair = (body: Record<string, unknown>) => ({
    stage: String(body.stage ?? ""),
    a: Number(body.a),
    b: Number(body.b),
  });
  return {
    get: {
      "compare-verdicts": (q) => {
        const p = project();
        const stage = q.get("stage") ?? undefined;
        return { verdicts: listVerdicts(p.dir, stage) };
      },
    },
    post: {
      "compare-ask": (body) => {
        const p = project();
        const { stage, a, b } = pair(body);
        const before = readVerdict(p.dir, stage, a, b);
        const v = askVerdict(p.dir, stage, a, b);
        rt.bus.publish(
          "compare.asked",
          {
            id: v.id,
            stage: v.stage,
            a,
            b,
            by: "panel",
            message: `asked the Director for a verdict on ${WORD[v.stage]} v${a} → v${b}${before?.status === "answered" ? " (replacing the earlier one)" : ""}`,
          },
          p.slug,
        );
        rt.notifyAgent(compareMessage(v.stage, a, b));
        return { verdict: v };
      },
      "compare-cancel": (body) => {
        const p = project();
        const { stage, a, b } = pair(body);
        const v = cancelVerdict(p.dir, stage, a, b);
        rt.bus.publish(
          "compare.cancelled",
          {
            id: v.id,
            stage: v.stage,
            a,
            b,
            by: "panel",
            message: `gave up on the verdict for ${WORD[v.stage]} v${a} → v${b}`,
          },
          p.slug,
        );
        return { verdict: v };
      },
    },
  };
}
