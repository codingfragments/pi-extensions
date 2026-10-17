/**
 * The project graph (UX4, D112, D113, docs/UX.md §4): every version of every stage, how they depend on
 * each other, and where each stands. Read-only and computed from the files, so it cannot disagree with
 * them; it stores nothing.
 *
 * Nodes (the first cut, decided in the UX4 grill): the versions of the five stages, the draft renders
 * (also folded into one "Drafts ×N" node per parent), and one small QA node under each final that has a
 * QA result. Media files (audio, timelines, scene videos, subtitles, posters) are not nodes; a render
 * node says how many variants it has and the panel lists the files of the selected render.
 *
 * Edges:
 *   depends-on  `from` is the dependency, `to` depends on it (storyboard v1 → take-001 → voice-over v2 …).
 *               Only RECORDED links: a version's own parent, or, for a draft render made before any
 *               annotations existed, the voice-over version the render recorded. Never inferred from
 *               version order or file names. A version whose parent is not recorded has `unknownLink`
 *               (with the reason) and no depends-on edge.
 *   contains    a render owns its QA report.
 *
 * Statuses are separate fields, never one merged label: approved, usable (approved and nothing it depends
 * on is unapproved), blocked, inLine, availability, review.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readAnnotations } from "../annotations/file.ts";
import { versionHistory } from "../panel/version-actions.ts";
import { readRender } from "../render/store.ts";
import { readStoryboard } from "../storyboard/store.ts";
import {
  PARENT,
  STAGES,
  STAGE_LABEL,
  type Stage,
  stageVersions,
  takeId,
} from "../workdir/stages.ts";
import { type ProjectState, readState } from "../workdir/state.ts";

export type NodeKind = "version" | "drafts" | "qa";
export type Availability = "present" | "deleted" | "pruned";

export interface GraphNode {
  /** Stable: `<stage>:<version>`, `qa:render:<version>`, `drafts:render:<parent id>`. */
  id: string;
  kind: NodeKind;
  stage: Stage;
  version?: number;
  /** "Storyboard v2", "Recording take-001", "Final render v8", "Drafts ×4", "QA passed". */
  label: string;
  /** v2, take-001, v8 */
  short: string;
  /** One line about it: "5 scenes", "2:31", "12 enabled", "1920×1080". */
  meta: string;
  approved: boolean;
  /** Approved and nothing it depends on is unapproved. */
  usable: boolean;
  /** Why an approved version is not usable. */
  blocked: string | null;
  inLine: boolean;
  /** A version that is not approved (a draft version), or a draft render. */
  draft: boolean;
  /** A draft newer than the newest approved version on its input: it waits for you. */
  review: "waiting" | null;
  availability: Availability;
  /** Why its parent is not known (older or damaged records). */
  unknownLink: string | null;
  at: string | null;
  render?: {
    kind: "draft" | "final";
    status: string;
    variants: { key: string; brand: string; bytes: number; present: boolean }[];
    size: { width: number; height: number };
  };
  qa?: { status: string; blocking: number; warnings: number; confirmed: number };
  /** drafts node: the draft renders folded into it; draft render: the group it is part of. */
  members?: string[];
  group?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: "depends-on" | "contains";
  /** A recorded direct link that skips a stage (a draft render made before annotations existed). */
  direct?: boolean;
}

export interface Graph {
  project: string;
  /** The production line: stage → node id. */
  line: Partial<Record<Stage, string>>;
  stages: { stage: Stage; label: string }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Changes whenever what the graph shows changes (the panel's "updated" indicator compares it). */
  rev: string;
  generatedAt: string;
}

const id = (stage: Stage, v: number) => `${stage}:${v}`;
const shortOf = (stage: Stage, v: number) => (stage === "recording" ? takeId(v) : `v${v}`);

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const mmss = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** One line about a version, cheap and never throwing. */
function metaOf(projectDir: string, stage: Stage, v: number): string {
  try {
    switch (stage) {
      case "storyboard": {
        const n = readStoryboard(projectDir, v)?.storyboard.scenes.length;
        return n === undefined ? "" : `${n} scene${n === 1 ? "" : "s"}`;
      }
      case "recording": {
        const t = readJson(path.join(projectDir, "takes", takeId(v), "take.json"));
        return typeof t?.durationMs === "number" ? mmss(t.durationMs) : "";
      }
      case "annotations": {
        const f = readAnnotations(projectDir, v);
        return f ? `${f.items.filter((i) => i.enabled).length} enabled` : "";
      }
      default:
        return "";
    }
  } catch {
    return "unreadable";
  }
}

/** Why a version's parent is not known, in plain words. */
const UNKNOWN: Record<Stage, string> = {
  storyboard: "",
  recording: "its take.json does not record a storyboard version",
  vo: "its script does not name a take",
  annotations: "it does not record the voice-over it is based on",
  render: "it does not record the annotations or voice-over it was made from",
};

/** The files whose times decide whether a cached graph is still right. */
function signature(projectDir: string): string {
  const parts: string[] = [];
  const stamp = (f: string) => {
    try {
      const s = fs.statSync(f);
      parts.push(`${path.relative(projectDir, f)}:${s.mtimeMs}:${s.size}`);
    } catch {
      parts.push(`${path.relative(projectDir, f)}:-`);
    }
  };
  stamp(path.join(projectDir, "state.json"));
  for (const stage of STAGES)
    for (const v of stageVersions(projectDir, stage))
      stamp(
        stage === "storyboard"
          ? path.join(projectDir, "storyboard", `v${v}.yaml`)
          : stage === "recording"
            ? path.join(projectDir, "takes", takeId(v), "take.json")
            : stage === "vo"
              ? path.join(projectDir, "vo", `script.v${v}.md`)
              : path.join(projectDir, stage, `v${v}.json`),
      );
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

const cache = new Map<string, { sig: string; graph: Graph }>();

/** The graph of a project, cached until a record it reads changes. Read-only. */
export function projectGraph(projectDir: string, slug: string, state?: ProjectState): Graph {
  const st = state ?? readState(projectDir);
  if (!st) throw new Error(`no state.json in ${projectDir}`);
  const sig = signature(projectDir);
  const hit = cache.get(projectDir);
  if (hit && hit.sig === sig) return hit.graph;
  const graph = buildGraph(projectDir, slug, st);
  cache.set(projectDir, { sig, graph });
  return graph;
}

export function buildGraph(projectDir: string, slug: string, state: ProjectState): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const have = new Set<string>();
  const line: Graph["line"] = {};
  const history = new Map<Stage, ReturnType<typeof versionHistory>>();

  for (const stage of STAGES) {
    const rows = versionHistory(projectDir, state, stage);
    history.set(stage, rows);
    const approvedOnInput = rows.filter((r) => r.approved && r.onInput).map((r) => r.version);
    const newestApproved = Math.max(0, ...approvedOnInput);
    for (const r of rows) {
      const node: GraphNode = {
        id: id(stage, r.version),
        kind: "version",
        stage,
        version: r.version,
        label: r.label
          .replace(/^render /, r.kind === "final" ? "Final render " : "Draft render ")
          .replace(/^[a-z]/, (c) => c.toUpperCase()),
        short: r.short,
        meta: metaOf(projectDir, stage, r.version),
        approved: r.approved,
        usable: r.approved && !r.blocked,
        blocked: r.blocked,
        inLine: r.inLine,
        draft: !r.approved,
        review:
          !r.approved && r.onInput && r.version > newestApproved && stage !== "render"
            ? "waiting"
            : null,
        availability: "present",
        unknownLink: null,
        at: r.at,
      };
      if (r.inLine) line[stage] = node.id;
      if (stage === "render") {
        const rec = readRender(projectDir, r.version);
        if (rec) {
          node.render = {
            kind: rec.kind,
            status: rec.status,
            variants: rec.variants.map((v) => ({
              key: v.key,
              brand: v.brand,
              bytes: v.bytes,
              present: !rec.deleted && !rec.pruned,
            })),
            size: rec.size,
          };
          node.meta = `${rec.size.width}×${rec.size.height}${rec.status === "done" ? "" : ` · ${rec.status}`}`;
          node.availability = rec.deleted ? "deleted" : rec.pruned ? "pruned" : "present";
          node.draft = rec.kind === "draft" || !r.approved;
          if (rec.kind === "final" && rec.qa) {
            const q = rec.qa;
            node.qa = {
              status: q.status,
              blocking: q.blocking,
              warnings: q.warnings,
              confirmed: q.confirmed,
            };
          }
        }
      }
      nodes.push(node);
      have.add(node.id);
    }
  }

  // the recorded parent of every version
  for (const n of nodes) {
    if (n.kind !== "version" || n.version === undefined) continue;
    const parentStage = PARENT[n.stage];
    if (!parentStage) continue;
    const row = history.get(n.stage)?.find((r) => r.version === n.version);
    const based = row?.basedOn;
    if (based && have.has(id(based.stage, based.version))) {
      edges.push({ from: id(based.stage, based.version), to: n.id, rel: "depends-on" });
      continue;
    }
    // a draft render made before annotations existed records the voice-over it came from
    if (n.stage === "render") {
      const rec = readRender(projectDir, n.version);
      if (
        rec &&
        rec.basedOn.annotations === undefined &&
        typeof rec.voVersion === "number" &&
        have.has(id("vo", rec.voVersion))
      ) {
        edges.push({ from: id("vo", rec.voVersion), to: n.id, rel: "depends-on", direct: true });
        continue;
      }
    }
    n.unknownLink =
      based && !have.has(id(based.stage, based.version))
        ? `it records ${based.label}, which no longer exists`
        : UNKNOWN[n.stage];
  }

  // QA reports sit under their final
  for (const n of [...nodes]) {
    if (!n.qa || n.version === undefined) continue;
    const qa: GraphNode = {
      id: `qa:render:${n.version}`,
      kind: "qa",
      stage: "render",
      label:
        n.qa.status === "pass"
          ? "QA passed"
          : n.qa.status === "blocked"
            ? `QA: ${n.qa.blocking - n.qa.confirmed} hard stop(s)`
            : n.qa.status === "confirmed"
              ? "QA confirmed"
              : "QA error",
      short: "QA",
      meta: `${n.qa.warnings} warning${n.qa.warnings === 1 ? "" : "s"}`,
      approved: false,
      usable: n.usable,
      blocked: null,
      inLine: n.inLine,
      draft: false,
      review: null,
      availability: "present",
      unknownLink: null,
      at: n.at,
      qa: n.qa,
    };
    nodes.push(qa);
    edges.push({ from: n.id, to: qa.id, rel: "contains" });
  }

  // draft renders under the same dependency fold into one node (two or more)
  const drafts = nodes.filter(
    (n) => n.stage === "render" && n.kind === "version" && n.render?.kind === "draft",
  );
  const byParent = new Map<string, GraphNode[]>();
  for (const d of drafts) {
    const parent = edges.find((e) => e.to === d.id && e.rel === "depends-on")?.from ?? "none";
    byParent.set(parent, [...(byParent.get(parent) ?? []), d]);
  }
  for (const [parent, list] of byParent) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.version ?? 0) - (b.version ?? 0)); // stable and ascending, whatever the read order
    const gid = `drafts:render:${parent}`;
    nodes.push({
      id: gid,
      kind: "drafts",
      stage: "render",
      label: `Drafts ×${list.length}`,
      short: `×${list.length}`,
      meta: `${list.length} draft renders`,
      approved: false,
      usable: list.every((d) => d.usable),
      blocked: null,
      inLine: false,
      draft: true,
      review: null,
      availability: list.every((d) => d.availability === "present")
        ? "present"
        : list.some((d) => d.availability === "present")
          ? "present"
          : "pruned",
      unknownLink: parent === "none" ? UNKNOWN.render : null,
      at:
        list
          .map((d) => d.at ?? "")
          .sort()
          .at(-1) || null,
      members: list.map((d) => d.id),
    });
    for (const d of list) d.group = gid;
    if (parent !== "none") edges.push({ from: parent, to: gid, rel: "depends-on" });
  }

  const rev = createHash("sha1")
    .update(
      JSON.stringify([
        nodes.map((n) => [
          n.id,
          n.approved,
          n.blocked,
          n.inLine,
          n.availability,
          n.qa?.status,
          n.qa?.blocking,
        ]),
        edges.map((e) => [e.from, e.to]),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    project: slug,
    line,
    stages: STAGES.map((stage) => ({ stage, label: STAGE_LABEL[stage] })),
    nodes,
    edges,
    rev,
    generatedAt: new Date().toISOString(),
  };
}
