/**
 * Spending grants (P1a, F17): the Director may not spend credits or recording time on its own.
 *
 * A **grant** is an engine-held permission for one thing: `{ kind, project, target }`, valid for
 * `GRANT_TTL_MS`, used once. The model never handles a token, so there is nothing for it to
 * forge or leak: it asks, the engine refuses with the estimate and files a **request**, and the
 * user allows it (the panel dialog, or a typed `/demo allow`). Slash commands are typed by the
 * user, so the agent cannot send one.
 *
 * This guards against the model acting unasked; it is not a security boundary against a
 * hostile agent with shell access.
 */

import { randomBytes } from "node:crypto";
import { reportAs } from "./roles.ts";

/** What a grant can pay for. The auto designer is run-and-tell, not gated (P1a decision). */
export type SpendKind = "tts" | "take";

/** A grant lives this long, then the Director has to ask again. */
export const GRANT_TTL_MS = 15 * 60 * 1000;
/** A request waits this long for an answer. */
export const REQUEST_TTL_MS = 60 * 60 * 1000;

export interface Grant {
  kind: SpendKind;
  project: string;
  /** What exactly is allowed, e.g. `vo:3` (voice-over version) or `storyboard:2`. */
  target: string;
  by: "panel" | "chat";
  expires: number;
}

export interface SpendRequest {
  id: string;
  kind: SpendKind;
  project: string;
  target: string;
  /** What will happen and what it costs, in the user's words. */
  summary: string;
  at: number;
}

/** What the Director is told when the user allows a request (starts its turn). */
export const allowedMessage = (what: string): string =>
  `${reportAs("You")} The user ALLOWED: ${what}. Go on with exactly that (the permission is valid for 15 minutes and for one start).`;

/** What the Director is told when the user refuses a request (a quiet note). */
export const deniedMessage = (what: string): string =>
  `${reportAs("You")} The user did NOT allow: ${what}. Do not try again unless they ask you to.`;

export class GrantStore {
  private grants: Grant[] = [];
  private requests: SpendRequest[] = [];
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private sweep(): void {
    const t = this.now();
    this.grants = this.grants.filter((g) => g.expires > t);
    this.requests = this.requests.filter((r) => r.at + REQUEST_TTL_MS > t);
  }

  /** Allow `kind` on `target` once. Also answers the matching open request. */
  issue(kind: SpendKind, project: string, target: string, by: Grant["by"]): Grant {
    this.sweep();
    this.requests = this.requests.filter(
      (r) => !(r.kind === kind && r.project === project && r.target === target),
    );
    this.grants = this.grants.filter(
      (g) => !(g.kind === kind && g.project === project && g.target === target),
    );
    const grant: Grant = { kind, project, target, by, expires: this.now() + GRANT_TTL_MS };
    this.grants.push(grant);
    return grant;
  }

  /** Is there a live grant? Does not use it up. */
  has(kind: SpendKind, project: string, target: string): boolean {
    this.sweep();
    return this.grants.some((g) => g.kind === kind && g.project === project && g.target === target);
  }

  /** Use a grant up (true), or report there is none (false). */
  consume(kind: SpendKind, project: string, target: string): boolean {
    this.sweep();
    const i = this.grants.findIndex(
      (g) => g.kind === kind && g.project === project && g.target === target,
    );
    if (i < 0) return false;
    this.grants.splice(i, 1);
    return true;
  }

  /** File (or refresh) a request: the Director asked and was refused. */
  request(kind: SpendKind, project: string, target: string, summary: string): SpendRequest {
    this.sweep();
    const same = this.requests.find(
      (r) => r.kind === kind && r.project === project && r.target === target,
    );
    if (same) {
      same.summary = summary;
      return same;
    }
    const req: SpendRequest = {
      id: randomBytes(3).toString("hex"),
      kind,
      project,
      target,
      summary,
      at: this.now(),
    };
    this.requests.push(req);
    return req;
  }

  /** Open requests, oldest first (of one project, or all). */
  pending(project?: string): SpendRequest[] {
    this.sweep();
    return this.requests.filter((r) => project === undefined || r.project === project);
  }

  /** Allow a request by id: it becomes a grant. */
  allow(id: string, by: Grant["by"]): Grant | undefined {
    this.sweep();
    const r = this.requests.find((x) => x.id === id);
    return r ? this.issue(r.kind, r.project, r.target, by) : undefined;
  }

  /** Refuse a request by id. */
  deny(id: string): SpendRequest | undefined {
    this.sweep();
    const i = this.requests.findIndex((x) => x.id === id);
    return i < 0 ? undefined : this.requests.splice(i, 1)[0];
  }
}
