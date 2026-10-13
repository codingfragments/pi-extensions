/**
 * Storyboard types (IMPLEMENTATION_PLAN §3.2).
 *
 * S2 adds the authoring fields the director writes during discovery
 * (narration_outline, takeaway, screen thumbnail) and the step kinds/flags the
 * later slices execute: `scroll` (S2), `improvise` (validated now, recorded
 * from S3), `zoom`/`callout` flags (rendered in S5).
 */

export type Target =
  | { role: string; name?: string; exact?: boolean }
  | { text: string; exact?: boolean }
  | { label: string }
  | { css: string };

export type WaitFor = Target | { ms: number };

interface StepBase {
  /** Anchor name for the VO (`[@mark]`) — logged on the step's key event. */
  mark?: string;
  /** Pause after the step completes (ms). */
  dwell?: number;
  /** Auto-zoom on this step's target in the final render (S5, D14: opt-in). */
  zoom?: boolean;
  /** Step callout caption in the final render (S5, D14). */
  callout?: string;
}

export type Step =
  | (StepBase & { do: "goto"; url: string })
  | (StepBase & { do: "move"; target: Target })
  | (StepBase & { do: "hover"; target: Target })
  | (StepBase & { do: "click"; target: Target })
  | (StepBase & { do: "type"; target?: Target; text: string; clear?: boolean })
  | (StepBase & { do: "press"; key: string })
  | (StepBase & { do: "wait"; for: WaitFor; timeout: number })
  | (StepBase & { do: "pause"; ms: number })
  | (StepBase & { do: "scroll"; target?: Target; dy?: number })
  | (StepBase & {
      do: "improvise";
      kind: "type";
      target: Target;
      /** What to invent, given the live screen (e.g. "a sharp follow-up question"). */
      prompt: string;
      max_chars: number;
      submit: boolean;
    });

export type StepKind = Step["do"];

export interface Scene {
  id: string;
  title: string;
  takeaway?: string;
  deep_link?: string;
  /** Discovery screenshot id (`<session>/sNNN`) used as the scene thumbnail in the panel. */
  screen?: string;
  /** Talking points for the VO (the VO itself is written from the take in S4). */
  narration_outline?: string[];
  /** S1 only: draft narration for the naive `say` mux. Replaced by the VO script in S4. */
  narration?: string;
  steps: Step[];
}

export interface Storyboard {
  version: number;
  app?: string;
  /** One-paragraph pitch of the whole demo (shown at the top of the review). */
  summary?: string;
  start_url: string;
  scenes: Scene[];
}
