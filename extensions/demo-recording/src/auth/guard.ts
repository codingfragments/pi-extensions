/**
 * The session guard of a recording (S7, D147): wires the runner's `SessionGuard` to the engine. The plain rule looks at the page after every step; a suspicion is
 * confirmed in a fresh browser with the saved login; a confirmed expiry pauses the recording (a pending question, an `auth.expired` event) until a new login is saved
 * (`/demo login` or the Login card publish `auth.saved`), or until you stop it.
 */

import { askQuestion, cancelQuestion } from "../questions.ts";
import type { SessionGuard } from "../recorder/runner.ts";
import type { Runtime } from "../runtime.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import { factsOf, looksLoggedOut, probeSession } from "./session.ts";

export function sessionGuardFor(rt: Runtime, p: ProjectHandle, signal: AbortSignal): SessionGuard {
  const root = rt.getConfig().root;
  return {
    suspect: async (page) => {
      const v = looksLoggedOut(await factsOf(page));
      return v.out ? v.reason : undefined;
    },
    confirm: async () => (await probeSession({ root, app: p.app })).state === "expired",
    waitForLogin: async (info) => {
      const message = `your login for ${p.app.name} expired while recording (scene ${info.scene}): log in again with /demo login (or on the Project page); the recording goes on from that scene`;
      rt.bus.publish("auth.expired", { app: p.app.slug, scene: info.scene, message }, p.slug);
      const q = askQuestion(p.dir, {
        role: "Operator",
        what: `Your login for ${p.app.name} expired while recording (scene ${info.scene}). Log in again, and the recording goes on from that scene.`,
        why: "The recording is paused and nothing is lost. Log in with /demo login (or on the Project page). Stopping ends the recording.",
        options: [{ label: "Login: I will log in now" }, { label: "Stop the recording" }],
        auth: { app: p.app.slug },
      });
      rt.publishQuestion(q);
      await new Promise<void>((resolve, reject) => {
        const off = rt.bus.subscribe((e) => {
          if (e.type === "auth.saved" && (e.data as { app?: string }).app === p.app.slug) {
            off();
            signal.removeEventListener("abort", onAbort);
            resolve();
          }
        });
        const onAbort = () => {
          off();
          reject(new Error("recording cancelled"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }).finally(() => {
        // whichever way it ended, the question is not left waiting
        try {
          cancelQuestion(p.dir, q.id, "the recording is no longer waiting for it");
        } catch {
          // already answered
        }
      });
    },
  };
}
