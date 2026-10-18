/**
 * QA report types (S5 part 10, D69–D75).
 */

/**
 * `blocking` is a HARD STOP and nothing else (P1a Q1a, D-QA-1): an integrity defect of the files (no or silent
 * audio, a truncated video, a listed file missing) or a redaction that does not cover its element. Everything
 * else is a report: `warning` (with `high` for what needs your eyes first) and `info`.
 */
export type QaLevel = "blocking" | "warning" | "info";
export type QaCheck = "values" | "footage" | "drift" | "media" | "annotations";

/** A mechanical fix (D74): move one narration segment so it lands on its moment. */
export interface QaFix {
  kind: "shift-narration";
  scene: string;
  /** The segment's anchor mark ("" = the scene's opening segment). */
  anchor: string;
  deltaMs: number;
  label: string;
}

export interface QaItem {
  id: string;
  /** Which stage version this finding is about (P1a Q1b: a finding names its stage, not only a render). Set when the report is written. */
  stage?: "storyboard" | "recording" | "vo" | "annotations" | "render";
  version?: number;
  check: QaCheck;
  level: QaLevel;
  scene?: string;
  /** Full-video time (ms) — the panel seeks the player there. */
  atMs?: number;
  message: string;
  /** Why a `blocking` item is a hard stop: the files are broken (re-render), or a redaction leaks. */
  hard?: "integrity" | "redaction";
  /** A warning that needs your eyes first (a wrong number, a toast in the footage, a narration far off its moment). */
  high?: true;
  /** One item standing for several moments (collapsed noise): where each is, for the player. */
  moments?: number[];
  fix?: QaFix;
  /** "Confirm & export anyway" (D73). */
  confirmed?: { at: string; reason: string };
}

/**
 * What the drift check saw at one anchor (P1a Q0): the measurement beside the edit's plan, so a
 * disagreement can be traced instead of guessed at. Times are ms in the full video.
 */
export interface AnchorDiag {
  scene: string;
  mark: string;
  /** Where the picture's event is: scene start + the anchor's output time. */
  eventMs: number;
  /** Where the edit put the anchored narration: scene start + the plan's audio time. */
  plannedAudioMs: number;
  /** What the edit planned: audio time − event time (positive = late). */
  plannedDriftMs: number;
  /** The same, from the edit's own timeline before any render override. Differs when overrides moved the narration. */
  editDriftMs: number;
  /**
   * Was the measurement on a speech onset (the word start itself, or the onset the check found around it)?
   * Only then is a fix offered: a number that is not on an onset is a "not measured", never something to act on.
   */
  supported?: boolean;
  /** The first words of the anchored segment, as searched in the transcript. */
  words: string[];
  /** Transcript matches of those words within 3 s of the event. */
  matches: number;
  /** The words the transcript has around the match, with times. */
  heard: [string, number][];
  /** Where the transcript puts the narration (undefined: not found). */
  rawMeasuredMs?: number;
  /** The same, snapped to the audio onset: what the check uses. */
  measuredMs?: number;
  /** What the check reports: measured − event (positive = late). */
  measuredDriftMs?: number;
  /** measured − planned audio: how far the rendered audio is from where the plan put it. Should be near zero. */
  gapMs?: number;
  /**
   * A second, independent look at the rendered audio (a speech onset is a rise out of at least 150 ms of quiet).
   * Is the transcript's word start on an onset (within 100 ms)? A word start in the middle of a pause is a
   * transcript that stretched the word over the pause: it cannot be trusted.
   */
  transcriptOnOnset?: boolean;
  /** An onset within 150 ms of where the plan put the narration: the audio has speech starting there. */
  onsetAtPlanMs?: number;
}

export interface QaDiagnostics {
  anchors: AnchorDiag[];
  /** The full-video start of every scene, as the check used it. */
  sceneStart: Record<string, number>;
  titleMs: number;
  /** The transcript the measurement came from: [word, start ms]. */
  heard: [string, number][];
}

export interface QaReport {
  render: number;
  /** The variant the media checks ran on (content is the same in every variant). */
  variant: string;
  createdAt: string;
  whisper: boolean;
  items: QaItem[];
  /** What the drift check measured (P1a Q0); absent in reports made before it. */
  diagnostics?: QaDiagnostics;
  /** The stage version these findings belong to (P1a Q1b); `render` and `version` are the same for a render's QA. */
  stage?: "render";
  version?: number;
  /** How much of the narration was actually measured: N of M anchors were found in the transcript. */
  coverage?: { anchors: { measured: number; total: number } };
}

export type QaStatus = "pass" | "blocked" | "confirmed" | "error";

export interface QaSummary {
  status: QaStatus;
  /** Hard stops (the name stays for older records). */
  blocking: number;
  confirmed: number;
  /** Warnings that need your eyes first (a subset of `warnings`). */
  high?: number;
  warnings: number;
  info: number;
  ranAt: string;
  error?: string;
}
