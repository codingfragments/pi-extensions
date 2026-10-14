/**
 * Panel routes for the Project tab (S5 part 5a, D42/D43/D48): project facts
 * (edited as brief fields, two-phase with a diff), brief history, the input
 * log (mark outdated / restore), sources and assets, lineage, and findings
 * (auto / use / ignore) with their evidence.
 */

import fs from "node:fs";
import path from "node:path";
import { lineDiff } from "../config-edit.ts";
import {
  BRIEF_FIELDS,
  DEPTH_DEFAULTS,
  effectiveFacts,
  formatLength,
  parseDepth,
  parseStance,
  parseTargetLength,
  setBriefFacts,
} from "../workdir/brief.ts";
import { appDirOf } from "../workdir/context.ts";
import {
  type Evidence,
  FINDING_STATES,
  type FindingState,
  listFindings,
  markFinding,
} from "../workdir/findings.ts";
import { markInput, readInputs, recordInput } from "../workdir/inputs.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import { formatLine } from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import { listVersions, writeNextVersion } from "../workdir/versioning.ts";
import type { GetRoute, PostRoute } from "./server.ts";
import { localize } from "./stage-routes.ts";

export interface ProjectRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  publish: (type: string, data: Record<string, unknown>, project?: string) => void;
  /** Note for the agent's next turn without starting one. */
  tellAgent: (text: string) => void;
}

const rel = (base: string, file: string) => path.relative(base, file).split(path.sep).join("/");

/** Validate a facts patch from the form; returns the cleaned patch. */
export function validateFactsPatch(patch: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!BRIEF_FIELDS.some((f) => f.key === k)) throw new Error(`unknown field "${k}"`);
    if (typeof v !== "string") throw new Error(`"${k}" must be text`);
    const val = v.trim();
    if (val) {
      if (k === "depth" && !parseDepth(val))
        throw new Error('depth must be "poc", "showcase" or "sales"');
      if (k === "stance" && !parseStance(val))
        throw new Error('stance must be "champion", "evaluator" or "teacher"');
      if (k === "length" && !parseTargetLength(val))
        throw new Error('target length must look like "3–4 min", "60–90 s" or "2:30–3:30"');
      if (k === "url" && !/^https?:\/\/\S+$/.test(val))
        throw new Error("URL must start with http(s)://");
      if (k === "extraUrls" && val.split(/[\s,]+/).some((u) => u && !/^https?:\/\//.test(u)))
        throw new Error("extra URLs must each start with http(s)://");
      if (k === "title" && val.length > 60)
        throw new Error("title must be ≤ 60 characters (title card)");
      if (k === "subtitle" && val.length > 90) throw new Error("subtitle must be ≤ 90 characters");
    }
    out[k] = val;
  }
  return out;
}

export function projectRoutes(deps: ProjectRouteDeps): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const requireProject = () => {
    const p = deps.activeProject();
    if (!p) throw new Error("no active project");
    return p;
  };
  const briefOf = (p: ProjectHandle) => {
    const f = path.join(p.dir, "brief.md");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  };
  const evidenceMedia = (
    p: ProjectHandle,
    e: Evidence,
  ): { kind: "app" | "project"; path: string } | null => {
    if (e.type === "screen") {
      const [session, id] = e.id.split("/");
      return session && id ? { kind: "app", path: `discovery/${session}/screens/${id}.jpg` } : null;
    }
    if (e.type === "take") {
      // Nearest keyframe of that take (analysis), as a thumbnail.
      try {
        const a = JSON.parse(
          fs.readFileSync(path.join(p.dir, "takes", e.take, "analysis", "analysis.json"), "utf8"),
        ) as {
          scenes: { keyframes: { t: number; file: string }[] }[];
        };
        const k = a.scenes
          .flatMap((s) => s.keyframes)
          .sort((x, y) => Math.abs(x.t - e.t) - Math.abs(y.t - e.t))[0];
        const file = k ? localize(p.dir, k.file) : undefined;
        return file ? { kind: "project", path: rel(p.dir, file) } : null;
      } catch {
        return null;
      }
    }
    return null;
  };
  return {
    get: {
      /** Project facts (brief fields) with depth defaults, login state (never its contents), brief versions. */
      project: () => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const brief = briefOf(p);
        const e = effectiveFacts(brief);
        const auth = path.join(appDirOf(p.dir, p.app.slug), "auth", "state.json");
        return {
          project: p.slug,
          app: { slug: p.app.slug, name: p.app.name, baseUrl: p.app.baseUrl },
          fields: BRIEF_FIELDS.map((f) => ({ key: f.key, label: f.label })),
          facts: e.facts,
          effective: {
            depth: e.depth ?? null,
            stance: e.stance ?? null,
            stanceFromDepth: e.stanceFromDepth,
            length: e.length ? formatLength(e.length) : null,
            lengthSec: e.length ?? null,
            lengthFromDepth: e.lengthFromDepth,
            extraUrls: e.extraUrls,
          },
          depthDefaults: Object.fromEntries(
            Object.entries(DEPTH_DEFAULTS).map(([k, v]) => [
              k,
              {
                stance: v.stance,
                length: formatLength(v.length),
                lengthSec: v.length,
                label: v.label,
              },
            ]),
          ),
          login: fs.existsSync(auth)
            ? { saved: true, savedAt: fs.statSync(auth).mtime.toISOString() }
            : { saved: false },
          briefVersions: listVersions(path.join(p.dir, "brief"), "v", ".md"),
        };
      },
      /** One brief version with the diff to the one before (?version=N, default latest). */
      brief: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const versions = listVersions(path.join(p.dir, "brief"), "v", ".md");
        const v = q.get("version") ? Number(q.get("version")) : versions.at(-1);
        const read = (n: number) => fs.readFileSync(path.join(p.dir, "brief", `v${n}.md`), "utf8");
        if (v === undefined || !versions.includes(v))
          return { project: p.slug, versions, version: null, text: briefOf(p), diff: null };
        const prev = versions.filter((x) => x < v).at(-1);
        return {
          project: p.slug,
          versions,
          version: v,
          text: read(v),
          diff: prev !== undefined ? lineDiff(read(prev), read(v)) : null,
        };
      },
      /** Memory: every input (outdated included), sources and assets, lineage. */
      context: () => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const state = readState(p.dir) ?? p.state;
        const ctxDir = path.join(p.dir, "context");
        const files = fs.existsSync(ctxDir)
          ? fs
              .readdirSync(ctxDir, { recursive: true, withFileTypes: true })
              .filter((d) => d.isFile())
              .map((d) => {
                const abs = path.join(d.parentPath ?? ctxDir, d.name);
                return { path: rel(p.dir, abs), bytes: fs.statSync(abs).size };
              })
          : [];
        const inputs = readInputs(p.dir, { includeOutdated: true }).reverse();
        return {
          project: p.slug,
          inputs,
          sources: {
            files,
            refs: inputs
              .filter((i) => (i.kind === "source" || i.kind === "asset") && !i.outdated)
              .flatMap((i) => (i.refs ?? []).map((r) => ({ ref: r, input: i.id, text: i.text }))),
          },
          line: state.line,
          lineText: formatLine(state.line),
        };
      },
      /** Findings with state and evidence thumbnails. */
      findings: () => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const state = readState(p.dir) ?? p.state;
        const list = listFindings(p.dir, {
          appDir: appDirOf(p.dir, state.app),
          since: state.createdAt,
        });
        return {
          project: p.slug,
          findings: list.map((f) => ({
            ...f,
            media: f.evidence
              .map((e) => evidenceMedia(p, e))
              .filter(Boolean)
              .slice(0, 3),
          })),
        };
      },
    },
    post: {
      /** Two-phase: without confirm → the brief diff; with confirm → a new brief version (logged as an input). */
      "project-facts": (body) => {
        const p = requireProject();
        const patch = validateFactsPatch((body.patch ?? {}) as Record<string, unknown>);
        const before = briefOf(p);
        const after = setBriefFacts(before, patch);
        if (after === before) return { planned: true, unchanged: true, diff: "" };
        if (body.confirm !== true) return { planned: true, diff: lineDiff(before, after) };
        const v = writeNextVersion(path.join(p.dir, "brief"), "v", ".md", after);
        fs.writeFileSync(path.join(p.dir, "brief.md"), after);
        const changed = Object.keys(patch).join(", ");
        recordInput(p.dir, {
          stage: "brief",
          version: v.version,
          source: "panel",
          kind: "brief",
          text: `project facts edited in the panel (${changed}) → brief v${v.version}`,
          refs: [`brief/v${v.version}.md`],
        });
        deps.publish(
          "brief.written",
          { version: v.version, message: `brief v${v.version} (project facts: ${changed})` },
          p.slug,
        );
        deps.tellAgent(
          `[demo-panel] The user edited the project facts of "${p.slug}" (${changed}); brief.md is now v${v.version}. Re-read it (demo_rec_project context) before the next step.`,
        );
        return { saved: true, version: v.version };
      },
      "input-mark": (body) => {
        const p = requireProject();
        if (typeof body.id !== "string") throw new Error('"id" is required');
        const e = markInput(
          p.dir,
          body.id,
          body.outdated !== false,
          typeof body.reason === "string" ? body.reason : "",
        );
        deps.publish(
          "input.marked",
          { id: e.id, message: `${e.id} ${e.outdated ? "marked outdated" : "restored"}` },
          p.slug,
        );
        return { input: e };
      },
      "finding-mark": (body) => {
        const p = requireProject();
        if (typeof body.id !== "string") throw new Error('"id" is required');
        const state = body.state as FindingState;
        if (!FINDING_STATES.includes(state))
          throw new Error(`"state" must be ${FINDING_STATES.join(" | ")}`);
        const st = readState(p.dir) ?? p.state;
        const f = markFinding(p.dir, body.id, state, { appDir: appDirOf(p.dir, st.app) });
        deps.publish("finding.marked", { id: f.id, state, message: `${f.id} → ${state}` }, p.slug);
        if (state !== "auto")
          deps.tellAgent(
            `[demo-panel] The user marked finding ${f.id} ("${f.text.slice(0, 80)}") as ${state.toUpperCase()}${state === "use" ? " — it must appear in the recording and the narration (list it in a scene's findings:)" : " — never bring it up"}.`,
          );
        return { finding: f };
      },
    },
  };
}
