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
import { listBrands, resolveBrand } from "../brand/brand.ts";
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
import { startRender } from "../tools/render.ts";
import { listElevenLabsVoices, sortVoices } from "../tts/engines.ts";
import { briefVoice } from "../tts/factory.ts";
import { openInBrowser } from "../util/open.ts";
import { recordInput } from "../workdir/inputs.ts";
import { ensureProject, listProjects, openProject } from "../workdir/layout.ts";
import { formatLine } from "../workdir/stages.ts";

export const ACTIVE_ENTRY = "demo-recording.active";
export const SUBCOMMANDS = [
  "new",
  "open",
  "status",
  "discover",
  "voiceover",
  "render",
  "voices",
  "brand",
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
  "/demo render                                    check the voice, synthesize, and render the edit (a draft)",
  "/demo render final|draft [brand …]              render a final (needs accepted annotations) or a draft — Render tab",
  "/demo voices                                    list your ElevenLabs voices and pick one",
  "/demo brand [list | use <name> [--project] | new [zip/folder] | rerender [name]]  brand packages",
  "/demo config [show [prefix] | set <key> <value> [--project] | unset <key> [--project]]",
  "/demo panel                                     start the side panel, open it in your browser",
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
    {
      dir: handle.dir,
      app: handle.app.slug,
      url: handle.app.baseUrl,
      message: `project ${handle.slug} ${handle.created ? "created" : "opened"} · ${handle.app.name ?? handle.app.slug}`,
    },
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
  recordInput(p.dir, {
    stage: "discovery",
    source: "command",
    kind: "direction",
    text: notes ? `/demo discover: ${notes}` : "",
  });
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
  rt.primeContext();
  const panel = await rt.ensurePanel();
  report(ctx, `active project: ${handle.slug} (phase: ${handle.state.phase})\npanel: ${panel.url}`);
}

function kick(pi: ExtensionAPI, text: string) {
  pi.sendUserMessage(text, { expandPromptTemplates: true });
}

function cmdVoiceover(pi: ExtensionAPI, rt: Runtime, rest: string[], ctx: ExtensionCommandContext) {
  const p = rt.requireProject();
  const notes = rest.join(" ").trim();
  recordInput(p.dir, {
    stage: "vo",
    source: "command",
    kind: "direction",
    text: notes ? `/demo voiceover: ${notes}` : "",
  });
  kick(
    pi,
    `/skill:demo-voiceover Analyze the latest complete take of "${p.slug}" (demo_rec_take analyze), suggest it for approval (you cannot approve it), and write the voice-over ` +
      `(template, then write) for my review in the panel's Voice tab.${notes ? ` Notes from me: ${notes}` : ""}`,
  );
  report(
    ctx,
    `voice-over started for "${p.slug}" — review it in the panel's Voice tab${rt.panelUrl ? `: ${rt.panelUrl}` : ""}`,
  );
}

function cmdRender(pi: ExtensionAPI, rt: Runtime, rest: string[], ctx: ExtensionCommandContext) {
  const p = rt.requireProject();
  const kind = rest[0];
  if (kind === "final" || kind === "draft") {
    // The Render stage (S5 part 9): a background engine job, no agent turn (like the panel).
    const brands = rest.slice(1).filter(Boolean);
    try {
      const job = startRender(rt, { kind, ...(brands.length ? { brands } : {}), by: "panel" });
      return report(
        ctx,
        `${kind} render started for "${p.slug}" (${job.id}) — watch it in the Render tab`,
      );
    } catch (err) {
      return report(ctx, `can't render a ${kind}: ${(err as Error).message}`, "warning");
    }
  }
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

async function cmdBrand(
  pi: ExtensionAPI,
  rt: Runtime,
  rest: string[],
  ctx: ExtensionCommandContext,
) {
  const [op, name, ...more] = rest;
  const cfg = rt.getConfig();
  if (!op || op === "list") {
    const lines = listBrands(cfg.root).map(
      (b) =>
        `${b.name === cfg.brand ? "▶" : " "} ${b.name}${b.builtin ? " (built-in)" : ""}${b.error ? `  ✖ ${b.error}` : ""}`,
    );
    return report(
      ctx,
      `${lines.join("\n")}\n\ndefault: ${cfg.brand} · /demo brand new [zip|folder] to create one`,
    );
  }
  if (op === "new") {
    kick(
      pi,
      `/skill:demo-brand Create a new brand package for my demos${name ? ` from ${[name, ...more].join(" ")}` : ""}. Explain what you need, inspect the material, propose the mapping and colors, create it, and show me the preview.`,
    );
    return report(ctx, "brand creation started");
  }
  if (op === "rerender") {
    const p = rt.requireProject();
    kick(
      pi,
      `Re-render the latest edit of "${p.slug}" with brand "${name ?? cfg.brand}" (demo_rec_edit action rerender — no new voice, no LLM changes) and tell me the output path.`,
    );
    return report(ctx, `re-render with brand ${name ?? cfg.brand} requested`);
  }
  if (op === "use") {
    if (!name) return report(ctx, "/demo brand use <name> [--project]", "warning");
    resolveBrand(cfg.root, name);
    const change = planChange(
      configFiles(rt),
      more.includes("--project") ? "project" : "global",
      "brand",
      name,
      { env: process.env, home: os.homedir() },
    );
    if (ctx.hasUI && !(await ctx.ui.confirm("Set default brand?", formatChange(change))))
      return report(ctx, "not written");
    if (!ctx.hasUI)
      return report(
        ctx,
        `${formatChange(change)}\n(no UI to confirm — use the demo_rec_brand tool)`,
      );
    applyChange(change);
    rt.getConfig(true);
    return report(
      ctx,
      `default brand: ${name} (${change.scope}) — re-render with /demo brand rerender`,
    );
  }
  return report(
    ctx,
    "usage: /demo brand [list | use <name> [--project] | new [zip/folder] | rerender [name]]",
    "warning",
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
      `working line: ${formatLine(p.state.line)}`,
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
      rt.bindModels((ctx as { modelRegistry?: unknown }).modelRegistry);
      rt.bindSessionModel((ctx as { model?: unknown }).model);
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
            return cmdRender(pi, rt, rest, ctx);
          case "voices":
            return await cmdVoices(rt, ctx);
          case "config":
            return await cmdConfig(rt, rest, ctx);
          case "brand":
            return await cmdBrand(pi, rt, rest, ctx);
          case "panel": {
            const panel = await rt.ensurePanel();
            const opened = openInBrowser(panel.url);
            return report(
              ctx,
              `demo panel: ${panel.url}${opened ? "\n(opened in your browser)" : ""}`,
            );
          }
          case "doctor": {
            const results = await runDoctor(rt.getConfig(true), {
              ...(ctx.modelRegistry ? { registry: ctx.modelRegistry as never } : {}),
              ...(ctx.model ? { sessionModel: ctx.model } : {}),
            });
            rt.bus.publish("doctor.result", {
              message: `doctor: ${["fail", "warn", "pass"].map((st) => `${results.filter((r) => r.status === st).length} ${st}`).join(", ")}${
                results.some((r) => r.status === "fail")
                  ? ` — failing: ${results
                      .filter((r) => r.status === "fail")
                      .map((r) => r.name)
                      .join(", ")}`
                  : ""
              }`,
              checks: results,
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
