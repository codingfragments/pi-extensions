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
import { appDirOf, projectContext } from "../workdir/context.ts";
import {
  AGENT_KINDS,
  type Evidence,
  formatFindings,
  listFindings,
  markFinding,
  recordFinding,
} from "../workdir/findings.ts";
import {
  INPUT_KINDS,
  INPUT_STAGES,
  type InputKind,
  type InputStage,
  markInput,
  recordInput,
} from "../workdir/inputs.ts";
import { ensureProject, openProject } from "../workdir/layout.ts";
import { acceptedVersions, formatLine, formatStageStatus, stageStatus } from "../workdir/stages.ts";
import { type Phase, readState } from "../workdir/state.ts";
import { listVersions, writeNextVersion } from "../workdir/versioning.ts";
import { result } from "./common.ts";

/** Input-log stage for the current phase (default stage of a chat note). */
export function stageForPhase(phase: Phase): InputStage {
  const map: Record<Phase, InputStage> = {
    brief: "brief",
    discovery: "discovery",
    "storyboard-review": "storyboard",
    recording: "recording",
    "vo-review": "vo",
    "voice-edit": "vo",
    done: "render",
  };
  return map[phase];
}

/** "screen:<session>/s014" | "take:take-006@102.4" | "url:…" | "file:…" → Evidence. */
export function parseEvidence(ref: string): Evidence {
  const [kind, ...rest] = ref.split(":");
  const v = rest.join(":").trim();
  if (kind === "screen" && v) return { type: "screen", id: v };
  if (kind === "take") {
    const m = /^(take-\d{3,})(?:@(\d+(?:\.\d+)?))?$/.exec(v);
    if (m) return { type: "take", take: m[1] as string, t: Math.round(Number(m[2] ?? 0) * 1000) };
  }
  if (kind === "url" && /^https?:\/\//.test(v)) return { type: "url", url: v };
  if (kind === "file" && v) return { type: "file", path: v };
  if (/^https?:\/\//.test(ref)) return { type: "url", url: ref };
  throw new Error(
    `evidence "${ref}" must look like screen:<session>/sNNN, take:take-006@12.5, url:https://… or file:<path>`,
  );
}

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
    `storyboard versions: ${versions.length ? versions.map((v) => `v${v}`).join(", ") : "none"}; accepted: ${
      acceptedVersions(state.accepted, "storyboard")
        .map((v) => `v${v}`)
        .join(", ") || "none"
    }`,
    `working line: ${formatLine(state.line)}`,
  ];
  lines.push(
    "stages:",
    ...formatStageStatus(stageStatus(p.dir, state.accepted, state.line))
      .split("\n")
      .map((l) => `  ${l}`),
  );
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
      "Demo-recording project management: status of the active project (phase, stage lineage, approvals), create/open a project, read or write its brief (brief.md, versioned). " +
      "context: the project's memory (brief, stage lineage, every active input from commands, panel reviews and chat) — read it when you (re)open a project or after a restart, and follow it. " +
      "note: record a project-relevant direction, source or asset the user gave in chat (so it survives the session). mark: mark an input outdated (with reason) or restore it, when the user withdraws a direction. " +
      "finding: record something notable you found (strength, weakness, friction, value, use-case, length) with evidence — the user marks findings auto/use/ignore in the Project tab; USE findings must appear in the recording and the narration. findings: list them. mark_finding: only when the user asks in chat.",
    parameters: Type.Object({
      action: StringEnum([
        "status",
        "create",
        "open",
        "read_brief",
        "write_brief",
        "context",
        "note",
        "mark",
        "finding",
        "findings",
        "mark_finding",
      ] as const),
      project: Type.Optional(Type.String({ description: "Project name (create/open)" })),
      app_name: Type.Optional(
        Type.String({ description: "App name, shared across demos of the same app (create)" }),
      ),
      app_url: Type.Optional(Type.String({ description: "App base URL (create)" })),
      content: Type.Optional(Type.String({ description: "Full brief markdown (write_brief)" })),
      text: Type.Optional(
        Type.String({
          description: "note: the direction/source/asset in the user's words (one input)",
        }),
      ),
      kind: Type.Optional(
        StringEnum(INPUT_KINDS as unknown as InputKind[], {
          description: "note: default direction",
        }),
      ),
      stage: Type.Optional(
        StringEnum(INPUT_STAGES as unknown as InputStage[], {
          description: "note: stage it applies to (default: the current phase's stage)",
        }),
      ),
      refs: Type.Optional(
        Type.Array(Type.String(), {
          description: "note: URLs or project-relative files it refers to",
        }),
      ),
      from: Type.Optional(
        StringEnum(["user", "agent"] as const, {
          description:
            "note: user (said in chat, default) or agent (your own decision worth keeping)",
        }),
      ),
      id: Type.Optional(Type.String({ description: "mark: input id (in-NNNN)" })),
      outdated: Type.Optional(
        Type.Boolean({ description: "mark: true = outdated (default), false = restore" }),
      ),
      reason: Type.Optional(Type.String({ description: "mark: why it no longer applies" })),
      finding_kind: Type.Optional(
        StringEnum(AGENT_KINDS as unknown as (typeof AGENT_KINDS)[number][], {
          description:
            "finding: strength | weakness | friction | value | use-case | length | other",
        }),
      ),
      finding_stage: Type.Optional(
        StringEnum(["discovery", "recording", "vo", "render"] as const, {
          description: "finding: where it was found (default discovery)",
        }),
      ),
      evidence: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'finding: evidence refs — "screen:<session>/sNNN", "take:take-006@102.4" (seconds), "url:https://…", "file:<project-relative path>"',
        }),
      ),
      suggestion: Type.Optional(
        Type.String({ description: "finding: suggested change (e.g. a new target length)" }),
      ),
      scene: Type.Optional(
        Type.String({ description: "finding: storyboard scene id it belongs to" }),
      ),
      state: Type.Optional(
        StringEnum(["auto", "use", "ignore"] as const, {
          description: "mark_finding: only when the user asked for it",
        }),
      ),
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
          return result(`${projectStatus(rt)}\n\n${projectContext(h.dir, h.slug)}`);
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
          recordInput(p.dir, {
            stage: "brief",
            version: v.version,
            source: "agent",
            kind: "brief",
            text: `brief v${v.version} saved${count > 1 ? ` (replaces v${v.version - 1})` : ""}`,
            refs: [`brief/v${v.version}.md`],
          });
          return result(`brief.md updated (history: brief/v${v.version}.md, ${count} version(s)).`);
        }
        case "context": {
          const p = rt.requireProject();
          return result(projectContext(p.dir, p.slug));
        }
        case "note": {
          const p = rt.requireProject();
          if (!params.text?.trim()) throw new Error("note needs text");
          const state = readState(p.dir) ?? p.state;
          const e = recordInput(p.dir, {
            stage: params.stage ?? stageForPhase(state.phase),
            source: params.from === "agent" ? "agent" : "chat",
            kind: params.kind ?? "direction",
            text: params.text,
            ...(params.refs?.length ? { refs: params.refs } : {}),
          });
          rt.bus.publish(
            "input.recorded",
            { id: e?.id, message: `noted ${e?.id}: ${params.text.slice(0, 60)}` },
            p.slug,
          );
          return result(
            `Recorded ${e?.id} (${e?.stage}, ${e?.kind}). It's part of the project's memory from now on.`,
          );
        }
        case "mark": {
          const p = rt.requireProject();
          if (!params.id) throw new Error("mark needs id");
          const e = markInput(p.dir, params.id, params.outdated ?? true, params.reason ?? "");
          rt.bus.publish(
            "input.marked",
            { id: e.id, message: `${e.id} ${e.outdated ? "marked outdated" : "restored"}` },
            p.slug,
          );
          return result(
            `${e.id} ${e.outdated ? `marked outdated (${e.outdated.reason})` : "restored"}.`,
          );
        }
        case "finding": {
          const p = rt.requireProject();
          if (!params.text?.trim()) throw new Error("finding needs text");
          const f = recordFinding(p.dir, {
            stage: params.finding_stage ?? "discovery",
            kind: params.finding_kind ?? "other",
            text: params.text,
            evidence: (params.evidence ?? []).map(parseEvidence),
            ...(params.suggestion ? { suggestion: params.suggestion } : {}),
            ...(params.scene ? { scene: params.scene } : {}),
          });
          rt.bus.publish(
            "finding.recorded",
            { id: f.id, message: `finding ${f.id} (${f.kind}): ${f.text.slice(0, 60)}` },
            p.slug,
          );
          return result(
            `Recorded ${f.id} (${f.kind}). The user sees it in the Project tab and can mark it use / ignore.`,
          );
        }
        case "findings": {
          const p = rt.requireProject();
          const st = readState(p.dir) ?? p.state;
          return result(
            formatFindings(
              listFindings(p.dir, { appDir: appDirOf(p.dir, st.app), since: st.createdAt }),
            ),
          );
        }
        case "mark_finding": {
          const p = rt.requireProject();
          if (!params.id || !params.state) throw new Error("mark_finding needs id and state");
          const st = readState(p.dir) ?? p.state;
          const f = markFinding(p.dir, params.id, params.state, {
            appDir: appDirOf(p.dir, st.app),
          });
          rt.bus.publish(
            "finding.marked",
            { id: f.id, state: f.state, message: `${f.id} → ${f.state}` },
            p.slug,
          );
          return result(`${f.id} is now "${f.state}".`);
        }
        default:
          return result(projectStatus(rt));
      }
    },
  });
}
