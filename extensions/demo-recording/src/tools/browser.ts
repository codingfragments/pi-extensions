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
import { checkBeforeStart } from "../auth/session.ts";
import { formatDiscoveryProgress } from "../discovery/progress.ts";
import { pendingRequest, startRequest } from "../discovery/requests.ts";
import { type ActParams, DiscoverySession, type LookResult } from "../discovery/session.ts";
import { surveyLine } from "../discovery/survey.ts";
import { contextWarning, visionWarning } from "../models.ts";
import type { Runtime } from "../runtime.ts";
import { appDir } from "../workdir/layout.ts";
import { setPhase } from "../workdir/state.ts";
import { TargetSchema, type ToolContent, result, text, toTarget } from "./common.ts";

function lookContent(look: LookResult, progress?: string): ToolContent[] {
  const b = look.budget;
  return [
    { type: "image", data: look.jpeg.toString("base64"), mimeType: "image/jpeg" },
    text(
      `screen ${look.screen} — ${look.title} — ${look.url}\n` +
        `budget: screens ${b.screens}, actions ${b.actions}, minutes ${b.minutes}${b.exhausted ? " — EXHAUSTED: write the storyboard now" : ""}\n` +
        `${progress ? `progress: ${progress}\n` : ""}` +
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
      "survey: the ENGINE visits the app's navigation by itself (about 2 s a page, up to max pages, default 24; or only the given paths) and returns a contact sheet and one line per page (headings, rows, whether it loads more on scroll): do it once right after open and plan, then go deep only where it matters. Surveyed pages do not use the screen budget. " +
      "act with steps: [...] runs up to 8 actions in ONE call (a route walk: goto, scroll, click …) and returns one look of where it ends: use it instead of one call per step. " +
      "Every browser call has a deadline: a browser that does not answer is restarted on the same page and you are told. A list that loads more on scroll extends once, then scrolls stay inside what is loaded. " +
      'plan: right after the first look, declare the areas you will explore (areas: [...], with routes: {area: ["/path"]} so looks and actions are counted for the right area); progress is MEASURED from what you saw, so marking an area done (done: name) does not move it by itself. An area you will not explore is left out on purpose with drop + why. The storyboard is refused while a declared area was never seen or dropped. ' +
      "close: end the session. Budgets for screens/actions/minutes are enforced.",
    parameters: Type.Object({
      action: StringEnum(["open", "look", "act", "survey", "plan", "close"] as const),
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
      areas: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "plan: the app areas you intend to explore, in order (drives the user's progress estimate)",
        }),
      ),
      routes: Type.Optional(
        Type.Record(Type.String(), Type.Array(Type.String()), {
          description:
            'plan: routes per declared area, e.g. {"Search": ["/search"], "Cart": ["/cart", "/checkout"]}. Looks and actions on those pages are counted for that area; without routes they count for the area you are working on',
        }),
      ),
      done: Type.Optional(
        Type.String({
          description:
            "plan: say this area is explored. Progress still counts only what was seen there: an area marked done with nothing seen is flagged",
        }),
      ),
      drop: Type.Optional(
        Type.String({
          description:
            "plan: leave this declared area out on purpose (needs why). The storyboard check accepts a dropped area; it refuses an area nobody saw",
        }),
      ),
      why: Type.Optional(
        Type.String({ description: "plan drop: one sentence, why this area is left out" }),
      ),
      look: Type.Optional(
        Type.Boolean({ description: "act: return a fresh look afterwards (default true)" }),
      ),
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            step: StringEnum(
              ["click", "hover", "type", "press", "scroll", "goto", "back", "wait"] as const,
              { description: "what to do" },
            ),
            target: Type.Optional(TargetSchema),
            text: Type.Optional(Type.String()),
            submit: Type.Optional(Type.Boolean()),
            clear: Type.Optional(Type.Boolean()),
            key: Type.Optional(Type.String()),
            dy: Type.Optional(Type.Number()),
            url: Type.Optional(Type.String()),
            ms: Type.Optional(Type.Number()),
          }),
          {
            maxItems: 8,
            description:
              "act: several actions in one call, in order (at most 8); it stops at the first one that fails and says which. One look of the end state follows (look: false for none)",
          },
        ),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'survey: only these paths (e.g. ["/issues/", "/explore/traces/"]) instead of the navigation the page shows',
        }),
      ),
      max: Type.Optional(
        Type.Number({ description: "survey: at most this many pages (default 24, at most 60)" }),
      ),
      full_digest: Type.Optional(
        Type.Boolean({
          description:
            "look / act: send the whole aria digest, including the navigation that has not changed since the last look (default: that is one line)",
        }),
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      switch (params.action) {
        case "open": {
          const p = rt.requireProject();
          await rt.closeDiscovery();
          await rt.closeKeptWindows(); // a window kept open from the last session goes now: one at a time
          const cfg = rt.getConfig();
          const statePath = path.join(appDir(cfg.root, p.app.slug), "auth", "state.json");
          // a saved login that has expired stops the start, with what to do (S7)
          const login = await checkBeforeStart({ root: cfg.root, app: p.app });
          if (!login.ok) {
            rt.bus.publish("auth.expired", { app: p.app.slug, message: login.message }, p.slug);
            throw new Error(login.message);
          }
          // a request from the Project page (Start / Enhance) brings the budget the user chose; otherwise Config's
          const asked = pendingRequest(p.dir);
          rt.discovery = await DiscoverySession.open({
            root: cfg.root,
            app: p.app,
            viewport: { width: cfg.viewport.width, height: cfg.viewport.height },
            budgets: asked?.budget ?? cfg.budgets,
            heartbeatSec: cfg.discovery.heartbeatSec,
            callTimeoutSec: cfg.discovery.callTimeoutSec,
            browserLog: cfg.discovery.browserLog,
            browserMemoryMb: cfg.discovery.browserMemoryMb,
            settleMaxMs: cfg.discovery.settleMaxMs,
            ...(asked ? { request: asked.id } : {}),
            bus: rt.bus,
            project: p.slug,
            // the Start window's switch shows the window in front and keeps it open afterwards; the Director's own `headed` only shows it
            ...(params.headed || asked?.headed ? { headed: true } : {}),
            ...(asked?.headed ? { keepOpen: true } : {}),
            ...(fs.existsSync(statePath) ? { storageState: statePath } : {}),
          });
          if (asked) {
            startRequest(p.dir, asked.id, rt.discovery.id);
            rt.bus.publish(
              "discovery.request-taken",
              {
                request: asked.id,
                session: rt.discovery.id,
                message: `the session took request ${asked.id}: ${asked.budget.discoveryScreens} screens, ${asked.budget.discoveryActions} actions, ${asked.budget.discoveryMinutes} minutes`,
              },
              p.slug,
            );
          }
          if (p.state.phase === "brief") setPhase(p.dir, "discovery");
          await rt.ensurePanel();
          const look = await rt.discovery.look();
          const warnings = [visionWarning(ctx?.model), contextWarning(ctx?.model)].filter(
            (w): w is string => !!w,
          );
          for (const w of warnings) rt.bus.publish("model.warning", { message: w }, p.slug);
          return result(
            [
              text(
                `discovery session ${rt.discovery.id} opened on ${p.app.baseUrl}${warnings.length ? `\n${warnings.join("\n")}` : ""}`,
              ),
              ...lookContent(look, progressLine(rt)),
            ],
            {
              session: rt.discovery.id,
            },
          );
        }
        case "look": {
          const d = requireSession(rt);
          return result(
            lookContent(
              await d.look(
                {
                  ...(params.full_page ? { fullPage: true } : {}),
                  ...(params.full_digest ? { fullDigest: true } : {}),
                },
                signal,
              ),
              progressLine(rt),
            ),
          );
        }
        case "act": {
          const d = requireSession(rt);
          const one = (x: {
            step?: string;
            target?: unknown;
            text?: string;
            submit?: boolean;
            clear?: boolean;
            key?: string;
            dy?: number;
            url?: string;
            ms?: number;
          }): ActParams => {
            if (!x.step)
              throw new Error(
                "act needs step (click | hover | type | press | scroll | goto | back | wait)",
              );
            const target = toTarget(x.target as never);
            const act: ActParams = { action: x.step as ActParams["action"] };
            if (target) act.target = target;
            if (x.text !== undefined) act.text = x.text;
            if (x.submit !== undefined) act.submit = x.submit;
            if (x.clear !== undefined) act.clear = x.clear;
            if (x.key !== undefined) act.key = x.key;
            if (x.dy !== undefined) act.dy = x.dy;
            if (x.url !== undefined) act.url = x.url;
            if (x.ms !== undefined) act.ms = x.ms;
            return act;
          };
          const say = (r: Awaited<ReturnType<typeof d.act>>) =>
            `${r.action}: ${r.verdict.level.toUpperCase()}${r.verdict.reason ? ` (${r.verdict.reason})` : ""}` +
            `${r.urlChanged ? ` → navigated to ${r.url}` : ""}${r.note ? ` — ${r.note}` : ""}` +
            `${r.verifiedTarget ? `\nverified storyboard target: ${JSON.stringify(r.verifiedTarget)}` : ""}`;
          const lookOpts = params.full_digest ? { fullDigest: true } : {};
          if (params.steps?.length) {
            // a route walk in one call: stops at the first step that fails and says which; one look of where it ended
            const lines: string[] = [];
            let failed = false;
            for (const [i, x] of params.steps.slice(0, 8).entries()) {
              try {
                lines.push(`${i + 1}. ${say(await d.act(one(x), signal))}`);
              } catch (err) {
                lines.push(`${i + 1}. ${x.step} FAILED: ${(err as Error).message}`);
                failed = true;
                break;
              }
            }
            const head = `${lines.length} of ${Math.min(params.steps.length, 8)} steps${failed ? " (stopped at the first failure)" : ""}:\n${lines.join("\n")}`;
            if (params.look === false || d.isClosed) return result(head);
            return result(
              [text(head), ...lookContent(await d.look(lookOpts, signal), progressLine(rt))],
              {},
            );
          }
          const r = await d.act(one(params), signal);
          const summary = say(r);
          if (params.look === false) return result(summary, { verdict: r.verdict });
          return result(
            [text(summary), ...lookContent(await d.look(lookOpts, signal), progressLine(rt))],
            { verdict: r.verdict },
          );
        }
        case "survey": {
          const d = requireSession(rt);
          const sv = await d.survey(
            {
              ...(params.paths?.length ? { paths: params.paths } : {}),
              ...(params.max ? { max: params.max } : {}),
            },
            signal,
          );
          const seen = sv.pages.filter((p) => p.status === "seen");
          const lines = sv.pages.map(surveyLine);
          const extending = seen.filter((p) => p.extends).length;
          const notSeen = sv.pages.length - seen.length;
          const head = [
            `survey: ${seen.length} page${seen.length === 1 ? "" : "s"} seen${notSeen ? `, ${notSeen} not (skipped or failed)` : ""} in ${(sv.ms / 1000).toFixed(1)} s${extending ? `; ${extending} load${extending === 1 ? "s" : ""} more on scroll and ${extending === 1 ? "was" : "were"} extended once` : ""}.`,
            "These screens are in the log and the sitemap; they did not use the screen budget. Now choose the few pages that serve the brief and go deep there with look and act (steps: [...] walks a route in one call). Do not survey again.",
          ].join("\n");
          return result([
            text(`${head}\n\n${lines.join("\n")}\n\n${progressLine(rt) ?? ""}`),
            ...sv.sheets.map((j) => ({
              type: "image" as const,
              data: j.toString("base64"),
              mimeType: "image/jpeg",
            })),
          ]);
        }
        case "plan": {
          const d = requireSession(rt);
          if (params.areas?.length) d.setPlan(params.areas, params.routes);
          else if (params.routes)
            throw new Error("routes go with areas: declare the areas in the same call");
          if (params.done) d.markDone(params.done);
          if (params.drop) d.dropArea(params.drop, params.why ?? "");
          if (!params.areas?.length && !params.done && !params.drop)
            throw new Error(
              "plan needs areas (declare, with routes if you can), done (an area is explored) or drop with why (leave an area out on purpose)",
            );
          return result(progressLine(rt) ?? "plan updated");
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

function progressLine(rt: Runtime): string | undefined {
  const d = rt.discovery;
  return d && !d.isClosed ? formatDiscoveryProgress(d.progress()) : undefined;
}

function requireSession(rt: Runtime): DiscoverySession {
  const d = rt.discovery;
  if (!d || d.isClosed)
    throw new Error("no discovery session — call demo_rec_browser with action open first");
  return d;
}
