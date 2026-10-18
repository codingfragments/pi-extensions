/**
 * Hook the Director's state to pi's events (P1a A2). Cheap, and never allowed to throw into pi: the panel's picture of the
 * Director must never break a run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";

export function registerDirectorWatch(pi: ExtensionAPI, rt: Runtime): void {
  const watch = <E>(name: string, f: (e: E) => void) =>
    // biome-ignore lint/suspicious/noExplicitAny: pi's event-name union is wider than the events we list
    (pi as any).on(name, async (e: E) => {
      try {
        f(e);
      } catch {
        // see above
      }
    });
  const d = rt.director;
  watch("input", (e: Parameters<typeof d.onInput>[0]) => d.onInput(e));
  watch("before_agent_start", (e: Parameters<typeof d.onRunStart>[0]) => d.onRunStart(e));
  watch("tool_execution_start", (e: Parameters<typeof d.onToolStart>[0]) => d.onToolStart(e));
  watch("tool_execution_end", (e: Parameters<typeof d.onToolEnd>[0]) => d.onToolEnd(e));
  watch("agent_settled", (e: Parameters<typeof d.onSettled>[0]) => d.onSettled(e));
}
