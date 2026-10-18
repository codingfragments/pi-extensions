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

/** The parts of a finding that stay the same across renders; `sameFinding` compares them (identity.ts). */
export interface FindingIdentity {
  /** The anchor mark of the narration it is about. */
  anchor?: string;
  /** The first words of that anchored phrase: finds it again when the mark was renamed. */
  phrase?: string[];
  /** A value (normalised number or lower-case name) the narration says. */
  value?: string;
  /** What a toast or console error says, normalised. */
  text?: string;
  /** A kind of media finding: still, pause, black. */
  kind?: string;
  /** Where it is inside its scene (ms), for findings with no anchor. */
  relMs?: number;
  /** An annotation id or a layout reference (redactions, privacy hits). */
  ref?: string;
}

export type IgnoreScope = "finding" | "scene" | "project";

/**
 * A fix you accepted that belongs to a LATER stage than the one being changed now (P1c Q4, D-QA-9): the project remembers it so the
 * stage's writer reads it when its turn comes (Q5). Plain text first, structure second: it is memory the Director reads, not a to-do list
 * the engine runs. `stale` means the problem no longer exists after an earlier change.
 */
export interface PendingFix {
  id: string;
  /** The stage it is for. */
  stage: "discovery" | "storyboard" | "recording" | "vo" | "annotations" | "render";
  /** What to do, in a sentence or two (the proposal's title and the change, or your wording of it). */
  text: string;
  /** Your note on the proposal, when you wrote one. */
  guidance?: string;
  /** Where it came from. */
  fixset: string;
  render: number;
  /** The findings it answers: id, the message as it was, and what the finding is (so it can be recognised again). */
  findings: {
    id: string;
    message: string;
    check: QaCheck;
    scene?: string;
    identity?: FindingIdentity;
  }[];
  status: "open" | "applied" | "dropped" | "superseded" | "stale";
  createdAt: string;
  /** Why it was applied, dropped or went stale. */
  resolvedWhy?: string;
  /** Who resolved it, when, and (applied) in which version of its stage. */
  resolvedBy?: "agent" | "user";
  resolvedAt?: string;
  version?: number;
}

/**
 * Something you decided to leave alone, remembered in the project (P1a Q2, D-QA-3). It covers a finding by what it
 * is, not by its numbers, survives re-renders of the same content, and ends when that content changes.
 */
export interface QaIgnore {
  id: string;
  scope: IgnoreScope;
  check: QaCheck;
  /** For a redaction rule: the hard-stop kind it covers. */
  hard?: "integrity" | "redaction";
  /** Which kind of finding of that check (still, pause, black, …), so "this check" is not every finding of it. */
  kind?: string;
  /** The scene (finding and scene scope). */
  scene?: string;
  /** The finding as it was when you ignored it (finding scope). */
  finding?: { identity: FindingIdentity; message: string };
  /** What it was true for: the scene's narration, or the take. A different one ends the ignore. */
  contentKey?: string;
  reason: string;
  createdAt: string;
  /** The render you ignored it in. */
  renderVersion: number;
  by: "panel" | "cli";
  endedAt?: string;
  endedWhy?: string;
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
  /** What makes this the same finding in the next render, whatever its numbers do (P1a Q2, D-QA-3). */
  identity?: FindingIdentity;
  /** Set when an ignore of yours covers it: it stays in the report, out of the counts. */
  ignored?: { id: string; scope: IgnoreScope; reason: string; since: number };
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
  /** Findings an ignore of yours covers: in the report, out of every count above and below. */
  ignored?: number;
  confirmed: number;
  /** Warnings that need your eyes first (a subset of `warnings`). */
  high?: number;
  warnings: number;
  info: number;
  ranAt: string;
  error?: string;
}
