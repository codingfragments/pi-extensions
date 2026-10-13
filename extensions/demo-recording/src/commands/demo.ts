/**
 * `/demo` command (S0): new · open · status · panel · doctor.
 *
 * `/demo new` is a minimal stub in S0 (project name, app name, URL); the guided
 * brief with the demo-brief skill arrives in S2.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatDoctor, runDoctor } from "../doctor.ts";
import type { Runtime } from "../runtime.ts";
import { ensureProject, listProjects, openProject } from "../workdir/layout.ts";

export const ACTIVE_ENTRY = "demo-recording.active";
const SUBCOMMANDS = ["new", "open", "status", "discover", "panel", "doctor"] as const;

const USAGE = [
  "/demo new [<project> <app-url> [app name…]]   create a demo project",
  "/demo open [<project>]                          set the active project",
  "/demo status                                    phase, approvals, panel",
  "/demo discover [notes…]                         explore the app and draft a storyboard",
  "/demo panel                                     start/show the side panel URL",
  "/demo doctor                                    check prerequisites",
].join("\n");

function report(
  ctx: ExtensionCommandContext,
  text: string,
  level: "info" | "warning" | "error" = "info",
) {
  ctx.ui.notify(text, level);
}

async function cmdNew(pi: ExtensionAPI, rt: Runtime, rest: string[], ctx: ExtensionCommandContext) {
  let [project, appUrl, ...nameParts] = rest;
  let appName = nameParts.join(" ");
  if (!project || !appUrl) {
    if (!ctx.hasUI) return report(ctx, `usage: ${USAGE.split("\n")[0]}`, "warning");
    project = project || (await ctx.ui.input("Demo project name:", "acme-churn-poc"))?.trim();
    if (!project) return;
    appUrl = appUrl || (await ctx.ui.input("App URL:", "https://staging.example.com"))?.trim();
    if (!appUrl) return;
  }
  if (!appName) {
    const host = new URL(appUrl).hostname;
    appName = ctx.hasUI
      ? (await ctx.ui.input("App name (shared across demos of this app):", host))?.trim() || host
      : host;
  }
  const cfg = rt.getConfig();
  const handle = ensureProject(cfg.root, { project, appName, appUrl });
  rt.setActiveProject(handle.slug);
  pi.appendEntry(ACTIVE_ENTRY, { project: handle.slug });
  rt.bus.publish(
    handle.created ? "project.created" : "project.opened",
    { dir: handle.dir, app: handle.app.slug },
    handle.slug,
  );
  const panel = await rt.ensurePanel();
  report(
    ctx,
    `${handle.created ? "Created" : "Opened existing"} demo project "${handle.slug}"\n` +
      `folder: ${handle.dir}\nbrief:  ${handle.dir}/brief.md\npanel:  ${panel.url}`,
  );
  if (ctx.hasUI && handle.created) {
    // Hand over to the director: draft the brief with the user (demo-brief skill).
    pi.sendUserMessage(
      `/skill:demo-brief Demo project "${handle.slug}" was just created for ${handle.app.name} (${handle.app.baseUrl}). Draft the brief with me: ask for what's missing, then save it with demo_rec_project write_brief.`,
      { expandPromptTemplates: true },
    );
  }
}

function cmdDiscover(pi: ExtensionAPI, rt: Runtime, rest: string[], ctx: ExtensionCommandContext) {
  const p = rt.requireProject();
  const notes = rest.join(" ").trim();
  pi.sendUserMessage(
    `/skill:demo-recording Discover ${p.app.name} (${p.app.baseUrl}) for demo project "${p.slug}" and propose a storyboard ` +
      `based on brief.md.${notes ? ` Extra notes from me: ${notes}` : ""}`,
    { expandPromptTemplates: true },
  );
  report(
    ctx,
    `discovery started for "${p.slug}" — follow along in the panel${rt.panelUrl ? `: ${rt.panelUrl}` : " (/demo panel)"}`,
  );
}

async function cmdOpen(
  pi: ExtensionAPI,
  rt: Runtime,
  rest: string[],
  ctx: ExtensionCommandContext,
) {
  const root = rt.getConfig().root;
  let project = rest[0];
  if (!project) {
    const projects = listProjects(root);
    if (!projects.length)
      return report(ctx, `no demo projects under ${root} — run /demo new`, "warning");
    if (!ctx.hasUI) return report(ctx, `projects: ${projects.join(", ")}`);
    project = await ctx.ui.select("Open demo project:", projects);
    if (!project) return;
  }
  const handle = openProject(root, project);
  rt.setActiveProject(handle.slug);
  pi.appendEntry(ACTIVE_ENTRY, { project: handle.slug });
  const panel = await rt.ensurePanel();
  report(ctx, `active project: ${handle.slug} (phase: ${handle.state.phase})\npanel: ${panel.url}`);
}

function cmdStatus(rt: Runtime, ctx: ExtensionCommandContext) {
  const cfg = rt.getConfig();
  const p = rt.activeProject();
  const lines = [`root:    ${cfg.root}`, `config:  ${cfg.sources.join(" → ")}`];
  if (p) {
    lines.push(
      `project: ${p.slug} (app: ${p.app.name}, ${p.app.baseUrl})`,
      `phase:   ${p.state.phase}`,
      `approved: storyboard ${p.state.approved.storyboard ?? "—"} · vo ${p.state.approved.vo ?? "—"}`,
    );
  } else {
    lines.push("project: none active — /demo new or /demo open");
  }
  lines.push(`panel:   ${rt.panelUrl ?? "not started — /demo panel"}`);
  report(ctx, lines.join("\n"));
}

export function registerDemoCommand(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerCommand("demo", {
    description: "Demo recorder: new | open | status | panel | doctor",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) {
        const items = SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({
          value: s,
          label: s,
        }));
        return items.length ? items : null;
      }
      if (parts[0] === "open" && parts.length === 2) {
        try {
          const items = listProjects(rt.getConfig().root)
            .filter((p) => p.startsWith(parts[1] ?? ""))
            .map((p) => ({ value: `open ${p}`, label: p }));
          return items.length ? items : null;
        } catch {
          return null;
        }
      }
      return null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (sub) {
          case "new":
            return await cmdNew(pi, rt, rest, ctx);
          case "open":
            return await cmdOpen(pi, rt, rest, ctx);
          case "status":
            return cmdStatus(rt, ctx);
          case "discover":
            await rt.ensurePanel();
            return cmdDiscover(pi, rt, rest, ctx);
          case "panel": {
            const panel = await rt.ensurePanel();
            return report(ctx, `demo panel: ${panel.url}`);
          }
          case "doctor": {
            const results = await runDoctor(rt.getConfig(true), {
              ...(ctx.modelRegistry ? { registry: ctx.modelRegistry as never } : {}),
              ...(ctx.model ? { sessionModel: ctx.model } : {}),
            });
            rt.bus.publish("doctor.result", {
              message: results.map((r) => `${r.name}:${r.status}`).join(" "),
            });
            const failing = results.some((r) => r.status === "fail");
            return report(ctx, formatDoctor(results), failing ? "warning" : "info");
          }
          default:
            return report(ctx, USAGE);
        }
      } catch (err) {
        report(ctx, `demo ${sub ?? ""}: ${(err as Error).message}`, "error");
      }
    },
  });
}
