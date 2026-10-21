/**
 * Asking the Director to start or enhance a discovery (item 10, D1): the one place that stores the request, writes it to the project's history, tells the panel and wakes
 * the Director. The Project page's Start / Enhance window and the "Start discovery now?" question after a login both come here.
 */

import fs from "node:fs";
import path from "node:path";
import { PANEL_PREFIX, reportAs } from "../roles.ts";
import type { Runtime } from "../runtime.ts";
import { listFindings } from "../workdir/findings.ts";
import { recordInput } from "../workdir/inputs.ts";
import { appDir } from "../workdir/layout.ts";
import { type DiscoveryRequest, addRequest, checkBudget, requestMessage } from "./requests.ts";
import { listSessions } from "./state.ts";

/** The brief still has fields nobody filled in (`_TODO_`). */
function briefIsDraft(projectDir: string): boolean {
  try {
    return /_TODO_/.test(fs.readFileSync(path.join(projectDir, "brief.md"), "utf8"));
  } catch {
    return false;
  }
}

export interface StartRequest {
  mode: "start" | "enhance";
  notes?: unknown;
  areas?: unknown;
  budget: unknown;
  preset?: unknown;
  base?: string;
  /** Show the browser window in front and keep it open afterwards. */
  headed?: boolean;
  /** Where the request came from: the panel, or the chat (a typed answer). */
  by?: "panel" | "chat";
}

/** Refuse when a session is open; store the request, record it, tell the panel, wake the Director. Returns the request. */
export function requestDiscovery(rt: Runtime, body: StartRequest): DiscoveryRequest {
  const p = rt.requireProject();
  const cfg = rt.getConfig();
  const app = appDir(cfg.root, p.app.slug);
  if (rt.discovery && !rt.discovery.isClosed)
    throw new Error(
      "a discovery session is running: wait for it to finish, or ask the Director to close it",
    );
  const sessions = listSessions(app, p.dir);
  if (body.mode === "enhance" && !sessions.length)
    throw new Error("there is no earlier discovery to enhance: start one first");
  const budget = checkBudget(body.budget);
  const base =
    body.mode === "enhance"
      ? typeof body.base === "string" && sessions.some((s) => s.id === body.base)
        ? body.base
        : sessions.at(-1)?.id
      : undefined;
  const req = addRequest(p.dir, {
    mode: body.mode,
    notes: body.notes,
    areas: body.areas,
    budget,
    preset: body.preset,
    ...(base ? { base } : {}),
    ...(body.headed ? { headed: true } : {}),
  });
  const by = body.by ?? "panel";
  recordInput(p.dir, {
    stage: "discovery",
    source: by,
    kind: "direction",
    text: `${body.mode === "enhance" ? "enhance discovery" : "start discovery"} (${budget.discoveryScreens} screens, ${budget.discoveryActions} actions, ${budget.discoveryMinutes} min${req.preset === "custom" ? "" : `, ${req.preset}`})${req.notes ? `: ${req.notes}` : ""}${req.areas.length ? ` · areas: ${req.areas.join("; ")}` : ""}`,
  });
  rt.bus.publish(
    "discovery.requested",
    {
      request: req.id,
      mode: body.mode,
      by,
      budget,
      message: `${body.mode === "enhance" ? "asked the Director to enhance discovery" : "asked the Director to start discovery"} (${budget.discoveryScreens} screens, ${budget.discoveryActions} actions, ${budget.discoveryMinutes} min)`,
    },
    p.slug,
  );
  const findings = listFindings(p.dir, { appDir: app }).filter(
    (f) => f.stage === "discovery",
  ).length;
  rt.notifyAgent(
    requestMessage(
      by === "chat" ? reportAs("You") : PANEL_PREFIX,
      { slug: p.slug, name: p.app.name ?? p.app.slug, url: p.app.baseUrl },
      req,
      { sessions: sessions.length, findings },
      { briefDraft: briefIsDraft(p.dir) },
    ),
  );
  return req;
}
