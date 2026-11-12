/**
 * What happens when a question is asked, answered or abandoned (item 11b, D140 to D143), the same from every place: the panel's buttons, a typed
 * reply in the chat, `/demo allow`, the old Allow / Not now. One resolution, once; the Director is woken with the answer by whoever got there first.
 *
 * Two kinds of question:
 *  - the Director's own (`demo_rec_ask`): the answer is a message to the Director;
 *  - the Allow for a spend (`askFirst`): answering "Allow" issues the one-use 15-minute grant, "Deny" refuses the request; the messages are the
 *    ones the Director always got for those, and the grant store stays the only thing that decides whether something may start.
 */

import { writeBriefField } from "./budget/vo.ts";
import { requestHeal } from "./discovery/heal.ts";
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
import { readFailedTake, recommendationDraft } from "./recorder/failure.ts";
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
  } else if (q.voLength) {
    const v = q.voLength;
    if (a.word === "raise") {
      const bv = writeBriefField(
        p.dir,
        { noLongerThan: `${clockOf(v.raiseToSec * 1000)} min` },
        `the length ceiling raised to ${clockOf(v.raiseToSec * 1000)} for voice-over v${v.vo}`,
      );
      rt.bus.publish(
        "brief.written",
        {
          version: bv,
          by: "user",
          changed: ["noLongerThan"],
          message: `brief v${bv}: No longer than ${clockOf(v.raiseToSec * 1000)}`,
        },
        p.slug,
      );
      rt.tellAgent(
        `${reportAs("Voice writer")} The user RAISED the length ceiling to ${clockOf(v.raiseToSec * 1000)} (brief v${bv}, No longer than): voice-over v${v.vo} (about ${clockOf(v.finalSec * 1000)}) fits now. Nothing to rewrite; it waits for their review.`,
      );
    } else
      rt.notifyAgent(
        `${PANEL_PREFIX} The user wants voice-over v${v.vo} CUT to the length ceiling: it makes the final about ${clockOf(v.finalSec * 1000)}, the ceiling is ${clockOf(v.ceilingSec * 1000)}. Write a new version (demo_rec_vo write, base ${v.vo}) that fits: cut where the speech is longer than the footage first${v.cut.length ? ` (${v.cut.join(", ")})` : ""}, keep the meaning, drop the least important sentences. Do NOT synthesize or approve anything.`,
      );
  } else if (q.takeLength) {
    const t = q.takeLength;
    if (a.word === "extend")
      rt.notifyAgent(
        `${PANEL_PREFIX} The user wants the storyboard EXTENDED to meet the length budget: ${t.take} is projected at ${clockOf(t.finalMs)} for a target of ${clockOf(t.targetSec * 1000)}. Write a new storyboard DRAFT (demo_rec_storyboard write) that closes the gap: depth first (more of what matters, another relevant path), scene times that add up to the target, holds only for the rest; say what you added. If the app has no more real content, say so with evidence and propose a shorter target instead. Do NOT record and do NOT approve anything.`,
      );
    else if (a.word === "record")
      rt.bus.publish(
        "take.record-again-asked",
        {
          take: t.take,
          message:
            "record again: use “Request a new take” in the Recording tab (it asks for your Allow)",
        },
        p.slug,
      );
    else
      rt.tellAgent(
        `${reportAs("Operator")} The user ACCEPTS ${t.take} at its length (${clockOf(t.finalMs)} against a target of ${clockOf(t.targetSec * 1000)}): go on with it as usual (propose it, then the voice-over).`,
      );
  } else if (q.takeFailed) {
    if (a.word === "heal") {
      try {
        const f = readFailedTake(p.dir, q.takeFailed.take);
        requestHeal(rt, {
          take: q.takeFailed.take,
          text: f ? recommendationDraft(f).replace(/\s*What I would change:\s*$/, "") : "",
          by: "chat",
        });
      } catch (e) {
        rt.bus.publish(
          "take.heal-refused",
          {
            take: q.takeFailed.take,
            message: `could not start the repair: ${e instanceof Error ? e.message : e}`,
          },
          p.slug,
        );
      }
    }
    // what now, after a failed take: the answers only point at the Recording tab or close the question; no answer wakes the Director
    if (a.word === "add")
      rt.bus.publish(
        "take.recommend-asked",
        {
          take: q.takeFailed.take,
          message: `write your recommendation on ${q.takeFailed.take} in the Recording tab: the failed take has a card for it`,
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

/**
 * A take failed (it ran out of retries, or the browser froze more often than a take survives): the decision is the user's, so ask. The Director is NOT woken: it is told
 * quietly, and it must not start a discovery or a new take by itself (the question and the Recording tab's card are how the user answers). Once per take.
 */
export function askAfterFailedTake(rt: Runtime, take: string, words: string): Question | undefined {
  const p = rt.activeProject();
  if (!p) return undefined;
  if (readQuestions(p.dir).some((q) => q.status === "pending" && q.takeFailed?.take === take))
    return undefined;
  const q = askQuestion(p.dir, {
    role: "Operator",
    what: `${take} failed: ${words}. What now?`.slice(0, 300),
    why: "Nothing starts by itself. Add your recommendation on the failed scene in the Recording tab (a note for the next take, or sent to the Director), let the Director look and propose a repaired draft (a read-only look, 15 actions, 6 minutes: it never records), or leave it.",
    options: [
      { label: "Add my recommendation" },
      { label: "Heal it: let the Director look and repair" },
      { label: "Leave it" },
    ],
    takeFailed: { take },
  });
  announceQuestion(rt, q);
  return q;
}

const clockOf = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** A take misses the length budget (item 22, D-R3-25-11): the user decides, once per take. Nothing re-records by itself. */
export function askAboutLength(
  rt: Runtime,
  take: string,
  l: { finalMs: number; words?: string; verdict?: string; budget?: { targetSec: number } },
): Question | undefined {
  const p = rt.activeProject();
  if (!p || !l.budget || (l.verdict !== "short" && l.verdict !== "long")) return undefined;
  if (readQuestions(p.dir).some((q) => q.status === "pending" && q.takeLength?.take === take))
    return undefined;
  const q = askQuestion(p.dir, {
    role: "Operator",
    what: `${take} misses the length budget: ${l.words}. What now?`.slice(0, 300),
    why: "The budget is the final video (title card in, loading cut out). Accept it as it is, have the Director extend the storyboard (a new draft, depth first), or record again.",
    options: [
      { label: "Accept it as it is" },
      { label: "Extend the storyboard" },
      { label: "Record again" },
    ],
    takeLength: { take, finalMs: l.finalMs, targetSec: l.budget.targetSec, verdict: l.verdict },
  });
  announceQuestion(rt, q);
  return q;
}

/** A voice-over that would pass the length ceiling (item 22, D-R3-25-14): raise the ceiling, or cut. Once per version. */
export function askAboutVoLength(
  rt: Runtime,
  vo: number,
  l: {
    finalSec: number;
    words: string;
    raiseToSec: number;
    overruns: { section: string; overSec: number }[];
  },
  ceilingSec: number,
): Question | undefined {
  const p = rt.activeProject();
  if (!p) return undefined;
  if (readQuestions(p.dir).some((q) => q.status === "pending" && q.voLength?.vo === vo))
    return undefined;
  const q = askQuestion(p.dir, {
    role: "Voice writer",
    what: `Voice-over v${vo} is longer than the length ceiling: ${l.words}. Raise the ceiling, or cut the script?`.slice(
      0,
      300,
    ),
    why: "Within the budget the edit stretches the scenes to the voice; past the ceiling it is your call. Raising writes “No longer than” into the brief; cutting asks the Director for a shorter version.",
    options: [
      { label: `Raise the ceiling to ${clockOf(l.raiseToSec * 1000)}` },
      { label: "Cut the script" },
    ],
    voLength: {
      vo,
      finalSec: l.finalSec,
      ceilingSec,
      raiseToSec: l.raiseToSec,
      cut: l.overruns.slice(0, 3).map((o) => o.section),
    },
  });
  announceQuestion(rt, q);
  return q;
}
