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
  /**
   * The director's intent for this moment, free text (S5 part 6, D32), e.g.
   * "the EMEA outlier is the story". Annotations are chosen later, in the
   * Annotations stage; this is only a hint for the annotation designer.
   */
  emphasis?: string;
  /** @deprecated Legacy flag (D14): parsed and converted into an `emphasis` hint ("suggest a zoom here"). */
  zoom?: boolean;
  /** @deprecated Legacy flag (D14): parsed and converted into an `emphasis` hint (suggested callout text). */
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
      /** Typed if the model is unavailable or too slow (else the scene fails and is retried). */
      fallback?: string;
      /** Send the screenshot too (slower; for charts/canvas the aria digest can't describe). */
      vision?: boolean;
    });

export type StepKind = Step["do"];

export interface Scene {
  id: string;
  title: string;
  takeaway?: string;
  /** The director's intent for the whole scene (D32), e.g. "show that search is name-only". */
  emphasis?: string;
  deep_link?: string;
  /** Discovery screenshot id (`<session>/sNNN`) used as the scene thumbnail in the panel. */
  screen?: string;
  /** Talking points for the VO (the VO itself is written from the take in S4). */
  narration_outline?: string[];
  /** Findings this scene covers (S5 part 5a): every "use" finding must be covered by a scene. */
  findings?: string[];
  /** S1 only: draft narration for the naive `say` mux. Replaced by the VO script in S4. */
  narration?: string;
  steps: Step[];
}

export interface Storyboard {
  version: number;
  app?: string;
  /** Short demo title for the title card (≤ 60 chars), e.g. "What KeyCraft gets right — and what it makes up". */
  title?: string;
  /** One-paragraph pitch of the whole demo (shown at the top of the review). */
  summary?: string;
  start_url: string;
  scenes: Scene[];
}
