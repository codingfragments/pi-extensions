// What the panel does when something happens, written down once (P1a A3, F22). Every event the engine publishes is
// in this table with a class, and a test fails for an event that is not (src/ and this table must agree).
//
//   ask           the event is part of asking you or your answer (the Director wants to spend; you allowed it)
//   run-and-tell  a result that arrived without you asking at that moment (the Director wrote something, a cheap
//                 automatic step finished): a "new" badge on the screen it concerns, a toast if you are looking at
//                 that screen, and a line under "Happened by itself" in Activity
//   progress      part of a running task: shown in the strip and the Activity rows, never a notification
//   alert         something went wrong or needs a look: never silent, always a toast
//   quiet         your own action or bookkeeping: nothing to tell
//
// `tab` is the screen it concerns (a name, or a function of the event); `when(e)` narrows it (an edit you made yourself is not news to you).

const mine = (e) => ["user", "panel", "cli"].includes(e.data?.by);
const notMine = (e) => !mine(e);

export const STEPS = {
  "agent.notified": { class: "quiet" },
  "agent.notify-failed": { class: "alert" },
  "annotations.approved": { class: "quiet" },
  "annotations.requested": { class: "quiet" },
  "annotations.updated": { class: "run-and-tell", tab: "annotations", when: notMine },
  "brand.changed": { class: "quiet" },
  "brief.requested": { class: "quiet" },
  "brief.written": { class: "run-and-tell", tab: "project", when: notMine },
  // the verdict of a comparison: a result the Director wrote; it belongs to the stage that was compared
  "compare.answered": {
    class: "run-and-tell",
    tab: (e) => (e.data?.stage === "vo" ? "voice" : "storyboard"),
  },
  "compare.asked": { class: "quiet" },
  "compare.cancelled": { class: "quiet" },
  "config.changed": { class: "quiet" },
  "confirm.denied": { class: "ask" },
  "confirm.granted": { class: "ask" },
  "confirm.requested": { class: "ask" },
  "design.announced": { class: "run-and-tell", tab: "annotations" },
  "design.finished": { class: "run-and-tell", tab: "annotations" },
  "design.progress": { class: "progress" },
  "director.settled": { class: "quiet" },
  "director.started": { class: "progress" },
  "director.step": { class: "progress" },
  "discovery.act": { class: "progress" },
  "discovery.cancelled": { class: "quiet" },
  "discovery.closed": { class: "run-and-tell", tab: "project" },
  "discovery.report-asked": { class: "quiet" },
  "discovery.offer-deferred": { class: "run-and-tell", tab: "project" },
  "discovery.offer-failed": { class: "ask" },
  "discovery.offer-taken": { class: "quiet" },
  "discovery.reported": { class: "run-and-tell", tab: "project", when: notMine },
  "discovery.look": { class: "progress" },
  "discovery.opened": { class: "progress" },
  "discovery.progress": { class: "progress" },
  "discovery.request-taken": { class: "quiet" },
  "discovery.requested": { class: "quiet" },
  "doctor.result": { class: "quiet" },
  "draft.changed": { class: "quiet" },
  "edit.finished": { class: "run-and-tell", tab: "render" },
  "edit.progress": { class: "progress" },
  "edit.started": { class: "progress" },
  "finding.marked": { class: "quiet" },
  "finding.recorded": { class: "progress" },
  "input.marked": { class: "quiet" },
  "input.recorded": { class: "quiet" },
  "line.changed": { class: "quiet" },
  "model.warning": { class: "alert" },
  "panel.started": { class: "quiet" },
  "project.active": { class: "quiet" },
  "auth.checked": { class: "quiet" },
  "auth.expired": { class: "ask" },
  "auth.failed": { class: "ask" },
  "auth.forgotten": { class: "quiet" },
  "auth.not-yet": { class: "ask" },
  "auth.opened": { class: "quiet" },
  "auth.rule": { class: "quiet" },
  "auth.saved": { class: "quiet" },
  "project.archived": { class: "quiet" },
  "project.created": { class: "quiet" },
  "project.deleted": { class: "quiet" },
  "project.opened": { class: "quiet" },
  "recording.requested": { class: "quiet" },
  "qa.applying": { class: "quiet" },
  "qa.applied": { class: "quiet" },
  "qa.pending": { class: "quiet" },
  "qa.asked": { class: "quiet" },
  "qa.decided": { class: "quiet" },
  "qa.proposed": { class: "run-and-tell", tab: "render" },
  // a question the Director asks you, and your answer or dismissal (D140): part of asking you, never a notification of its own
  "question.answered": { class: "ask" },
  "question.asked": { class: "ask" },
  "question.cancelled": { class: "ask" },
  "render.approved": { class: "quiet" },
  "render.deleted": { class: "quiet" },
  "render.finished": { class: "run-and-tell", tab: "render" },
  "render.progress": { class: "progress" },
  // the QA that runs by itself after a final; your own confirm or ignore is a note of yours
  "render.qa": {
    class: "run-and-tell",
    tab: "render",
    when: (e) => !e.data?.ignore && !e.data?.reason,
  },
  "render.started": { class: "progress" },
  "render.zipped": { class: "quiet" },
  "review.submitted": { class: "quiet" },
  "review.updated": { class: "quiet" },
  "stage.unaccepted": { class: "quiet" },
  "storyboard.approved": { class: "quiet" },
  "storyboard.written": { class: "run-and-tell", tab: "storyboard" },
  "take.accepted": { class: "quiet" },
  "take.analyzed": { class: "run-and-tell", tab: "recording" },
  "take.analyzing": { class: "progress" },
  "take.event": { class: "progress" },
  "take.noted": { class: "quiet" },
  "take.finished": { class: "run-and-tell", tab: "recording" },
  "take.progress": { class: "progress" },
  "take.proposed": { class: "run-and-tell", tab: "recording" },
  "take.started": { class: "progress" },
  "tts.finished": { class: "run-and-tell", tab: "voice" },
  "tts.progress": { class: "progress" },
  "tts.started": { class: "progress" },
  "vo.approved": { class: "quiet" },
  "vo.direction": { class: "quiet" },
  "vo.written": { class: "run-and-tell", tab: "voice", when: notMine },
};

export const STEP_CLASSES = ["ask", "run-and-tell", "progress", "alert", "quiet"];

/** The step an event belongs to, or undefined when `when` rules it out (then it is not news). */
export function stepOf(e) {
  const s = STEPS[e.type];
  if (!s) return undefined;
  if (s.when && !s.when(e)) return { ...s, class: "quiet", tab: undefined };
  // a job that failed or was cancelled is not a result: the strip and the band already say so (UX2), a toast would only repeat it
  if (s.class === "run-and-tell" && ["failed", "cancelled"].includes(e.data?.status))
    return { ...s, class: "quiet", tab: undefined };
  return typeof s.tab === "function" ? { ...s, tab: s.tab(e) } : s;
}
