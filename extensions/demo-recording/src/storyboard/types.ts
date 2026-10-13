/**
 * Storyboard types (IMPLEMENTATION_PLAN §3.2). S1 implements the step subset
 * needed for the walking skeleton; S2 replaces the hand-written validator with
 * a typebox schema and adds `improvise`, `scroll`, `zoom`/`callout`, etc.
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
}

export type Step =
  | (StepBase & { do: "goto"; url: string })
  | (StepBase & { do: "move"; target: Target })
  | (StepBase & { do: "hover"; target: Target })
  | (StepBase & { do: "click"; target: Target })
  | (StepBase & { do: "type"; target?: Target; text: string; clear?: boolean })
  | (StepBase & { do: "press"; key: string })
  | (StepBase & { do: "wait"; for: WaitFor; timeout: number })
  | (StepBase & { do: "pause"; ms: number });

export interface Scene {
  id: string;
  title: string;
  takeaway?: string;
  deep_link?: string;
  /** S1 only: draft narration for the naive `say` mux. Replaced by the VO script in S4. */
  narration?: string;
  steps: Step[];
}

export interface Storyboard {
  version: number;
  app?: string;
  start_url: string;
  scenes: Scene[];
}
