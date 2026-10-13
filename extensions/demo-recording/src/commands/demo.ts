/**
 * `/demo` command (S0): new · open · status · panel · doctor.
 *
 * `/demo new` is a minimal stub in S0 (project name, app name, URL); the guided
 * brief with the demo-brief skill arrives in S2.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Scope,
  applyChange,
  describeConfig,
  formatChange,
  formatEntries,
  parseValue,
  planChange,
} from "../config-edit.ts";
import { formatDoctor, runDoctor } from "../doctor.ts";
import type { Runtime } from "../runtime.ts";
import { configFiles } from "../tools/config.ts";
import { listElevenLabsVoices, sortVoices } from "../tts/engines.ts";
import { briefVoice } from "../tts/factory.ts";
import { ensureProject, listProjects, openProject } from "../workdir/layout.ts";

export const ACTIVE_ENTRY = "demo-recording.active";
const SUBCOMMANDS = [
  "new",
  "open",
  "status",
  "discover",
  "voiceover",
  "render",
  "voices",
  "config",
  "panel",
  "doctor",
] as const;

const USAGE = [
  "/demo new [<project> <app-url> [app name…]]   create a demo project",
  "/demo open [<project>]                          set the active project",
  "/demo status                                    phase, approvals, panel",
  "/demo discover [notes…]                         explore the app and draft a storyboard",
  "/demo voiceover [notes…]                        analyze the latest take and write the voice-over",
  "/demo render                                    check the voice, synthesize, and render the edit",
  "/demo voices                                    list your ElevenLabs voices and pick one",
  "/demo config [show [prefix] | set <key> <value> [--project] | unset <key> [--project]]",
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

function kick(pi: ExtensionAPI, text: string) {
  pi.sendUserMessage(text, { expandPromptTemplates: true });
}

function cmdVoiceover(pi: ExtensionAPI, rt: Runtime, rest: string[], ctx: ExtensionCommandContext) {
  const p = rt.requireProject();
  const notes = rest.join(" ").trim();
  kick(
    pi,
    `/skill:demo-voiceover Analyze the latest complete take of "${p.slug}" (demo_rec_take analyze), accept it, and write the voice-over ` +
      `(template, then write) for my review in the panel's Voice tab.${notes ? ` Notes from me: ${notes}` : ""}`,
  );
  report(
    ctx,
    `voice-over started for "${p.slug}" — review it in the panel's Voice tab${rt.panelUrl ? `: ${rt.panelUrl}` : ""}`,
  );
}

function cmdRender(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionCommandContext) {
  const p = rt.requireProject();
  kick(
    pi,
    `/skill:demo-voiceover The voice-over of "${p.slug}" is approved. Run demo_rec_tts check and tell me which engine and voice will be used; if it's the voice I expect, synthesize (demo_rec_tts start) and then render the edit (demo_rec_edit start). Report output paths and sync stats.`,
  );
  report(ctx, `render started for "${p.slug}"`);
}

async function cmdVoices(rt: Runtime, ctx: ExtensionCommandContext) {
  const all = sortVoices(
    await listElevenLabsVoices({
      ...(process.env.ELEVENLABS_API_KEY?.trim()
        ? { apiKey: process.env.ELEVENLABS_API_KEY.trim() }
        : {}),
    }),
  );
  const labels = all.map((v) => `${v.name}  (${v.category ?? "?"} · ${v.voice_id})`);
  if (!ctx.hasUI) return report(ctx, labels.join("\n"));
  const pick = await ctx.ui.select(
    `ElevenLabs voices (${all.length}) — pick the narration voice:`,
    labels,
  );
  if (!pick) return;
  const voice = all[labels.indexOf(pick)];
  if (!voice) return;
  const project = rt.activeProject();
  const scopes = [
    ...(project ? [`project "${project.slug}" only`] : []),
    "global default (all projects)",
  ];
  const where = await ctx.ui.select(`Use "${voice.name}" for…`, scopes);
  if (!where) return;
  const scope: Scope = where.startsWith("project") ? "project" : "global";
  const change = planChange(configFiles(rt), scope, "voiceName", voice.name, {
    env: process.env,
    home: os.homedir(),
  });
  if (!(await ctx.ui.confirm("Write config?", formatChange(change)))) return;
  applyChange(change);
  rt.getConfig(true);
  const brief = project ? briefVoiceOf(project.dir) : undefined;
  report(
    ctx,
    `voiceName = "${voice.name}" (${scope})${brief ? `\n⚠ the brief's Voice field ("${brief}") still wins for this project — edit brief.md or clear it` : ""}` +
      `${change.shadowedBy ? `\n⚠ overridden by ${change.shadowedBy}` : ""}`,
  );
}

function briefVoiceOf(projectDir: string): string | undefined {
  const f = path.join(projectDir, "brief.md");
  return fs.existsSync(f) ? briefVoice(fs.readFileSync(f, "utf8")) : undefined;
}

async function cmdConfig(rt: Runtime, rest: string[], ctx: ExtensionCommandContext) {
  const [op, key, ...more] = rest;
  const files = configFiles(rt);
  if (!op || op === "show") {
    return report(
      ctx,
      formatEntries(describeConfig(files, process.env, os.homedir(), key ?? ""), files),
    );
  }
  if (op !== "set" && op !== "unset")
    return report(
      ctx,
      "usage: /demo config [show [prefix] | set <key> <value> [--project] | unset <key> [--project]]",
      "warning",
    );
  if (!key) return report(ctx, `/demo config ${op} needs a key`, "warning");
  const projectScope = more.includes("--project");
  const valueText = more.filter((m) => m !== "--project").join(" ");
  if (op === "set" && !valueText) return report(ctx, "/demo config set needs a value", "warning");
  const change = planChange(
    files,
    projectScope ? "project" : "global",
    key,
    op === "set" ? parseValue(valueText) : undefined,
    {
      env: process.env,
      home: os.homedir(),
      unset: op === "unset",
    },
  );
  if (ctx.hasUI && !(await ctx.ui.confirm("Write config?", formatChange(change))))
    return report(ctx, "not written");
  if (!ctx.hasUI)
    return report(
      ctx,
      `${formatChange(change)}\n(no UI to confirm — use the demo_rec_config tool)`,
    );
  applyChange(change);
  rt.getConfig(true);
  report(
    ctx,
    `written: ${change.key} (${change.scope})${change.shadowedBy ? `\n⚠ overridden by ${change.shadowedBy}` : ""}`,
  );
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
          case "voiceover":
            await rt.ensurePanel();
            return cmdVoiceover(pi, rt, rest, ctx);
          case "render":
            return cmdRender(pi, rt, ctx);
          case "voices":
            return await cmdVoices(rt, ctx);
          case "config":
            return await cmdConfig(rt, rest, ctx);
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
