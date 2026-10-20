/**
 * Discovery from the Project page (item 10, D1, F1, F5).
 *
 *   GET  /api/discovery           where discovery stands (never run / running / done / budget used / cut off), its sessions with
 *                                 what each used and how it ended, the budget presets, what is waiting for the Director
 *   POST /api/discovery-start     start or enhance: store your request (notes, areas, budget) and send it to the Director
 *                                 (starts a Director turn: model tokens and browser time, no money)
 *   POST /api/discovery-cancel    take back a request the Director has not picked up
 */

import { measureSession } from "../discovery/coverage.ts";
import { uncoveredAreas } from "../discovery/measure.ts";
import {
  PRESETS,
  addRequest,
  cancelRequest,
  checkBudget,
  pendingRequest,
  presetBudgets,
  readRequests,
  requestMessage,
} from "../discovery/requests.ts";
import { discoveryStatus, listSessions } from "../discovery/state.ts";
import type { Runtime } from "../runtime.ts";
import { listFindings } from "../workdir/findings.ts";
import { recordInput } from "../workdir/inputs.ts";
import { appDir } from "../workdir/layout.ts";
import { PANEL_PREFIX } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export function discoveryRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const ctx = () => {
    const p = rt.requireProject();
    const cfg = rt.getConfig();
    const app = appDir(cfg.root, p.app.slug);
    return { p, cfg, app };
  };
  return {
    get: {
      discovery: () => {
        const { p, cfg, app } = ctx();
        const sessions = listSessions(app);
        const running = rt.discovery && !rt.discovery.isClosed ? rt.discovery.id : undefined;
        const last = sessions.at(-1);
        const standard = cfg.budgets;
        return {
          project: p.slug,
          status: discoveryStatus(sessions, running),
          running: running ?? null,
          sessions,
          // what the latest session has actually seen, per area (measured from its action log, so it is live while it runs)
          measure: last ? measureSession(app, last.id) : null,
          uncovered: last ? uncoveredAreas(measureSession(app, last.id)).map((a) => a.name) : [],
          pending: pendingRequest(p.dir) ?? null,
          requests: readRequests(p.dir).slice(-5),
          defaults: standard,
          presets: Object.fromEntries(PRESETS.map((x) => [x, presetBudgets(standard, x)])),
          findings: listFindings(p.dir, { appDir: app }).filter((f) => f.stage === "discovery")
            .length,
          // Extend the budget: the last session ran out, so offer twice what it had (within the caps) as an enhance
          extend: last?.exhausted
            ? { base: last.id, budget: presetBudgets(last.budgets ?? standard, "deep") }
            : null,
        };
      },
    },
    post: {
      "discovery-start": (body) => {
        const { p, cfg, app } = ctx();
        if (rt.discovery && !rt.discovery.isClosed)
          throw new Error(
            "a discovery session is running: wait for it to finish, or ask the Director to close it",
          );
        const sessions = listSessions(app);
        const mode = body.mode === "enhance" ? "enhance" : "start";
        if (mode === "enhance" && !sessions.length)
          throw new Error("there is no earlier discovery to enhance: start one first");
        const budget = checkBudget(body.budget ?? cfg.budgets);
        const base =
          mode === "enhance"
            ? typeof body.base === "string" && sessions.some((s) => s.id === body.base)
              ? body.base
              : sessions.at(-1)?.id
            : undefined;
        const req = addRequest(p.dir, {
          mode,
          notes: body.notes,
          areas: body.areas,
          budget,
          preset: body.preset,
          ...(base ? { base } : {}),
        });
        recordInput(p.dir, {
          stage: "discovery",
          source: "panel",
          kind: "direction",
          text: `${mode === "enhance" ? "enhance discovery" : "start discovery"} (${budget.discoveryScreens} screens, ${budget.discoveryActions} actions, ${budget.discoveryMinutes} min${req.preset === "custom" ? "" : `, ${req.preset}`})${req.notes ? `: ${req.notes}` : ""}${req.areas.length ? ` · areas: ${req.areas.join("; ")}` : ""}`,
        });
        rt.bus.publish(
          "discovery.requested",
          {
            request: req.id,
            mode,
            by: "panel",
            budget,
            message: `${mode === "enhance" ? "asked the Director to enhance discovery" : "asked the Director to start discovery"} (${budget.discoveryScreens} screens, ${budget.discoveryActions} actions, ${budget.discoveryMinutes} min)`,
          },
          p.slug,
        );
        const findings = listFindings(p.dir, { appDir: app }).filter(
          (f) => f.stage === "discovery",
        ).length;
        rt.notifyAgent(
          requestMessage(
            PANEL_PREFIX,
            { slug: p.slug, name: p.app.name ?? p.app.slug, url: p.app.baseUrl },
            req,
            { sessions: sessions.length, findings },
          ),
        );
        return { request: req };
      },
      "discovery-cancel": () => {
        const { p } = ctx();
        const r = cancelRequest(p.dir);
        rt.bus.publish(
          "discovery.cancelled",
          { request: r.id, by: "panel", message: `took back discovery request ${r.id}` },
          p.slug,
        );
        return { request: r };
      },
    },
  };
}
