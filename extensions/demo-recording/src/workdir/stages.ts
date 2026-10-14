/**
 * The stage chain (S5 part 3, D30/D33):
 *
 *   storyboard → recording → vo → annotations → render
 *
 * Every version of a stage is based on exactly one version of its parent
 * stage. The link is read from the artifacts themselves (no second source of
 * truth): a take's `take.json` names its storyboard version, a voice-over
 * script names its take, annotation and render versions carry `basedOn`.
 * Version numbers count up per stage; a recording's version is its take number.
 *
 * Approvals live in `state.json` (`approved.<stage>`). Approving a version
 * requires its parent to be the approved parent version, and resets every
 * downstream approval that no longer chains up to it (cascade reset). Stale
 * flags are computed, never stored, so they can't drift from the files.
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

export type Approvals = Partial<Record<Stage, number>>;

export interface ApprovalReset {
  stage: Stage;
  version: number;
  reason: string;
}

/**
 * Drop every approval whose parent is not the approved parent version,
 * walking the chain top-down (so one break resets everything below it).
 * Mutates `approved`; returns what was reset.
 */
export function cascade(projectDir: string, approved: Approvals): ApprovalReset[] {
  const resets: ApprovalReset[] = [];
  for (const stage of STAGES) {
    const parent = PARENT[stage];
    const v = approved[stage];
    if (!parent || v === undefined) continue;
    const want = approved[parent];
    const got = parentOf(projectDir, stage, v);
    if (want === undefined || got !== want) {
      delete approved[stage];
      resets.push({
        stage,
        version: v,
        reason:
          want === undefined
            ? `its ${STAGE_LABEL[parent]} is no longer approved`
            : `based on ${got === undefined ? `an unknown ${STAGE_LABEL[parent]}` : versionLabel(parent, got)}, but ${versionLabel(parent, want)} is approved`,
      });
    }
  }
  return resets;
}

/**
 * Check that `version` may be approved: it exists and (unless it's the root
 * stage) it is based on the approved parent version. Throws with a clear message.
 */
export function checkApprovable(
  projectDir: string,
  approved: Approvals,
  stage: Stage,
  version: number,
): void {
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`invalid ${STAGE_LABEL[stage]} version ${version}`);
  if (!stageVersions(projectDir, stage).includes(version))
    throw new Error(`${versionLabel(stage, version)} does not exist`);
  const parent = PARENT[stage];
  if (!parent) return;
  const want = approved[parent];
  if (want === undefined)
    throw new Error(
      `approve the ${STAGE_LABEL[parent]} first — ${versionLabel(stage, version)} needs an approved ${STAGE_LABEL[parent]}`,
    );
  const got = parentOf(projectDir, stage, version);
  if (got !== want)
    throw new Error(
      `${versionLabel(stage, version)} is based on ${got === undefined ? `an unknown ${STAGE_LABEL[parent]}` : versionLabel(parent, got)}, but ${versionLabel(parent, want)} is approved — work on a version based on it, or approve that ${STAGE_LABEL[parent]} first`,
    );
}

export interface StageStatus {
  stage: Stage;
  versions: number[];
  latest?: number;
  approved?: number;
  /** Parent of the latest version. */
  latestBasedOn?: number;
  /** Set when the latest version is not based on the approved parent (or no parent is approved). */
  stale?: string;
}

/** Status of every stage: versions, approval, and whether the latest draft is stale. */
export function stageStatus(projectDir: string, approved: Approvals): StageStatus[] {
  return STAGES.map((stage) => {
    const versions = stageVersions(projectDir, stage);
    const latest = versions.at(-1);
    const out: StageStatus = { stage, versions };
    if (latest !== undefined) out.latest = latest;
    if (approved[stage] !== undefined) out.approved = approved[stage];
    const parent = PARENT[stage];
    if (parent && latest !== undefined) {
      const basedOn = parentOf(projectDir, stage, latest);
      if (basedOn !== undefined) out.latestBasedOn = basedOn;
      const want = approved[parent];
      if (latest !== approved[stage]) {
        if (want === undefined) out.stale = `no approved ${STAGE_LABEL[parent]}`;
        else if (basedOn !== want)
          out.stale = `based on ${basedOn === undefined ? `an unknown ${STAGE_LABEL[parent]}` : versionLabel(parent, basedOn)}; approved is ${versionLabel(parent, want)}`;
      }
    }
    return out;
  });
}

/** Compact multi-line lineage for tool output. */
export function formatStageStatus(status: StageStatus[]): string {
  return status
    .map((s) => {
      const label = STAGE_LABEL[s.stage].padEnd(12);
      if (!s.versions.length) return `${label}—`;
      const v = (n: number) => (s.stage === "recording" ? takeId(n) : `v${n}`);
      const parent = PARENT[s.stage];
      const based =
        parent && s.latestBasedOn !== undefined
          ? ` (latest based on ${parent === "recording" ? takeId(s.latestBasedOn) : `v${s.latestBasedOn}`})`
          : "";
      return `${label}${s.versions.length} version(s), latest ${v(s.latest as number)}${based}; approved ${s.approved !== undefined ? v(s.approved) : "none"}${s.stale ? `  ⚠ latest is stale: ${s.stale}` : ""}`;
    })
    .join("\n");
}

/** Dry run of an approval: what would be reset. Throws like a real approval would. */
export function previewApproval(
  projectDir: string,
  approved: Approvals,
  stage: Stage,
  version: number,
): ApprovalReset[] {
  const copy: Approvals = { ...approved };
  checkApprovable(projectDir, copy, stage, version);
  copy[stage] = version;
  return cascade(projectDir, copy);
}

export interface NextStep {
  /** Who has to act: the user (panel), the agent, or nobody. */
  who: "user" | "agent" | null;
  stage: Stage | null;
  text: string;
}

/**
 * What the project is waiting for, walking the chain top-down: the first
 * stage without an approval either has a fresh draft (the user reviews it)
 * or none yet (the agent produces it). Annotations/render join the walk once
 * they exist (S5 parts 8/9); until then an approved voice-over is the end.
 */
export function nextStep(
  projectDir: string,
  approved: Approvals,
  opts: { rendered?: boolean } = {},
): NextStep {
  const status = stageStatus(projectDir, approved);
  const byStage = Object.fromEntries(status.map((s) => [s.stage, s])) as Record<Stage, StageStatus>;
  for (const stage of STAGES) {
    const s = byStage[stage];
    if (s.approved !== undefined) continue;
    if ((stage === "annotations" || stage === "render") && !s.versions.length) break;
    const fresh = s.latest !== undefined && !s.stale;
    if (fresh) {
      const what =
        stage === "recording"
          ? `accept ${takeId(s.latest as number)} (Recording tab)`
          : `review and approve ${versionLabel(stage, s.latest as number)}`;
      return { who: "user", stage, text: what };
    }
    const parent = PARENT[stage];
    const waiting: Record<Stage, string> = {
      storyboard: "the agent explores the app and writes the storyboard",
      recording: `the agent records a take of ${parent && approved[parent] ? versionLabel(parent, approved[parent] as number) : "the storyboard"}`,
      vo: `the agent writes the voice-over for ${approved.recording ? takeId(approved.recording) : "the take"}`,
      annotations: "the agent suggests annotations",
      render: "render the video",
    };
    return { who: "agent", stage, text: waiting[stage] };
  }
  return opts.rendered
    ? { who: null, stage: null, text: "rendered — see the Render tab" }
    : {
        who: "agent",
        stage: "vo",
        text: "voice-over approved — generate the voice and render (demo_rec_tts, demo_rec_edit)",
      };
}
