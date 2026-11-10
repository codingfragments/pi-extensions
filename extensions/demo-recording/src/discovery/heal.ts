/**
 * The autoheal of a failed take (item 18, part 2, R3-14). Started only by the user (the card's button or the question's answer): a bounded Director run that looks at
 * the failing step's page, read only, and writes a NEW DRAFT storyboard that works around the failure. It never records, approves, edits the brief or spends.
 *
 * It reuses the discovery request: a request of mode `heal` with the fixed HEAL_BUDGET (about 15 actions, 6 minutes). The session that takes it is read-only
 * (an action that would change something is blocked) and the Director is told exactly what to do and what not to do.
 */

import { answerQuestion, readQuestions } from "../questions.ts";
import { readFailedTake } from "../recorder/failure.ts";
import { PANEL_PREFIX } from "../roles.ts";
import type { Runtime } from "../runtime.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { recordInput } from "../workdir/inputs.ts";
import { type DiscoveryRequest, HEAL_BUDGET, addRequest } from "./requests.ts";

/** What the Director is told for a repair: the failure, the step as written, the limits, and the one output. */
export function healMessage(
  p: { slug: string; name: string; url: string },
  r: DiscoveryRequest,
  f: { words: string; verdict?: string; diagnostics: string[]; scene?: unknown },
): string {
  const b = r.budget;
  const h = r.heal as NonNullable<DiscoveryRequest["heal"]>;
  const lines = [
    `${PANEL_PREFIX} The user asks you to REPAIR the failed ${h.take} of storyboard v${h.storyboardVersion} for demo project "${p.slug}" (${p.name}, ${p.url}) (request ${r.id}). This is the autoheal: a short, bounded repair run that only they can start.`,
    `What failed: ${f.words}.${f.verdict ? ` Diagnosis: ${f.verdict}.` : ""} Evidence: takes/${h.take}/take.json, attempts.jsonl${f.diagnostics.length ? `, ${f.diagnostics.at(-1)}/README.txt` : ""}.`,
  ];
  if (f.scene)
    lines.push(`The scene as written (v${h.storyboardVersion}): ${JSON.stringify(f.scene)}`);
  lines.push(
    `How: open ONE discovery session with demo_rec_browser open (it takes this request: ${b.discoveryScreens} screens, ${b.discoveryActions} actions, ${b.discoveryMinutes} minutes, and it is READ-ONLY: an action that would change something is blocked). Go straight to the page of the failing step (the scene's deep_link or the route to it), look, and find out why the step failed (a target renamed or moved, a page that loads late, a state that is not there). Do not explore anything else and do not record findings about other areas.`,
    "The one output: a NEW DRAFT of the storyboard (demo_rec_storyboard write) that fixes only that scene (another target, a deep link, a wait, or dropping the step), and a short diagnosis in your reply: what was wrong, what you changed, and anything you could not verify. Close the session when you are done.",
    "You must NOT: record a take, approve anything, edit the brief, start another discovery, spend (text to speech, a take), or touch other scenes beyond what the fix needs. If the cause is not clear after the look, say so and write no draft: the user decides.",
  );
  if (r.notes) lines.push(`Their notes: ${r.notes}`);
  return lines.join("\n");
}

/** Refuse when a session is open or the take did not fail; store the request, record it, tell the panel, wake the Director. */
export function requestHeal(
  rt: Runtime,
  body: { take: string; text?: unknown; by?: "panel" | "chat" },
): DiscoveryRequest {
  const p = rt.requireProject();
  if (rt.discovery && !rt.discovery.isClosed)
    throw new Error(
      "a discovery session is running: wait for it to finish, or ask the Director to close it",
    );
  const sb = (() => {
    const meta = readFailedTake(p.dir, body.take);
    return meta ? readStoryboard(p.dir, meta.storyboardVersion) : undefined;
  })();
  const f = readFailedTake(p.dir, body.take, sb?.storyboard);
  if (!f) throw new Error(`${body.take} did not fail: there is nothing to repair`);
  if (!sb)
    throw new Error(
      `storyboard v${f.storyboardVersion} of ${body.take} is gone: nothing to repair`,
    );
  // the card's box starts with the evidence and "What I would change:": an empty answer there is no note
  const notes = (typeof body.text === "string" ? body.text : "")
    .replace(/\s*What I would change:\s*$/i, "")
    .trim()
    .slice(0, 1500);
  const scene = f.failure.scene
    ? sb.storyboard.scenes.find((s) => s.id === f.failure.scene)
    : undefined;
  const req = addRequest(p.dir, {
    mode: "heal",
    heal: {
      take: f.take,
      ...(f.failure.scene ? { scene: f.failure.scene } : {}),
      storyboardVersion: f.storyboardVersion,
    },
    notes,
    budget: HEAL_BUDGET,
  });
  recordInput(p.dir, {
    stage: "recording",
    version: f.storyboardVersion,
    source: body.by ?? "panel",
    kind: "direction",
    text: `autoheal the failed ${f.take} (${f.words}): a read-only look (${HEAL_BUDGET.discoveryActions} actions, ${HEAL_BUDGET.discoveryMinutes} min) and a new draft storyboard${notes ? `. Their notes: ${notes}` : ""}`,
  });
  // the question "what now?" of this take is answered by asking for the repair
  for (const q of readQuestions(p.dir))
    if (q.status === "pending" && q.takeFailed?.take === f.take) {
      const r = answerQuestion(p.dir, q.id, "heal", body.by ?? "panel");
      if (r.ok)
        rt.bus.publish(
          "question.answered",
          {
            id: q.id,
            option: r.question.answer?.key,
            by: body.by ?? "panel",
            message: `answered ${q.id}: you asked the Director to repair ${f.take}`,
          },
          p.slug,
        );
    }
  rt.bus.publish(
    "take.heal-requested",
    {
      request: req.id,
      take: f.take,
      budget: HEAL_BUDGET,
      message: `asked the Director to repair ${f.take}: a read-only look (${HEAL_BUDGET.discoveryActions} actions, ${HEAL_BUDGET.discoveryMinutes} min) and a new draft storyboard`,
    },
    p.slug,
  );
  rt.notifyAgent(
    healMessage({ slug: p.slug, name: p.app.name ?? p.app.slug, url: p.app.baseUrl }, req, {
      words: f.words,
      ...(f.verdict ? { verdict: f.verdict } : {}),
      diagnostics: f.diagnostics,
      ...(scene ? { scene } : {}),
    }),
  );
  return req;
}
