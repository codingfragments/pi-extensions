/**
 * Words for what the Director is doing (P1a A2, docs/DIRECTOR_STATE.md): a task label from what started the run and a step
 * label from the tool in flight. Pure, so the panel and the log say the same thing and a test can pin them.
 */

import type { Stage } from "../workdir/stages.ts";

/** Strip a known prefix and keep the first sentence, short. */
function gist(text: string, max = 90): string {
  const t = (text.split("\n").find((line) => line.trim()) ?? "")
    .replace(/^\[(demo-panel|demo-recording)\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

const APPROVED_WORD: [RegExp, string][] = [
  [/^Storyboard/, "the storyboard"],
  [/^Voice-over/, "the voice-over"],
  [/^Recording/, "the recording"],
  [/^Annotations/, "the annotations"],
  [/^Final render/, "the final render"],
];

/**
 * What a run is about. `input` is the text as it was sent (before a skill is expanded into a long prompt), `custom` the
 * content of a custom message (a job report) that started the run.
 */
export function taskLabel(o: { input?: string; prompt?: string; custom?: string }): {
  label: string;
  by: "you" | "panel" | "report";
} {
  if (o.custom !== undefined)
    return { label: `Reading the report: ${gist(o.custom)}`, by: "report" };
  const text = (o.input ?? o.prompt ?? "").trim();
  const skill = /^\/skill:([a-z-]+)\s*(.*)$/s.exec(text);
  if (skill) {
    const label =
      skill[1] === "demo-voiceover"
        ? "Analyzing the take and writing the voice-over"
        : skill[1] === "demo-brief"
          ? "Drafting the brief with you"
          : skill[1] === "demo-annotations"
            ? "Suggesting annotations"
            : /discover/i.test(skill[2] ?? "")
              ? "Exploring the app"
              : "Working on the demo";
    return { label, by: "you" };
  }
  const panel = /^\[(demo-panel|demo-recording)\]\s*(.*)$/s.exec(text);
  if (panel) {
    const body = panel[2] ?? "";
    const storyboardReview = /^Storyboard v(\d+) review/.exec(body);
    if (storyboardReview)
      return {
        label: `Revising the storyboard from your review of v${storyboardReview[1]}`,
        by: "panel",
      };
    const voReview = /^Voice-over v(\d+) review/.exec(body);
    if (voReview)
      return { label: `Revising the voice-over from your review of v${voReview[1]}`, by: "panel" };
    if (/\b(APPROVED|ACCEPTED)\b by the user/.test(body)) {
      const what = APPROVED_WORD.find(([re]) => re.test(body))?.[1] ?? "your approval";
      return { label: `Continuing after you approved ${what}`, by: "panel" };
    }
    if (/ACCEPTED \d+ fix proposals? for the .* and asks you to APPLY/.test(body)) {
      const stage = /for the ([a-z -]+) \(fix set/.exec(body)?.[1] ?? "draft";
      return { label: `Writing the ${stage} draft from the fixes you accepted`, by: "panel" };
    }
    if (/asks for suggested fixes/.test(body))
      return {
        label: /ask you to rethink/.test(body)
          ? "Rethinking the QA fixes with your context"
          : "Proposing fixes for the QA findings you flagged",
        by: "panel",
      };
    if (/asks for a new take/.test(body))
      return { label: "Recording a new take for you", by: "panel" };
    if (/^The user ALLOWED/.test(body))
      return { label: "Going on with what you allowed", by: "panel" };
    if (/did NOT allow/.test(body))
      return { label: "Noting that you did not allow it", by: "panel" };
    if (/voice direction|Direction/i.test(body))
      return { label: "Rewriting the voice-over from your direction", by: "panel" };
    if (/annotation/i.test(body) && /instructions|suggest/i.test(body))
      return { label: "Suggesting annotations again", by: "panel" };
    return { label: gist(body), by: "panel" };
  }
  const typed = gist(text, 60);
  return { label: typed ? `Answering you: “${typed}”` : "Answering you", by: "you" };
}

const TOOL: Record<string, (a: Record<string, unknown>) => { label: string; stage?: Stage }> = {
  demo_rec_browser: () => ({ label: "Exploring the app", stage: "storyboard" }),
  demo_rec_storyboard: (a) => ({
    label: a.action === "get" ? "Reading the storyboard" : "Writing the storyboard",
    stage: "storyboard",
  }),
  demo_rec_record: (a) => ({
    label:
      a.action === "status" || a.action === "cancel"
        ? "Checking the recording"
        : "Starting the recording",
    stage: "recording",
  }),
  demo_rec_take: (a) => ({
    label:
      a.action === "analyze"
        ? "Analyzing the take"
        : a.action === "propose"
          ? "Suggesting the take for your approval"
          : "Looking at the takes",
    stage: "recording",
  }),
  demo_rec_vo: (a) => ({
    label:
      a.action === "write"
        ? "Writing the voice-over"
        : a.action === "template"
          ? "Preparing the voice-over"
          : "Reading the voice-over",
    stage: "vo",
  }),
  demo_rec_tts: (a) => ({
    label:
      a.action === "check" || a.action === "voices"
        ? "Checking the voice setup"
        : "Asking to synthesize the voice",
    stage: "vo",
  }),
  demo_rec_edit: () => ({ label: "Editing the take to the voice", stage: "vo" }),
  demo_rec_annotations: (a) => ({
    label:
      a.action === "suggest" || a.action === "write"
        ? "Placing annotations"
        : "Reading what the annotations need",
    stage: "annotations",
  }),
  demo_rec_render: (a) => ({
    label: a.action === "start" ? "Starting a render" : "Reading the renders",
    stage: "render",
  }),
  demo_rec_project: (a) => ({
    label:
      a.action === "write_brief"
        ? "Writing the brief"
        : a.action === "note" || a.action === "finding" || a.action === "mark_finding"
          ? "Noting it in the project"
          : "Reading the project",
  }),
  demo_rec_qa: (a) =>
    a.action === "resolve"
      ? { label: "Settling a pending fix" }
      : a.action === "pending"
        ? { label: "Reading the pending fixes" }
        : {
            label:
              a.action === "propose" ? "Proposing fixes" : "Reading the QA findings you flagged",
            stage: "render",
          },
  demo_rec_compare: (a) => ({
    label: a.action === "answer" ? "Writing the verdict" : "Reading the facts of the two versions",
  }),
  demo_rec_discovery: (a) => ({
    label: a.action === "report" ? "Writing the discovery report" : "Reading what discovery found",
  }),
  demo_rec_config: () => ({ label: "Checking the settings" }),
  demo_rec_brand: () => ({ label: "Working on the brand" }),
};

/** What a tool call is, in words, and the stage it concerns (for the stepper). */
export function stepLabel(tool: string, args: unknown): { label: string; stage?: Stage } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const f = TOOL[tool];
  return f ? f(a) : { label: `Using ${tool}` };
}
