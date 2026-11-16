/**
 * Cancel from the panel (item 24, R3-15): an engine job (a take, the voice, the edit, a render or quality check, the annotation designer), the discovery session, and
 * the Director's running turn. A cancel is immediate for the engine (the job's AbortSignal; a step or a command that does not answer is killed by the watchdogs) and
 * keeps what was done; the Director is told quietly and does not restart anything by itself.
 *
 *   POST job-cancel      { kind }  kind is the Activity row's key: take | tts | edit | render | design
 *   POST discovery-stop  {}        closes the open discovery session, keeps what it saw
 *   POST director-stop   {}        aborts the Director's turn (as Esc in pi)
 */

import { PANEL_PREFIX } from "../roles.ts";
import type { Runtime } from "../runtime.ts";
import type { PostRoute } from "./server.ts";

/** The Activity row's key → the job kind, and what a cancel keeps, in words. */
export const CANCELLABLE: Record<string, { job: string; what: string; keeps: string }> = {
  take: {
    job: "record",
    what: "the recording",
    keeps:
      "The take is marked cancelled; what it recorded so far stays on disk, and nothing is approved.",
  },
  tts: {
    job: "tts",
    what: "the voice synthesis",
    keeps: "Sections already synthesized are billed and cached: starting it again reuses them.",
  },
  edit: {
    job: "edit",
    what: "the edit and its draft render",
    keeps: "The take and the voice are unchanged.",
  },
  render: {
    job: "render",
    what: "the render (or quality check)",
    keeps: "Earlier render versions are unchanged; this one is left out.",
  },
  design: {
    job: "design",
    what: "the annotation designer",
    keeps: "The annotation versions you have are unchanged.",
  },
};

export function cancelRoutes(rt: Runtime): { post: Record<string, PostRoute> } {
  return {
    post: {
      "job-cancel": (body) => {
        const key = String(body.kind ?? "");
        const c = CANCELLABLE[key];
        if (!c) throw new Error(`"kind" must be one of ${Object.keys(CANCELLABLE).join(", ")}`);
        const j = rt.jobs.running(c.job);
        if (!j) return { cancelled: false, message: `${c.what} is not running` };
        j.controller.abort();
        const message = `you cancelled ${c.what} (${j.id}). ${c.keeps}`;
        rt.bus.publish(
          "job.cancel-asked",
          { kind: key, job: j.id, by: "panel", message },
          j.project,
        );
        rt.tellAgent(
          `${PANEL_PREFIX} The user CANCELLED ${c.what} (${j.id}) from the panel. ${c.keeps} Do not start it again unless they ask.`,
        );
        return { cancelled: true, job: j.id, message };
      },
      "discovery-stop": async () => {
        const d = rt.discovery;
        if (!d || d.isClosed) return { stopped: false, message: "no discovery session is open" };
        const id = d.id;
        const budget = d.budget();
        await rt.closeDiscovery();
        const message = `you stopped discovery session ${id} (screens ${budget.screens}, actions ${budget.actions}); what it saw is kept`;
        rt.bus.publish(
          "discovery.stopped",
          { session: id, by: "panel", message },
          rt.activeProjectSlug,
        );
        rt.tellAgent(
          `${PANEL_PREFIX} The user STOPPED the discovery session ${id} from the panel; its screens and findings are kept. Do not reopen it. When you go on, work from what it found (the report, then the storyboard), or wait for the user.`,
        );
        return { stopped: true, session: id, message };
      },
      "director-stop": () => {
        const stopped = rt.stopDirector();
        const message = stopped
          ? "you stopped the Director: its turn ends now; what it asked and nobody answered goes with it"
          : "the Director is not working (nothing to stop)";
        rt.bus.publish(
          "director.stop-asked",
          { stopped, by: "panel", message },
          rt.activeProjectSlug,
        );
        if (stopped)
          rt.tellAgent(
            `${PANEL_PREFIX} The user STOPPED your last turn from the panel. Do not pick it up again by yourself: wait for their next message.`,
          );
        return { stopped, message };
      },
    },
  };
}
