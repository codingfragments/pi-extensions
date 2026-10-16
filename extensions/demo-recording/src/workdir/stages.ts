/**
 * Branching stages (S5 part 4, D44–D46; supersedes the single-approval chain of D30/D33):
 *
 *   storyboard → recording → vo → annotations → render
 *
 * Every version of a stage is based on exactly one version of its parent
 * stage. The link is read from the artifacts themselves (no second source of
 * truth): a take's `take.json` names its storyboard version, a voice-over
 * script names its take, annotation and render versions carry `basedOn`.
 * Version numbers count up per stage; a recording's version is its take number.
 *
 * - **Accepted** (`state.json` `accepted.<stage>.<version> = acceptedAt`):
 *   "good enough to build on". Several versions per stage may be accepted;
 *   accepting resets nothing. A version can only be accepted when its parent
 *   is accepted and usable.
 * - **Usable**: accepted, and every ancestor accepted. An accepted version
 *   whose ancestor was un-accepted is **orphaned** (computed, never stored):
 *   it can't be an input or a final render until the ancestor is accepted again.
 * - **Working line** (`state.json` `line.<stage> = version`): the one line the
 *   panel shows and the agent works on. Default per stage: the most recently
 *   accepted usable child of the line's parent.
 *
 * Pure file reads only (no imports of the stores), so state.ts can use it.
 */

import fs from "node:fs";
import path from "node:path";

export const STAGES = ["storyboard", "recording", "vo", "annotations", "render"] as const;
export type Stage = (typeof STAGES)[number];

export const PARENT: Record<Stage, Stage | undefined> = {
  storyboard: undefined,
  recording: "storyboard",
  vo: "recording",
  annotations: "vo",
  render: "annotations",
};

export const STAGE_LABEL: Record<Stage, string> = {
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice-over",
  annotations: "annotations",
  render: "render",
};

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

export const downstreamOf = (stage: Stage): Stage[] => STAGES.slice(STAGES.indexOf(stage) + 1);

export const takeId = (n: number) => `take-${String(n).padStart(3, "0")}`;
export function takeNumber(id: string): number | undefined {
  const m = /^take-(\d{3,})$/.exec(id);
  return m ? Number(m[1]) : undefined;
}

/** Human label for a version: "storyboard v2", "recording take-006", "voice-over v3". */
export const versionLabel = (stage: Stage, v: number) =>
  stage === "recording" ? `recording ${takeId(v)}` : `${STAGE_LABEL[stage]} v${v}`;

function numbered(dir: string, re: RegExp): number[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => re.exec(f)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** All versions of a stage present on disk, ascending. */
export function stageVersions(projectDir: string, stage: Stage): number[] {
  switch (stage) {
    case "storyboard":
      return numbered(path.join(projectDir, "storyboard"), /^v(\d+)\.yaml$/);
    case "recording":
      return numbered(path.join(projectDir, "takes"), /^take-(\d{3,})$/).filter((n) =>
        fs.existsSync(path.join(projectDir, "takes", takeId(n), "take.json")),
      );
    case "vo":
      return numbered(path.join(projectDir, "vo"), /^script\.v(\d+)\.md$/);
    case "annotations":
      return numbered(path.join(projectDir, "annotations"), /^v(\d+)\.json$/);
    case "render":
      return numbered(path.join(projectDir, "render"), /^v(\d+)\.json$/);
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The parent version this version is based on (undefined: root stage, or unknown). */
export function parentOf(projectDir: string, stage: Stage, version: number): number | undefined {
  switch (stage) {
    case "storyboard":
      return undefined;
    case "recording": {
      const v = readJson(
        path.join(projectDir, "takes", takeId(version), "take.json"),
      )?.storyboardVersion;
      return typeof v === "number" ? v : undefined;
    }
    case "vo": {
      const file = path.join(projectDir, "vo", `script.v${version}.md`);
      if (!fs.existsSync(file)) return undefined;
      const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 30).join("\n");
      const take = /^take:\s*(take-\d{3,})\s*$/m.exec(head)?.[1];
      return take ? takeNumber(take) : undefined;
    }
    case "annotations":
    case "render": {
      const parent = PARENT[stage] as Stage;
      const b = readJson(path.join(projectDir, stage, `v${version}.json`))?.basedOn as
        | Record<string, unknown>
        | undefined;
      const v = b?.[parent];
      return typeof v === "number" ? v : undefined;
    }
  }
}

/** `accepted.<stage>["<version>"] = ISO time of acceptance`. */
export type Accepted = Partial<Record<Stage, Record<string, string>>>;
/** The working line: one version per stage (D46). */
export type WorkingLine = Partial<Record<Stage, number>>;

export function acceptedVersions(acc: Accepted, stage: Stage): number[] {
  return Object.keys(acc[stage] ?? {})
    .map(Number)
    .sort((a, b) => a - b);
}

export const isAccepted = (acc: Accepted, stage: Stage, v: number) =>
  acc[stage]?.[String(v)] !== undefined;

/** Why an accepted version is not usable (an ancestor isn't accepted); undefined when usable or not accepted. */
export function orphanReason(
  projectDir: string,
  acc: Accepted,
  stage: Stage,
  v: number,
): string | undefined {
  if (!isAccepted(acc, stage, v)) return undefined;
  let s: Stage = stage;
  let n: number | undefined = v;
  while (PARENT[s]) {
    const parent = PARENT[s] as Stage;
    const pv: number | undefined = parentOf(projectDir, s, n as number);
    if (pv === undefined) return `its ${STAGE_LABEL[parent]} is unknown`;
    if (!isAccepted(acc, parent, pv)) return `${versionLabel(parent, pv)} is not approved`;
    s = parent;
    n = pv;
  }
  return undefined;
}

/** Accepted and every ancestor accepted. */
export const isUsable = (projectDir: string, acc: Accepted, stage: Stage, v: number) =>
  isAccepted(acc, stage, v) && orphanReason(projectDir, acc, stage, v) === undefined;

/** Versions of `stage` built on `parentVersion` (root stage: all versions). */
export function childrenOf(
  projectDir: string,
  stage: Stage,
  parentVersion: number | undefined,
): number[] {
  const all = stageVersions(projectDir, stage);
  if (!PARENT[stage]) return all;
  if (parentVersion === undefined) return [];
  return all.filter((v) => parentOf(projectDir, stage, v) === parentVersion);
}

/** The most recently accepted usable child of `parentVersion` (root: of all versions). */
export function latestAcceptedChild(
  projectDir: string,
  acc: Accepted,
  stage: Stage,
  parentVersion: number | undefined,
): number | undefined {
  return childrenOf(projectDir, stage, parentVersion)
    .filter((v) => isUsable(projectDir, acc, stage, v))
    .sort((a, b) =>
      (acc[stage]?.[String(b)] ?? "") < (acc[stage]?.[String(a)] ?? "") ? -1 : 1,
    )[0];
}

/**
 * Make the working line consistent, top-down: keep a stage's selection while
 * it is usable and built on the line's parent; otherwise pick the most
 * recently accepted usable child. `from` = first stage to re-pick regardless.
 */
export function normalizeLine(
  projectDir: string,
  acc: Accepted,
  line: WorkingLine,
  from?: Stage,
): WorkingLine {
  const out: WorkingLine = {};
  let force = false;
  for (const stage of STAGES) {
    if (stage === from) force = true;
    const parent = PARENT[stage];
    const parentV = parent ? out[parent] : undefined;
    const cur = line[stage];
    const keep =
      !force &&
      cur !== undefined &&
      isUsable(projectDir, acc, stage, cur) &&
      (!parent || parentOf(projectDir, stage, cur) === parentV);
    const pick = keep
      ? cur
      : parent && parentV === undefined
        ? undefined
        : latestAcceptedChild(projectDir, acc, stage, parentV);
    if (pick !== undefined) out[stage] = pick;
    if (stage === from) force = true;
  }
  return out;
}

/** The line through `v`: its ancestors, `v` itself, and re-picked descendants. Throws unless `v` is usable. */
export function lineThrough(
  projectDir: string,
  acc: Accepted,
  line: WorkingLine,
  stage: Stage,
  v: number,
): WorkingLine {
  if (!isAccepted(acc, stage, v))
    throw new Error(`${versionLabel(stage, v)} is not approved — approve it first`);
  const why = orphanReason(projectDir, acc, stage, v);
  if (why) throw new Error(`${versionLabel(stage, v)} can't be used: ${why}`);
  const next: WorkingLine = { ...line, [stage]: v };
  let s: Stage = stage;
  let n = v;
  while (PARENT[s]) {
    const parent = PARENT[s] as Stage;
    n = parentOf(projectDir, s, n) as number;
    next[parent] = n;
    s = parent;
  }
  const idx = STAGES.indexOf(stage);
  for (const d of STAGES.slice(idx + 1)) delete next[d];
  return normalizeLine(projectDir, acc, next);
}

/** Check that `version` may be accepted: it exists and its parent is accepted and usable. */
export function checkAcceptable(
  projectDir: string,
  acc: Accepted,
  stage: Stage,
  version: number,
): void {
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`invalid ${STAGE_LABEL[stage]} version ${version}`);
  if (!stageVersions(projectDir, stage).includes(version))
    throw new Error(`${versionLabel(stage, version)} does not exist`);
  const parent = PARENT[stage];
  if (!parent) return;
  const pv = parentOf(projectDir, stage, version);
  if (pv === undefined)
    throw new Error(`${versionLabel(stage, version)} has no known ${STAGE_LABEL[parent]}`);
  if (!isAccepted(acc, parent, pv))
    throw new Error(
      `${versionLabel(stage, version)} is based on ${versionLabel(parent, pv)}, which is not approved — approve that ${STAGE_LABEL[parent]} first`,
    );
  const why = orphanReason(projectDir, acc, parent, pv);
  if (why)
    throw new Error(
      `${versionLabel(stage, version)} is based on ${versionLabel(parent, pv)}, which can't be used: ${why}`,
    );
}

export interface VersionRef {
  stage: Stage;
  version: number;
  label: string;
}

/** Accepted versions that become orphaned if `stage` v is un-accepted (D45). */
export function orphansIfUnaccepted(
  projectDir: string,
  acc: Accepted,
  stage: Stage,
  v: number,
): VersionRef[] {
  const out: VersionRef[] = [];
  let frontier = [v];
  let s: Stage = stage;
  for (const d of downstreamOf(stage)) {
    if (PARENT[d] !== s) break;
    const kids = frontier.flatMap((p) => childrenOf(projectDir, d, p));
    for (const k of kids)
      if (isAccepted(acc, d, k)) out.push({ stage: d, version: k, label: versionLabel(d, k) });
    frontier = kids;
    s = d;
  }
  return out;
}

export interface AcceptedInfo {
  version: number;
  at: string;
  basedOn?: number;
  /** Set when the version is accepted but an ancestor isn't (D45). */
  orphaned?: string;
}

export interface StageStatus {
  stage: Stage;
  versions: number[];
  latest?: number;
  accepted: AcceptedInfo[];
  /** The working line's version of this stage. */
  selected?: number;
  /** The working line's version of the parent stage (this stage's input). */
  input?: number;
  /** Versions built on the input (accepted or drafts). */
  onInput: number[];
}

export function stageStatus(projectDir: string, acc: Accepted, line: WorkingLine): StageStatus[] {
  return STAGES.map((stage) => {
    const versions = stageVersions(projectDir, stage);
    const parent = PARENT[stage];
    const input = parent ? line[parent] : undefined;
    const out: StageStatus = {
      stage,
      versions,
      accepted: acceptedVersions(acc, stage).map((v) => {
        const basedOn = parent ? parentOf(projectDir, stage, v) : undefined;
        const why = orphanReason(projectDir, acc, stage, v);
        return {
          version: v,
          at: acc[stage]?.[String(v)] as string,
          ...(basedOn !== undefined ? { basedOn } : {}),
          ...(why ? { orphaned: why } : {}),
        };
      }),
      onInput: parent
        ? input !== undefined
          ? childrenOf(projectDir, stage, input)
          : []
        : versions,
    };
    if (versions.length) out.latest = versions.at(-1) as number;
    if (line[stage] !== undefined) out.selected = line[stage];
    if (input !== undefined) out.input = input;
    return out;
  });
}

/** Compact lineage for tool output and the agent's project context. */
export function formatStageStatus(status: StageStatus[]): string {
  const v = (stage: Stage, n: number) => (stage === "recording" ? takeId(n) : `v${n}`);
  return status
    .map((s) => {
      const label = STAGE_LABEL[s.stage].padEnd(12);
      if (!s.versions.length) return `${label}—`;
      const parent = PARENT[s.stage];
      const acc = s.accepted.length
        ? s.accepted
            .map(
              (a) =>
                `${v(s.stage, a.version)}${parent && a.basedOn !== undefined ? ` (on ${v(parent, a.basedOn)})` : ""}${a.orphaned ? ` ⚠ orphaned: ${a.orphaned}` : ""}`,
            )
            .join(", ")
        : "none";
      return `${label}${s.versions.length} version(s), latest ${v(s.stage, s.latest as number)}; accepted: ${acc}; working line: ${s.selected !== undefined ? v(s.stage, s.selected) : "—"}`;
    })
    .join("\n");
}

/** The working line as one string: "storyboard v2 → recording take-006 → voice-over v3". */
export function formatLine(line: WorkingLine): string {
  const parts = STAGES.filter((s) => line[s] !== undefined).map((s) =>
    versionLabel(s, line[s] as number),
  );
  return parts.length ? parts.join(" → ") : "(nothing approved yet)";
}

export interface NextStep {
  /** Who has to act: the user (panel), the agent, or nobody. */
  who: "user" | "agent" | null;
  stage: Stage | null;
  text: string;
}

/**
 * What the working line waits for, top-down: the first stage without a
 * selection either has drafts on the line's input (the user reviews and
 * accepts one) or none (the agent produces one). Annotations/render join once
 * they exist (S5 parts 8/9); until then a selected voice-over is the end.
 */
export function nextStep(
  projectDir: string,
  acc: Accepted,
  line: WorkingLine,
  opts: { rendered?: boolean } = {},
): NextStep {
  for (const stage of STAGES) {
    if (line[stage] !== undefined) continue;
    const parent = PARENT[stage];
    const input = parent ? line[parent] : undefined;
    const drafts = childrenOf(projectDir, stage, input);
    if ((stage === "annotations" || stage === "render") && !stageVersions(projectDir, stage).length)
      break;
    if (stage === "render") {
      // Drafts can't be accepted (D67): the user renders a final, then accepts it.
      const finals = drafts.filter((v) => {
        const r = readJson(path.join(projectDir, "render", `v${v}.json`));
        return r?.kind === "final" && r.status === "done" && !r.deleted && !r.pruned;
      });
      if (finals.length)
        return {
          who: "user",
          stage,
          text: `review and approve final ${versionLabel(stage, finals.at(-1) as number)}`,
        };
      return { who: "user", stage, text: "render a final in the Render tab" };
    }
    if (drafts.length) {
      const latest = drafts.at(-1) as number;
      const what =
        stage === "recording"
          ? `approve a take of ${versionLabel("storyboard", input as number)} (e.g. ${takeId(latest)})`
          : `review and approve ${versionLabel(stage, latest)}`;
      return { who: "user", stage, text: what };
    }
    const waiting: Record<Stage, string> = {
      storyboard: "the agent explores the app and writes the storyboard",
      recording: `the agent records a take of ${input !== undefined ? versionLabel("storyboard", input) : "the storyboard"}`,
      vo: `the agent writes the voice-over for ${input !== undefined ? takeId(input) : "the take"}`,
      annotations: "the agent suggests annotations",
      render: "render the video",
    };
    return { who: "agent", stage, text: waiting[stage] };
  }
  if (line.render !== undefined)
    return {
      who: null,
      stage: null,
      text: `delivered — final ${versionLabel("render", line.render)} (Render tab)`,
    };
  return opts.rendered
    ? { who: null, stage: null, text: "rendered — see the Render tab" }
    : {
        who: "agent",
        stage: "vo",
        text: "voice-over approved — generate the voice and render (demo_rec_tts, demo_rec_edit)",
      };
}
