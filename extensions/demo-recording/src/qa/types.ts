/**
 * QA report types (S5 part 10, D69–D75).
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
  check: QaCheck;
  level: QaLevel;
  scene?: string;
  /** Full-video time (ms) — the panel seeks the player there. */
  atMs?: number;
  message: string;
  fix?: QaFix;
  /** "Confirm & export anyway" (D73). */
  confirmed?: { at: string; reason: string };
}

export interface QaReport {
  render: number;
  /** The variant the media checks ran on (content is the same in every variant). */
  variant: string;
  createdAt: string;
  whisper: boolean;
  items: QaItem[];
}

export type QaStatus = "pass" | "blocked" | "confirmed" | "error";

export interface QaSummary {
  status: QaStatus;
  blocking: number;
  confirmed: number;
  warnings: number;
  info: number;
  ranAt: string;
  error?: string;
}
