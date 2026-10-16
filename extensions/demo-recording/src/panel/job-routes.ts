/**
 * The engine's job table for the panel (UX2): what is running and what recently failed, from the
 * real jobs, not from replayed events. The status strip, the stepper and the Activity drawer read it.
 */

import type { Runtime } from "../runtime.ts";
import type { GetRoute } from "./server.ts";

export interface JobView {
  id: string;
  kind: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

/** Recent jobs of the active project, newest first (at most 20). */
export function jobRoutes(rt: Runtime): { get: Record<string, GetRoute> } {
  return {
    get: {
      jobs: () => {
        const p = rt.activeProject();
        if (!p) return { project: null, jobs: [] as JobView[] };
        return {
          project: p.slug,
          jobs: rt.jobs
            .list(p.slug)
            .slice(0, 20)
            .map(
              (j): JobView => ({
                id: j.id,
                kind: j.kind,
                status: j.status,
                startedAt: j.startedAt,
                finishedAt: j.finishedAt ?? null,
                error: j.error ?? null,
              }),
            ),
        };
      },
    },
  };
}
