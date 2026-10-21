/**
 * What happens when a question is asked, answered or abandoned (item 11b, D140 to D143), the same from every place: the panel's buttons, a typed
 * reply in the chat, `/demo allow`, the old Allow / Not now. One resolution, once; the Director is woken with the answer by whoever got there first.
 *
 * Two kinds of question:
 *  - the Director's own (`demo_rec_ask`): the answer is a message to the Director;
 *  - the Allow for a spend (`askFirst`): answering "Allow" issues the one-use 15-minute grant, "Deny" refuses the request; the messages are the
 *    ones the Director always got for those, and the grant store stays the only thing that decides whether something may start.
 */

import { pendingRequest, presetBudgets } from "./discovery/requests.ts";
import { requestDiscovery } from "./discovery/start.ts";
import { allowedMessage, deniedMessage } from "./grants.ts";
import {
  type AnswerResult,
  type Question,
  answerQuestion,
  answeredMessage,
  askQuestion,
  readQuestions,
} from "./questions.ts";
import { PANEL_PREFIX, reportAs } from "./roles.ts";
import type { Runtime } from "./runtime.ts";
import { readState } from "./workdir/state.ts";

/** The prefix of a message to the Director for an answer given in the chat. */
export const CHAT_PREFIX = reportAs("You");

/** Show a new question in the chat (a labelled message, no turn) and tell the panel. */
export function announceQuestion(rt: Runtime, q: Question): void {
  rt.publishQuestion(q);
}

/** The Allow for a spend, as a question (once per request: asking again returns the one that waits). */
export function askForGrant(
  rt: Runtime,
  req: { id: string; kind: "tts" | "take"; target: string; summary: string },
): Question | undefined {
  const p = rt.requireProject();
  const waiting = readQuestions(p.dir).find(
    (q) => q.status === "pending" && q.grant?.kind === req.kind && q.grant.target === req.target,
  );
  if (waiting) return waiting;
  const q = askQuestion(p.dir, {
    role: "Director",
    what: `Allow the Director to ${req.summary}?`,
    why: `${req.kind === "tts" ? "It spends voice credits" : "It spends recording time and model calls"}. Allowing is for this one thing, valid for 15 minutes.`,
    options: [{ label: "Allow" }, { label: "Deny" }],
    grant: { kind: req.kind, target: req.target, request: req.id, summary: req.summary },
  });
  announceQuestion(rt, q);
  return q;
}

/**
 * Answer a question from `by`. Returns the engine's result; on success the effects are done: the grant issued or refused (a spend question),
 * the event published, the Director woken (or told quietly, for Deny).
 */
export function answerFor(
  rt: Runtime,
  id: string,
  reply: string,
  by: "panel" | "chat",
): AnswerResult {
  const p = rt.requireProject();
  const r = answerQuestion(p.dir, id, reply, by);
  if (!r.ok) return r;
  const q = r.question;
  const a = q.answer as NonNullable<Question["answer"]>;
  rt.bus.publish(
    "question.answered",
    { id: q.id, option: a.key, by, message: `answered ${q.id} with ${a.key} · ${a.label}` },
    p.slug,
  );
  if (q.grant) {
    const g = q.grant;
    if (a.word === "allow") {
      rt.grants.issue(g.kind, p.slug, g.target, by);
      rt.bus.publish(
        "confirm.granted",
        { kind: g.kind, target: g.target, by, message: `allowed: ${g.kind} ${g.target}` },
        p.slug,
      );
      rt.notifyAgent(allowedMessage(g.summary));
    } else {
      rt.grants.deny(g.request);
      rt.bus.publish(
        "confirm.denied",
        { kind: g.kind, target: g.target, by, message: `not allowed: ${g.kind} ${g.target}` },
        p.slug,
      );
      rt.tellAgent(deniedMessage(g.summary));
    }
  } else if (q.discovery) {
    // the offer after a login: "start" asks the Director for a discovery with Config's standard budget; the others only close the question
    if (a.word === "start") {
      try {
        const req = requestDiscovery(rt, {
          mode: "start",
          budget: presetBudgets(rt.getConfig().budgets, "scout"),
          preset: "scout",
          by,
        });
        rt.bus.publish(
          "discovery.offer-taken",
          {
            request: req.id,
            message: `discovery started from the offer after the login (${req.id})`,
          },
          p.slug,
        );
      } catch (err) {
        rt.bus.publish(
          "discovery.offer-failed",
          { message: `discovery was not started: ${(err as Error).message}` },
          p.slug,
        );
      }
    } else if (a.word === "choose")
      rt.bus.publish(
        "discovery.offer-deferred",
        {
          message:
            "choose the areas and the budget on the Project page: Discovery, Start discovery…",
        },
        p.slug,
      );
  } else if (q.auth) {
    // a recording is paused for a new login (S7): "stop" ends it, "login" only says you will log in; neither is news for the Director
    if (a.word === "stop") {
      const job = rt.jobs.running("record");
      if (job) rt.jobs.cancel(job.id);
      rt.tellAgent(
        `${PANEL_PREFIX} The user stopped the recording that was waiting for a new login.`,
      );
    }
  } else rt.notifyAgent(answeredMessage(by === "chat" ? CHAT_PREFIX : PANEL_PREFIX, q));
  return r;
}

/**
 * A spend request was answered the old way (the panel's Allow / Not now, `/demo allow`, a confirmed dialog): its question, if one waits, is
 * answered too, so the bar and the chat do not keep asking. No message: the old route tells the Director itself.
 */
export function settleGrantQuestion(
  rt: Runtime,
  match: { request?: string; kind?: string; target?: string },
  word: "allow" | "deny",
  by: "panel" | "chat",
): void {
  const p = rt.activeProject();
  if (!p) return;
  const q = readQuestions(p.dir).find(
    (x) =>
      x.status === "pending" &&
      x.grant &&
      (match.request
        ? x.grant.request === match.request
        : x.grant.kind === match.kind && x.grant.target === match.target),
  );
  if (!q) return;
  const r = answerQuestion(p.dir, q.id, word, by);
  if (r.ok)
    rt.bus.publish(
      "question.answered",
      {
        id: q.id,
        option: r.question.answer?.key,
        by,
        message: `answered ${q.id} with ${r.question.answer?.key} · ${r.question.answer?.label}`,
      },
      p.slug,
    );
}

/**
 * A login was saved for an app (`/demo login`, the Login card): tell the panel, and answer the question of a recording that was waiting for it, so the bar and the chat
 * stop asking. The recording itself carries on when it sees the event.
 */
export function loginSaved(rt: Runtime, appSlug: string, appName: string): void {
  const p = rt.activeProject();
  rt.bus.publish("auth.saved", { app: appSlug, message: `login saved for ${appName}` }, p?.slug);
  if (!p) return;
  let resumed = false;
  for (const q of readQuestions(p.dir))
    if (q.status === "pending" && q.auth?.app === appSlug) {
      resumed = true;
      const r = answerQuestion(p.dir, q.id, "login", "chat");
      if (r.ok)
        rt.bus.publish(
          "question.answered",
          {
            id: q.id,
            option: r.question.answer?.key,
            by: "chat",
            message: `answered ${q.id}: you logged in again`,
          },
          p.slug,
        );
    }
  if (!resumed) offerDiscovery(rt, appSlug);
}

/**
 * After a fresh login: the Director asks whether to start discovery (never starts it by itself: it costs model tokens and browser time). Not asked when it would be
 * noise: a recording was waiting for this login, a session is open, a request is already waiting, the same question is waiting, the project is past discovery, or a take runs.
 */
export function offerDiscovery(rt: Runtime, appSlug: string): Question | undefined {
  const p = rt.activeProject();
  if (!p || p.app.slug !== appSlug) return undefined;
  if (rt.discovery && !rt.discovery.isClosed) return undefined;
  if (rt.jobs.running("record")) return undefined;
  if (pendingRequest(p.dir)) return undefined;
  if (readQuestions(p.dir).some((q) => q.status === "pending" && q.discovery)) return undefined;
  const phase = (readState(p.dir) ?? p.state).phase;
  if (phase !== "brief" && phase !== "discovery") return undefined;
  const b = presetBudgets(rt.getConfig().budgets, "scout");
  const q = askQuestion(p.dir, {
    role: "Director",
    what: `Your login for ${p.app.name} is saved and works. Start discovery now?`,
    why: `A scouting run: the engine surveys the app's navigation, then the Director looks closely at a few pages (${b.discoveryScreens} screens, ${b.discoveryActions} actions, ${b.discoveryMinutes} min at most): model tokens and browser time, no money. Nothing starts unless you say so.`,
    options: [
      { label: "Start discovery now (a quick scout)" },
      { label: "Choose areas or budget first" },
      { label: "Not now" },
    ],
    discovery: { app: appSlug },
  });
  announceQuestion(rt, q);
  return q;
}
