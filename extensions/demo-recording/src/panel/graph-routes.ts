/**
 * `GET /api/graph` (UX4, D113): the project's versions and how they depend on each other, read-only and
 * computed from the files (src/graph/build.ts). A GET with no side effect: no cost class applies.
 */

import { projectGraph } from "../graph/build.ts";
import type { Runtime } from "../runtime.ts";
import { readState } from "../workdir/state.ts";
import type { GetRoute } from "./server.ts";

export function graphRoutes(rt: Runtime): { get: Record<string, GetRoute> } {
  return {
    get: {
      graph: () => {
        const p = rt.activeProject();
        if (!p) return { project: null };
        return projectGraph(p.dir, p.slug, readState(p.dir) ?? p.state);
      },
    },
  };
}
