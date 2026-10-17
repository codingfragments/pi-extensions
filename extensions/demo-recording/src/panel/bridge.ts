/**
 * Panel → pi session bridge (IMPLEMENTATION_PLAN §4). Panel actions are
 * persisted to state.json first, then summarized into one user message for
 * the director. Message formatting is pure (unit-tested).
 */

import type { Storyboard } from "../storyboard/types.ts";
import type { StoryboardReview } from "../workdir/state.ts";

export const PANEL_PREFIX = "[demo-panel]";

const LABEL = { approved: "APPROVED", changes: "CHANGES", rerun: "RE-RUN" } as const;

export function reviewMessage(
  project: string,
  storyboard: Storyboard,
  review: StoryboardReview,
): string {
  const lines = [
    `${PANEL_PREFIX} Storyboard v${storyboard.version} review for project "${project}":`,
  ];
  for (const scene of storyboard.scenes) {
    const r = review.scenes[scene.id];
    if (!r) continue;
    lines.push(
      `- ${scene.id} (${scene.title}): ${LABEL[r.status]}${r.note ? ` — "${r.note}"` : ""}`,
    );
  }
  const unreviewed = storyboard.scenes.filter((s) => !review.scenes[s.id]).map((s) => s.id);
  if (unreviewed.length)
    lines.push(
      `- not reviewed: ${unreviewed.join(", ")} (keep as is unless the notes imply otherwise)`,
    );
  if (review.note) lines.push(`Overall note: "${review.note}"`);
  const needsWork =
    Object.values(review.scenes).some((r) => r.status !== "approved") || !!review.note;
  lines.push(
    needsWork
      ? `Address CHANGES in the storyboard; for RE-RUN scenes re-explore that part of the app with demo_rec_browser first. Then write v${storyboard.version + 1} with demo_rec_storyboard and summarize what changed.`
      : "All reviewed scenes are approved. The user still has to approve the storyboard as a whole in the panel before recording.",
  );
  return lines.join("\n");
}

export function approvalMessage(
  project: string,
  artifact: "storyboard" | "vo" | "recording" | "annotations" | "render",
  version: number,
): string {
  if (artifact === "render")
    return `${PANEL_PREFIX} Final render v${version} for project "${project}" is ACCEPTED by the user as the deliverable (Render tab). Tell them where the files are (demo_rec_render action=list); nothing else to do unless they ask.`;
  if (artifact === "annotations")
    return `${PANEL_PREFIX} Annotations v${version} for project "${project}" are ACCEPTED by the user (Annotations tab). A final render is now possible: offer it (demo_rec_render action=start kind=final annotations=${version}; ask which brands and whether to burn in subtitles) — or the user renders it in the Render tab.`;
  if (artifact === "recording")
    return `${PANEL_PREFIX} Recording take-${String(version).padStart(3, "0")} for project "${project}" is ACCEPTED by the user (Recording tab). Write the voice-over for this take (demo-voiceover skill), then stop and wait for their review.`;
  return artifact === "storyboard"
    ? `${PANEL_PREFIX} Storyboard v${version} for project "${project}" is APPROVED by the user (a valid input to build on). Recording is unlocked: demo_rec_record storyboard=${version} asks the user to allow it (it uses recording time and model calls); call it, tell them what you are waiting for, and stop until they answer.`
    : `${PANEL_PREFIX} Voice-over script v${version} for project "${project}" is APPROVED by the user (a valid input to build on). Voice synthesis is unlocked: demo_rec_tts version=${version} asks the user to allow it (it bills voice credits, the estimate is shown); call it, tell them what you are waiting for, and stop until they answer.`;
}

export function voReviewMessage(
  project: string,
  version: number,
  sections: string[],
  review: StoryboardReview,
): string {
  const lines = [`${PANEL_PREFIX} Voice-over v${version} review for project "${project}":`];
  for (const key of sections) {
    const r = review.scenes[key];
    if (r) lines.push(`- ${key}: ${LABEL[r.status]}${r.note ? ` — "${r.note}"` : ""}`);
  }
  const unreviewed = sections.filter((k) => !review.scenes[k]);
  if (unreviewed.length)
    lines.push(
      `- not reviewed: ${unreviewed.join(", ")} (keep as is unless the notes imply otherwise)`,
    );
  if (review.note) lines.push(`Overall note: "${review.note}"`);
  const needsWork =
    Object.values(review.scenes).some((r) => r.status !== "approved") || !!review.note;
  lines.push(
    needsWork
      ? `Rewrite the CHANGES sections (keep approved ones verbatim); for RE-RUN sections re-read that scene in demo_rec_take analyze first. Then write v${version + 1} with demo_rec_vo and summarize what changed.`
      : "All reviewed sections are approved. The user still has to approve the voice-over as a whole in the panel before voice synthesis.",
  );
  return lines.join("\n");
}
