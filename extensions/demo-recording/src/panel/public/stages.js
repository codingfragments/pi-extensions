import { useApi } from "./core.js";
// demo-recording panel — the stage data every screen reads (/api/stages): the stages with their
// versions, approvals and production line, and the engine's next step. The version summary, the
// History and the version actions are in version-ui.js (UX3); the frame is in frame.js (UX2).

export const STAGE_EVENTS =
  /^(storyboard|vo|take|recording|tts|edit|review|project|brand|config|input|annotations|render|stage|line)\./;

export function useStages(events) {
  return useApi("/api/stages", events, STAGE_EVENTS);
}

export const vLabel = (stage, n) =>
  stage === "recording" ? `take-${String(n).padStart(3, "0")}` : `v${n}`;

export const stageOf = (stages, stage) => stages?.stages?.find((x) => x.stage === stage);
