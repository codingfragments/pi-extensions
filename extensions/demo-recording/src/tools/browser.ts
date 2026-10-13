/**
 * demo_rec_browser — the discovery browser (S2). Vision-first: `look` returns
 * a screenshot (source of truth, D4) plus an aria digest (exact values and
 * role/name targets). `act` drives the virtual cursor behind the safety net.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ActParams, DiscoverySession, type LookResult } from "../discovery/session.ts";
import type { Runtime } from "../runtime.ts";
import { appDir } from "../workdir/layout.ts";
import { setPhase } from "../workdir/state.ts";
import { TargetSchema, type ToolContent, result, text, toTarget } from "./common.ts";

function lookContent(look: LookResult): ToolContent[] {
  const b = look.budget;
  return [
    { type: "image", data: look.jpeg.toString("base64"), mimeType: "image/jpeg" },
    text(
      `screen ${look.screen} — ${look.title} — ${look.url}\n` +
        `budget: screens ${b.screens}, actions ${b.actions}, minutes ${b.minutes}${b.exhausted ? " — EXHAUSTED: write the storyboard now" : ""}\n` +
        `aria digest (use these role/name pairs as targets):\n${look.digest}`,
    ),
  ];
}

export function registerBrowserTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_browser",
    label: "Demo discovery browser",
    description:
      "Discovery browser for demo-recording (phase 1). open: start a session on the active project's app. " +
      "look: screenshot (source of truth) + aria digest with exact values and role/name targets; returns a screen id usable as a storyboard scene thumbnail. " +
      "act: click | hover | type | press | scroll | goto | back | wait, using storyboard target syntax ({role, name} preferred) — every action passes a safety check " +
      "(destructive/financial/sharing actions are blocked; state-changing ones are allowed but audited and shown to the user). " +
      "close: end the session. Budgets for screens/actions/minutes are enforced.",
    parameters: Type.Object({
      action: StringEnum(["open", "look", "act", "close"] as const),
      step: Type.Optional(
        StringEnum(["click", "hover", "type", "press", "scroll", "goto", "back", "wait"] as const, {
          description: "act: what to do",
        }),
      ),
      target: Type.Optional(TargetSchema),
      text: Type.Optional(Type.String({ description: "act type: text to type" })),
      submit: Type.Optional(Type.Boolean({ description: "act type: press Enter afterwards" })),
      clear: Type.Optional(Type.Boolean({ description: "act type: clear the field first" })),
      key: Type.Optional(
        Type.String({ description: "act press: key, e.g. Enter, Escape, ArrowDown" }),
      ),
      dy: Type.Optional(
        Type.Number({
          description:
            "act scroll: pixels (positive = down); omit with a target to scroll it into view",
        }),
      ),
      url: Type.Optional(Type.String({ description: "act goto: absolute or app-relative URL" })),
      ms: Type.Optional(
        Type.Number({ description: "act wait: milliseconds (or timeout when a target is given)" }),
      ),
      look: Type.Optional(
        Type.Boolean({ description: "act: return a fresh look afterwards (default true)" }),
      ),
      full_page: Type.Optional(
        Type.Boolean({ description: "look: capture the full scrollable page" }),
      ),
      headed: Type.Optional(
        Type.Boolean({
          description:
            "open: show the browser window (default headless; the panel shows screenshots)",
        }),
      ),
    }),
    async execute(_id, params) {
      switch (params.action) {
        case "open": {
          const p = rt.requireProject();
          await rt.closeDiscovery();
          const cfg = rt.getConfig();
          const statePath = path.join(appDir(cfg.root, p.app.slug), "auth", "state.json");
          rt.discovery = await DiscoverySession.open({
            root: cfg.root,
            app: p.app,
            viewport: { width: cfg.viewport.width, height: cfg.viewport.height },
            budgets: cfg.budgets,
            bus: rt.bus,
            project: p.slug,
            ...(params.headed ? { headed: true } : {}),
            ...(fs.existsSync(statePath) ? { storageState: statePath } : {}),
          });
          if (p.state.phase === "brief") setPhase(p.dir, "discovery");
          await rt.ensurePanel();
          const look = await rt.discovery.look();
          return result(
            [
              text(`discovery session ${rt.discovery.id} opened on ${p.app.baseUrl}`),
              ...lookContent(look),
            ],
            {
              session: rt.discovery.id,
            },
          );
        }
        case "look": {
          const d = requireSession(rt);
          return result(lookContent(await d.look(params.full_page ? { fullPage: true } : {})));
        }
        case "act": {
          const d = requireSession(rt);
          if (!params.step)
            throw new Error(
              "act needs step (click | hover | type | press | scroll | goto | back | wait)",
            );
          const target = toTarget(params.target);
          const act: ActParams = { action: params.step };
          if (target) act.target = target;
          if (params.text !== undefined) act.text = params.text;
          if (params.submit !== undefined) act.submit = params.submit;
          if (params.clear !== undefined) act.clear = params.clear;
          if (params.key !== undefined) act.key = params.key;
          if (params.dy !== undefined) act.dy = params.dy;
          if (params.url !== undefined) act.url = params.url;
          if (params.ms !== undefined) act.ms = params.ms;
          const r = await d.act(act);
          const summary =
            `${r.action}: ${r.verdict.level.toUpperCase()}${r.verdict.reason ? ` (${r.verdict.reason})` : ""}` +
            `${r.urlChanged ? ` → navigated to ${r.url}` : ""}${r.note ? ` — ${r.note}` : ""}` +
            `${r.verifiedTarget ? `\nverified storyboard target: ${JSON.stringify(r.verifiedTarget)}` : ""}`;
          if (params.look === false) return result(summary, { verdict: r.verdict });
          return result([text(summary), ...lookContent(await d.look())], { verdict: r.verdict });
        }
        default: {
          const d = rt.discovery;
          if (!d || d.isClosed) return result("no discovery session open");
          const id = d.id;
          const budget = d.budget();
          await rt.closeDiscovery();
          return result(
            `discovery session ${id} closed (screens ${budget.screens}, actions ${budget.actions}). Artifacts: ${d.dir}`,
          );
        }
      }
    },
  });
}

function requireSession(rt: Runtime): DiscoverySession {
  const d = rt.discovery;
  if (!d || d.isClosed)
    throw new Error("no discovery session — call demo_rec_browser with action open first");
  return d;
}
