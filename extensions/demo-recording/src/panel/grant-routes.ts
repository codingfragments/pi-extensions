/**
 * Spending grants over HTTP (P1a): the panel's "Allow / Not now" and the dialogs the user already
 * confirmed. See `../grants.ts`.
 *
 *   GET  /api/confirmations           open requests of the active project (the Director asked)
 *   POST /api/grant {request}         allow an open request
 *   POST /api/grant {kind, target}    allow something the user just confirmed in a dialog
 *   POST /api/grant-deny {request}    refuse an open request
 */

import { type SpendKind, allowedMessage, deniedMessage } from "../grants.ts";
import type { Runtime } from "../runtime.ts";
import type { GetRoute, PostRoute } from "./server.ts";

const KINDS: SpendKind[] = ["tts", "take"];

export function grantRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const slug = () => rt.requireProject().slug;
  return {
    get: {
      confirmations: () => ({ requests: rt.grants.pending(rt.activeProject()?.slug) }),
    },
    post: {
      grant: (body) => {
        const project = slug();
        if (typeof body.request === "string") {
          const summary = rt.grants.pending(project).find((r) => r.id === body.request)?.summary;
          const g = rt.grants.allow(body.request, "panel");
          if (!g)
            throw new Error("that request is gone (answered or expired) — ask the Director again");
          rt.bus.publish(
            "confirm.granted",
            {
              kind: g.kind,
              target: g.target,
              by: "panel",
              message: `allowed: ${g.kind} ${g.target}`,
            },
            project,
          );
          rt.notifyAgent(allowedMessage(summary ?? `${g.kind} ${g.target}`));
          return { granted: { kind: g.kind, target: g.target } };
        }
        const kind = body.kind as SpendKind;
        if (!KINDS.includes(kind) || typeof body.target !== "string" || !body.target)
          throw new Error('"request", or "kind" and "target", is required');
        const g = rt.grants.issue(kind, project, body.target, "panel");
        rt.bus.publish(
          "confirm.granted",
          { kind, target: g.target, by: "panel", message: `allowed: ${kind} ${g.target}` },
          project,
        );
        return { granted: { kind, target: g.target } };
      },
      "grant-deny": (body) => {
        if (typeof body.request !== "string") throw new Error('"request" is required');
        const r = rt.grants.deny(body.request);
        if (!r) throw new Error("that request is gone (answered or expired)");
        rt.bus.publish(
          "confirm.denied",
          {
            kind: r.kind,
            target: r.target,
            by: "panel",
            message: `not allowed: ${r.kind} ${r.target}`,
          },
          slug(),
        );
        rt.tellAgent(deniedMessage(r.summary));
        return { denied: { kind: r.kind, target: r.target } };
      },
    },
  };
}
