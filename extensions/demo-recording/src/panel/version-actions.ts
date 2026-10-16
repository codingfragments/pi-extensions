/**
 * Version actions with an explicit, previewable consequence (UX3, D118, docs/UX.md §3).
 *
 *   Approve & use     approve it and make it part of the production line
 *   Approve only      approve it and leave the line exactly as it is
 *   Use for next steps put an already approved version on the line
 *   Withdraw approval take the approval back; what was built on it becomes "blocked by dependency"
 *
 * `planVersionAction` is a free dry run: what would change, or why it can't be done, and a token for
 * the state it looked at. `applyVersionAction` re-plans and refuses when the token no longer matches,
 * so a plan the user looked at is never applied to a project that moved on. Approving never deletes
 * anything: other approved versions and all files stay.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readDraft } from "../annotations/draft.ts";
import { readAnnotations } from "../annotations/file.ts";
import { qaBlocker } from "../qa/run.ts";
import { readRender } from "../render/store.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { readVo } from "../vo/store.ts";
import {
  type Accepted,
  PARENT,
  STAGES,
  STAGE_LABEL,
  type Stage,
  type VersionRef,
  type WorkingLine,
  checkAcceptable,
  formatLine,
  isAccepted,
  lineThrough,
  normalizeLine,
  orphanReason,
  orphansIfUnaccepted,
  parentOf,
  stageVersions,
  takeId,
  versionLabel,
} from "../workdir/stages.ts";
import {
  type ProjectState,
  approveVersion,
  readState,
  selectStage,
  unacceptStage,
} from "../workdir/state.ts";

export type Intent = "approve-use" | "approve-only" | "use" | "withdraw";
export const INTENTS: readonly Intent[] = ["approve-use", "approve-only", "use", "withdraw"];

/** The short label of a version inside its stage: v3, or take-003. */
export const shortLabel = (stage: Stage, v: number) =>
  stage === "recording" ? takeId(v) : `v${v}`;

export interface LineChange {
  stage: Stage;
  stageLabel: string;
  from: string | null;
  to: string | null;
}

export interface VersionPlan {
  intent: Intent;
  stage: Stage;
  version: number;
  /** "recording take-003", "voice-over v2" */
  label: string;
  /** Why it can't be done. Empty = it can. */
  blockers: string[];
  approval: { before: boolean; after: boolean };
  /** The production line before and after, and what differs. */
  line: { before: string; after: string; changes: LineChange[] };
  /** Withdraw: approved versions built on it that become "blocked by dependency". */
  blocked: VersionRef[];
  /** The state this plan was made for: pass it back to apply. */
  token: string;
}

/** A fingerprint of what a plan depends on. */
export function stateToken(state: Pick<ProjectState, "accepted" | "line">): string {
  return createHash("sha1")
    .update(JSON.stringify({ a: state.accepted, l: state.line }))
    .digest("hex")
    .slice(0, 12);
}

/**
 * The gate that decides whether a version may be approved at all (the same checks for the older
 * `approve` route and the new actions). Throws with the reason.
 */
export function assertApprovable(projectDir: string, stage: Stage, version: number): void {
  if (!stageVersions(projectDir, stage).includes(version))
    throw new Error(`${versionLabel(stage, version)} does not exist`);
  if (stage === "render") {
    const r = readRender(projectDir, version);
    if (!r) throw new Error(`render v${version} does not exist`);
    if (r.kind !== "final")
      throw new Error("only final renders can be approved — drafts are for watching");
    if (r.status !== "done") throw new Error(`render v${version} is ${r.status}`);
    if (r.deleted || r.pruned)
      throw new Error(`render v${version} has no files any more — render it again`);
    const why = qaBlocker(r);
    if (why) throw new Error(why);
  }
  if (stage === "annotations") {
    if (!readAnnotations(projectDir, version))
      throw new Error(`annotations v${version} do not exist`);
    if (readDraft(projectDir)?.base === version)
      throw new Error(
        `annotations v${version} have unsaved changes — save them (as a new version) or discard them first`,
      );
  }
  if (stage === "storyboard" && !readStoryboard(projectDir, version))
    throw new Error(`storyboard v${version} does not exist`);
  if (stage === "vo") {
    const vo = readVo(projectDir, version);
    if (!vo) throw new Error(`voice-over v${version} does not exist`);
    if (vo.validated.issues.some((i) => i.level === "error"))
      throw new Error(`voice-over v${version} has errors — fix them first`);
  }
}

/** A take that did not complete can't be approved (the panel used to enforce this only by disabling the button). */
function assertTakeComplete(projectDir: string, version: number): void {
  try {
    const t = JSON.parse(
      fs.readFileSync(path.join(projectDir, "takes", takeId(version), "take.json"), "utf8"),
    ) as { status?: string };
    if (t.status !== undefined && t.status !== "ok")
      throw new Error(`recording ${takeId(version)} did not complete`);
  } catch (e) {
    if ((e as Error).message.includes("did not complete")) throw e;
    // an unreadable take.json is the gate's business elsewhere
  }
}

const sameLine = (a: WorkingLine, b: WorkingLine) => JSON.stringify(a) === JSON.stringify(b);

function lineChanges(projectDir: string, before: WorkingLine, after: WorkingLine): LineChange[] {
  const out: LineChange[] = [];
  for (const stage of STAGES) {
    if (before[stage] === after[stage]) continue;
    out.push({
      stage,
      stageLabel: STAGE_LABEL[stage],
      from: before[stage] === undefined ? null : shortLabel(stage, before[stage] as number),
      to: after[stage] === undefined ? null : shortLabel(stage, after[stage] as number),
    });
  }
  return out;
}

/** What `intent` would do to `version`, without doing it. Never throws for an ordinary refusal: it lists blockers. */
export function planVersionAction(
  projectDir: string,
  state: ProjectState,
  req: { stage: Stage; version: number; intent: Intent },
): VersionPlan {
  const { stage, version, intent } = req;
  const label = versionLabel(stage, version);
  const acc: Accepted = state.accepted;
  const approved = isAccepted(acc, stage, version);
  const blockers: string[] = [];
  let after: WorkingLine = state.line;
  let accAfter: Accepted = acc;
  let blocked: VersionRef[] = [];
  const grant = (): Accepted => ({
    ...acc,
    [stage]: { ...(acc[stage] ?? {}), [String(version)]: "plan" },
  });

  if (!stageVersions(projectDir, stage).includes(version)) {
    blockers.push(`${label} does not exist`);
  } else if (intent === "approve-use" || intent === "approve-only") {
    if (approved)
      blockers.push(
        `${label} is already approved${isUsableHere(projectDir, acc, stage, version) ? ' — use "Use for next steps" to put it in the production line' : ""}`,
      );
    else {
      try {
        assertApprovable(projectDir, stage, version);
        if (stage === "recording") assertTakeComplete(projectDir, version);
        checkAcceptable(projectDir, acc, stage, version);
      } catch (e) {
        blockers.push((e as Error).message);
      }
    }
    if (!blockers.length) {
      accAfter = grant();
      if (intent === "approve-use") {
        try {
          after = lineThrough(projectDir, accAfter, state.line, stage, version);
        } catch (e) {
          blockers.push((e as Error).message);
        }
      } else {
        after = normalizeLine(projectDir, accAfter, state.line);
        if (!sameLine(after, state.line)) {
          blockers.push(
            `Approve only is not available: nothing else is in the production line here, so approving ${label} would make it the line. Use "Approve & use".`,
          );
          after = state.line;
        }
      }
    }
  } else if (intent === "use") {
    if (!approved) blockers.push(`${label} is not approved — approve it first`);
    else {
      const why = orphanReason(projectDir, acc, stage, version);
      if (why) blockers.push(`${label} is blocked by dependency: ${why}`);
      else {
        after = lineThrough(projectDir, acc, state.line, stage, version);
        if (sameLine(after, state.line))
          blockers.push(`${label} is already in the production line`);
      }
    }
  } else if (!approved) {
    blockers.push(`${label} is not approved`);
  } else {
    blocked = orphansIfUnaccepted(projectDir, acc, stage, version);
    accAfter = { ...acc, [stage]: { ...(acc[stage] ?? {}) } };
    delete (accAfter[stage] as Record<string, string>)[String(version)];
    after = normalizeLine(projectDir, accAfter, state.line);
  }

  return {
    intent,
    stage,
    version,
    label,
    blockers,
    approval: {
      before: approved,
      after:
        intent === "withdraw"
          ? false
          : intent === "use"
            ? approved
            : blockers.length
              ? approved
              : true,
    },
    line: {
      before: formatLine(state.line),
      after: formatLine(after),
      changes: lineChanges(projectDir, state.line, after),
    },
    blocked,
    token: stateToken(state),
  };
}

function isUsableHere(projectDir: string, acc: Accepted, stage: Stage, v: number): boolean {
  return orphanReason(projectDir, acc, stage, v) === undefined;
}

/** A plan that no longer matches the project: the user has to look again. */
export class StalePlanError extends Error {
  constructor() {
    super("the project changed since you looked at this — review it again");
    this.name = "StalePlanError";
  }
}

export interface Applied {
  plan: VersionPlan;
  state: ProjectState;
  /** Withdraw: what became blocked. */
  orphaned: VersionRef[];
}

/**
 * Do it, atomically and only if the project is still as planned. Validates before it mutates; one
 * state write per action (never "approve", then "use" as two steps).
 */
export function applyVersionAction(
  projectDir: string,
  req: { stage: Stage; version: number; intent: Intent; token: string },
): Applied {
  const state = readState(projectDir);
  if (!state) throw new Error(`no state.json in ${projectDir}`);
  const plan = planVersionAction(projectDir, state, req);
  if (plan.token !== req.token) throw new StalePlanError();
  if (plan.blockers.length) throw new Error(plan.blockers.join("; "));
  const { stage, version } = req;
  switch (req.intent) {
    case "approve-use":
      return { plan, state: approveVersion(projectDir, stage, version, "use"), orphaned: [] };
    case "approve-only":
      return { plan, state: approveVersion(projectDir, stage, version, "only"), orphaned: [] };
    case "use":
      return { plan, state: selectStage(projectDir, stage, version), orphaned: [] };
    case "withdraw": {
      const r = unacceptStage(projectDir, stage, version);
      return { plan, state: r.state, orphaned: r.orphaned };
    }
  }
}

// ---------------------------------------------------------------- history

export interface HistoryRow {
  version: number;
  /** v3, or take-003 */
  short: string;
  label: string;
  basedOn: { stage: Stage; version: number; short: string; label: string } | null;
  approved: boolean;
  approvedAt: string | null;
  /** Approved, but something it is built on is not: why. */
  blocked: string | null;
  inLine: boolean;
  /** On the working input: built on the version of the parent that is in the line (always true for the first stage). */
  onInput: boolean;
  /** When the file was last written (best effort). */
  at: string | null;
  /** Render only. */
  kind?: "draft" | "final";
}

function versionFile(projectDir: string, stage: Stage, v: number): string {
  switch (stage) {
    case "storyboard":
      return path.join(projectDir, "storyboard", `v${v}.yaml`);
    case "recording":
      return path.join(projectDir, "takes", takeId(v), "take.json");
    case "vo":
      return path.join(projectDir, "vo", `script.v${v}.md`);
    case "annotations":
      return path.join(projectDir, "annotations", `v${v}.json`);
    case "render":
      return path.join(projectDir, "render", `v${v}.json`);
  }
}

/** Every version of a stage, newest first, with where it stands. Read-only. */
export function versionHistory(
  projectDir: string,
  state: Pick<ProjectState, "accepted" | "line">,
  stage: Stage,
): HistoryRow[] {
  const parent = PARENT[stage];
  return stageVersions(projectDir, stage)
    .map((v): HistoryRow => {
      const based = parent ? parentOf(projectDir, stage, v) : undefined;
      let at: string | null = null;
      try {
        at = fs.statSync(versionFile(projectDir, stage, v)).mtime.toISOString();
      } catch {
        // no file time: the row just has no date
      }
      const approved = isAccepted(state.accepted, stage, v);
      const row: HistoryRow = {
        version: v,
        short: shortLabel(stage, v),
        label: versionLabel(stage, v),
        basedOn:
          parent && based !== undefined
            ? {
                stage: parent,
                version: based,
                short: shortLabel(parent, based),
                label: versionLabel(parent, based),
              }
            : null,
        approved,
        approvedAt: state.accepted[stage]?.[String(v)] ?? null,
        blocked: approved ? (orphanReason(projectDir, state.accepted, stage, v) ?? null) : null,
        inLine: state.line[stage] === v,
        onInput: !parent || based === undefined ? !parent : based === state.line[parent],
        at,
      };
      if (stage === "render") {
        const r = readRender(projectDir, v);
        if (r) row.kind = r.kind;
      }
      return row;
    })
    .reverse();
}
