/**
 * demo_rec_project — create/open/inspect demo projects and write the brief.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ACTIVE_ENTRY } from "../commands/demo.ts";
import type { Runtime } from "../runtime.ts";
import { readStoryboard, storyboardVersions } from "../storyboard/store.ts";
import { ensureProject, openProject } from "../workdir/layout.ts";
import { readState } from "../workdir/state.ts";
import { listVersions, writeNextVersion } from "../workdir/versioning.ts";
import { result } from "./common.ts";

export function projectStatus(rt: Runtime): string {
  const p = rt.requireProject();
  const state = readState(p.dir) ?? p.state;
  const versions = storyboardVersions(p.dir);
  const latest = readStoryboard(p.dir);
  const takes = fs.existsSync(path.join(p.dir, "takes"))
    ? fs
        .readdirSync(path.join(p.dir, "takes"))
        .filter((d) => d.startsWith("take-"))
        .sort()
    : [];
  const review = latest ? state.reviews?.[String(latest.version)] : undefined;
  const lines = [
    `project: ${p.slug}  (app: ${p.app.name}, ${p.app.baseUrl})`,
    `folder:  ${p.dir}`,
    `phase:   ${state.phase}`,
    `brief:   ${path.join(p.dir, "brief.md")}`,
    `storyboard versions: ${versions.length ? versions.map((v) => `v${v}`).join(", ") : "none"}; approved: ${state.approved.storyboard ? `v${state.approved.storyboard}` : "none"}`,
  ];
  if (latest && review) {
    const marks = Object.entries(review.scenes)
      .map(([id, r]) => `${id}=${r.status}`)
      .join(", ");
    lines.push(
      `review of v${latest.version}: ${marks || "no scene marks"}${review.submittedAt ? " (submitted)" : " (draft)"}`,
    );
  }
  lines.push(`takes: ${takes.length ? takes.join(", ") : "none"}`);
  lines.push(
    `discovery: ${rt.discovery && !rt.discovery.isClosed ? `open (${rt.discovery.id})` : "closed"}`,
  );
  lines.push(`panel: ${rt.panelUrl ?? "not started"}`);
  return lines.join("\n");
}

export function registerProjectTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_project",
    label: "Demo project",
    description:
      "Demo-recording project management: status of the active project, create/open a project, read or write its brief (brief.md, versioned). " +
      "Use at the start of a demo workflow and whenever you need the project's phase, approvals and file locations.",
    parameters: Type.Object({
      action: StringEnum(["status", "create", "open", "read_brief", "write_brief"] as const),
      project: Type.Optional(Type.String({ description: "Project name (create/open)" })),
      app_name: Type.Optional(
        Type.String({ description: "App name, shared across demos of the same app (create)" }),
      ),
      app_url: Type.Optional(Type.String({ description: "App base URL (create)" })),
      content: Type.Optional(Type.String({ description: "Full brief markdown (write_brief)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const cfg = rt.getConfig();
      switch (params.action) {
        case "create": {
          if (!params.project || !params.app_url)
            throw new Error("create needs project and app_url");
          const h = ensureProject(cfg.root, {
            project: params.project,
            appName: params.app_name ?? new URL(params.app_url).hostname,
            appUrl: params.app_url,
          });
          rt.setActiveProject(h.slug);
          pi.appendEntry(ACTIVE_ENTRY, { project: h.slug });
          const panel = await rt.ensurePanel();
          rt.bus.publish(
            h.created ? "project.created" : "project.opened",
            { dir: h.dir, app: h.app.slug },
            h.slug,
          );
          return result(
            `${h.created ? "Created" : "Opened existing"} project "${h.slug}" at ${h.dir}\npanel: ${panel.url}`,
          );
        }
        case "open": {
          if (!params.project) throw new Error("open needs project");
          const h = openProject(cfg.root, params.project);
          rt.setActiveProject(h.slug);
          pi.appendEntry(ACTIVE_ENTRY, { project: h.slug });
          await rt.ensurePanel();
          return result(projectStatus(rt));
        }
        case "read_brief": {
          const p = rt.requireProject();
          return result(fs.readFileSync(path.join(p.dir, "brief.md"), "utf8"));
        }
        case "write_brief": {
          const p = rt.requireProject();
          if (!params.content?.trim())
            throw new Error("write_brief needs content (the full brief markdown)");
          const v = writeNextVersion(path.join(p.dir, "brief"), "v", ".md", params.content);
          fs.writeFileSync(path.join(p.dir, "brief.md"), params.content);
          rt.bus.publish(
            "brief.written",
            { version: v.version, message: `brief v${v.version} written` },
            p.slug,
          );
          const count = listVersions(path.join(p.dir, "brief"), "v", ".md").length;
          return result(`brief.md updated (history: brief/v${v.version}.md, ${count} version(s)).`);
        }
        default:
          return result(projectStatus(rt));
      }
    },
  });
}
