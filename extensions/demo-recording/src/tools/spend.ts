/**
 * The Director asks before it spends (P1a, F17). See `../grants.ts`.
 *
 * A tool that would spend credits or recording time calls `askFirst` when the user has not
 * allowed it: nothing starts, a request is filed (the panel and the chat show "Allow / Deny", `/demo
 * allow` answers it) and the Director is told to wait.
 */

import type { SpendKind } from "../grants.ts";
import { askForGrant } from "../question-flow.ts";
import type { Runtime } from "../runtime.ts";
import { result } from "./common.ts";

/** The target string of a grant: what exactly is allowed. */
export const spendTarget = (kind: SpendKind, version: number): string =>
  kind === "tts" ? `vo:${version}` : `storyboard:${version}`;

/** Thrown by an engine start when an agent start has no grant: a second line behind the tools' check. */
export function notAllowed(kind: SpendKind, target: string): Error {
  return new Error(
    `not allowed: ${kind} ${target} needs the user's permission (the panel's Allow or /demo allow)`,
  );
}

/** Refuse politely: file the request, publish it for the panel, tell the Director to wait. */
export function askFirst(rt: Runtime, kind: SpendKind, target: string, summary: string) {
  const p = rt.requireProject();
  const req = rt.grants.request(kind, p.slug, target, summary);
  rt.bus.publish(
    "confirm.requested",
    { id: req.id, kind, target, summary, message: `the Director asks: ${summary}` },
    p.slug,
  );
  // the same Allow, as a question in the panel and the chat: typing 1 or allow there answers it (11b)
  askForGrant(rt, req);
  return result(
    `NOT STARTED. This spends ${kind === "tts" ? "voice credits" : "recording time and model calls"} and needs the user's permission first: ${summary}.\nThe panel and the chat now show the question (Allow / Deny); they answer it there, or type /demo allow. Tell the user in one line what you are waiting for and STOP. Do not retry and do not ask again: you get a [demo-recording] message when they have answered.`,
    { requested: req.id, kind, target },
  );
}
