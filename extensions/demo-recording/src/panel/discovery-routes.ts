/**
 * Discovery from the Project page (item 10, D1, F1, F5).
 *
 *   GET  /api/discovery           where discovery stands (never run / running / done / budget used / cut off), its sessions with
 *                                 what each used and how it ended, the budget presets, what is waiting for the Director
 *   POST /api/discovery-start     start or enhance: store your request (notes, areas, budget) and send it to the Director
 *                                 (starts a Director turn: model tokens and browser time, no money)
 *   POST /api/discovery-cancel    take back a request the Director has not picked up
 *   GET  /api/discovery-report    the discovery report (the newest, or ?version=N) with its versions, and whether newer sessions came after it
 *   POST /api/discovery-report-ask  ask the Director to write or update the report (starts a Director turn: model tokens only)
 */

import fs from "node:fs";
import path from "node:path";
import { measureSession } from "../discovery/coverage.ts";
import { uncoveredAreas } from "../discovery/measure.ts";
import { coverageOf, readReport, reportVersions } from "../discovery/report.ts";
import {
  PRESETS,
  cancelRequest,
  pendingRequest,
  presetBudgets,
  readRequests,
} from "../discovery/requests.ts";
import { forgetDiscovery, forgetPreview } from "../discovery/reset.ts";
import { requestDiscovery } from "../discovery/start.ts";
import { discoveryStatus, listSessions } from "../discovery/state.ts";
import { PANEL_PREFIX } from "../roles.ts";
import type { Runtime } from "../runtime.ts";
import { listFindings } from "../workdir/findings.ts";
import { recordInput } from "../workdir/inputs.ts";
import { appDir } from "../workdir/layout.ts";
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
      "discovery-report": (q) => {
        const { p, app } = ctx();
        const versions = reportVersions(p.dir);
        const asked = q.get("version") ? Number(q.get("version")) : undefined;
        const report = readReport(p.dir, asked) ?? null;
        const sessions = listSessions(app, p.dir);
        const last = report?.coverage.sessions.at(-1)?.id;
        return {
          versions,
          report,
          // sessions that ran after the newest report was written: it does not know about them
          newer:
            report && !asked
              ? sessions
                  .filter((s) => !report.coverage.sessions.some((x) => x.id === s.id))
                  .map((s) => s.id)
              : [],
          basedOn: last ?? null,
          now: coverageOf(p.dir, app),
          canAsk: sessions.length > 0,
        };
      },
      discovery: () => {
        const { p, cfg, app } = ctx();
        const sessions = listSessions(app, p.dir);
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
          briefDraft: (() => {
            try {
              return /_TODO_/.test(fs.readFileSync(path.join(p.dir, "brief.md"), "utf8"));
            } catch {
              return false;
            }
          })(),
          // what "Forget the discovery…" would set aside
          forget: forgetPreview(p.dir, app),
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
        const { cfg } = ctx();
        const mode = body.mode === "enhance" ? "enhance" : "start";
        const req = requestDiscovery(rt, {
          mode,
          notes: body.notes,
          areas: body.areas,
          budget: body.budget ?? cfg.budgets,
          preset: body.preset,
          base: typeof body.base === "string" ? body.base : undefined,
          headed: body.headed === true,
          by: "panel",
        });
        return { request: req };
      },
      "discovery-report-ask": () => {
        const { p, app } = ctx();
        const sessions = listSessions(app, p.dir);
        if (!sessions.length)
          throw new Error("there is no discovery to report on yet: start one first");
        if (rt.discovery && !rt.discovery.isClosed)
          throw new Error("a discovery session is running: the report comes when it has finished");
        const had = readReport(p.dir);
        recordInput(p.dir, {
          stage: "discovery",
          source: "panel",
          kind: "direction",
          text: had
            ? `update the discovery report (v${had.version} is the latest)`
            : "write the discovery report",
        });
        rt.bus.publish(
          "discovery.report-asked",
          {
            by: "panel",
            message: had
              ? `asked the Director to update the discovery report (latest v${had.version})`
              : "asked the Director to write the discovery report",
          },
          p.slug,
        );
        rt.notifyAgent(
          `${PANEL_PREFIX} The user asks you to ${had ? `UPDATE the discovery report of "${p.slug}" (the latest is v${had.version}${sessions.length > had.coverage.sessions.length ? `; there are ${sessions.length - had.coverage.sessions.length} newer session(s) it does not cover` : ""})` : `WRITE the discovery report of "${p.slug}"`}. Call demo_rec_discovery context (what you may cite and the rules), then demo_rec_discovery report; every item must cite evidence that exists. Do not write the storyboard; stop after report.`,
        );
        return { asked: true, latest: had?.version ?? null };
      },
      "discovery-forget": () => {
        const { p, app } = ctx();
        if (rt.discovery && !rt.discovery.isClosed)
          throw new Error(
            "a discovery session is running: wait for it to finish (or ask the Director to close it) before forgetting the discovery",
          );
        if (pendingRequest(p.dir))
          throw new Error(
            "the Director has been asked to start discovery and has not picked it up: take the request back first",
          );
        const rec = forgetDiscovery(p.dir, app);
        const what = `${rec.sessions} session${rec.sessions === 1 ? "" : "s"}, ${rec.findings} finding${rec.findings === 1 ? "" : "s"}${rec.reportVersions ? `, the report (${rec.reportVersions} version${rec.reportVersions === 1 ? "" : "s"})` : ""}`;
        recordInput(p.dir, {
          stage: "discovery",
          source: "panel",
          kind: "direction",
          text: `forgot the discovery so far (${what}); everything was set aside, nothing deleted. Treat the project as never discovered.`,
        });
        rt.bus.publish(
          "discovery.forgotten",
          { ...rec, by: "panel", message: `forgot the discovery so far: ${what} set aside` },
          p.slug,
        );
        rt.tellAgent(
          `${PANEL_PREFIX} The user FORGOT the discovery of "${p.slug}": ${what} were set aside, and the project history of the earlier runs is outdated. Treat the project as never discovered; do not rely on earlier sessions, findings or the report. Nothing else to do until they start discovery again.`,
        );
        return { forgotten: rec };
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
