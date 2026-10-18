export type StepClass = "ask" | "run-and-tell" | "progress" | "alert" | "quiet";
export interface StepRule {
  class: StepClass;
  tab?: string;
  when?: (e: {
    data?: { by?: string; ignore?: unknown; reason?: unknown; status?: string };
  }) => boolean;
}
export const STEPS: Record<string, StepRule>;
export const STEP_CLASSES: StepClass[];
export function stepOf(e: {
  type: string;
  data?: { by?: string; ignore?: unknown; reason?: unknown; status?: string };
}): StepRule | undefined;
