/**
 * Project state (`state.json`) — phase, accepted versions, working line, history.
 *
 * Human gates (IMPLEMENTATION_PLAN §1 principle 1) are enforced here, not in
 * prompts. Schema 3 (S5 part 4, D44–D47):
 * - `accepted.<stage>.<version> = acceptedAt` — several per stage; accepting
 *   needs the parent accepted and usable, and resets nothing.
 * - `line.<stage> = version` — the working line the panel shows and the agent
 *   works on (`requireSelected`). Kept consistent on every change.
 * - Un-accepting never resets: accepted children become orphaned (computed).
 *
 * Older files are migrated on first read (schema 1 → 3, schema 2 → 3; backups
 * `state.v1.json` / `state.v2.json`). Schema-1 submitted reviews are copied
 * into the project input log.
 */

import fs from "node:fs";
import path from "node:path";
import { recordInput } from "./inputs.ts";
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
  isUsable,
  lineThrough,
  normalizeLine,
  orphanReason,
  orphansIfUnaccepted,
  parentOf,
  stageVersions,
  takeId,
  takeNumber,
  versionLabel,
} from "./stages.ts";
import { writeFileAtomic } from "./versioning.ts";

export const PHASES = [
  "brief",
  "discovery",
  "storyboard-review",
  "recording",
  "vo-review",
  "voice-edit",
  "done",
] as const;
export type Phase = (typeof PHASES)[number];

export type GatedArtifact = "storyboard" | "vo";

export interface HistoryEntry {
  at: string;
  event: string;
  detail?: Record<string, unknown>;
}

export type SceneReviewStatus = "approved" | "changes" | "rerun";

export interface SceneReview {
  status: SceneReviewStatus;
  note?: string;
  at: string;
}

/** Panel review of one storyboard version (D10). Drafts until submitted. */
export interface StoryboardReview {
  scenes: Record<string, SceneReview>;
  /** Free-text note for the whole storyboard (ordering, tone, …). */
  note?: string;
  submittedAt?: string;
}

export interface ProjectState {
  schema: 3;
  project: string;
  app: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  /** Accepted versions per stage with acceptance time (recording = take number). */
  accepted: Accepted;
  /** The working line (D46). */
  line: WorkingLine;
  /** Voice-over reviews keyed by version number (as string). */
  voReviews?: Record<string, StoryboardReview>;
  /** Storyboard reviews keyed by version number (as string). */
  reviews?: Record<string, StoryboardReview>;
  history: HistoryEntry[];
}

const STATE_FILE = "state.json";

export function createInitialState(project: string, app: string, now = new Date()): ProjectState {
  const at = now.toISOString();
  return {
    schema: 3,
    project,
    app,
    phase: "brief",
    createdAt: at,
    updatedAt: at,
    accepted: {},
    line: {},
    history: [{ at, event: "project-created" }],
  };
}

export function readState(projectDir: string): ProjectState | undefined {
  const file = path.join(projectDir, STATE_FILE);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: number };
  if (raw.schema === 1) return migrateV1(projectDir, raw as unknown as StateV1);
  if (raw.schema === 2) return migrateV2(projectDir, raw as unknown as StateV2);
  if (raw.schema !== 3) throw new Error(`${file}: unsupported state schema ${String(raw.schema)}`);
  return raw as ProjectState;
}

type Approvals = Partial<Record<Stage, number>>;

interface StateV1 extends Omit<ProjectState, "schema" | "accepted" | "line"> {
  schema: 1;
  approved: { storyboard?: number; vo?: number };
  acceptedTake?: string;
}

interface StateV2 extends Omit<ProjectState, "schema" | "accepted" | "line"> {
  schema: 2;
  approved: Approvals;
}

function backup(projectDir: string, name: string): void {
  const file = path.join(projectDir, name);
  if (!fs.existsSync(file)) fs.copyFileSync(path.join(projectDir, STATE_FILE), file);
}

/** Single approvals → accepted versions + a working line through them. */
function fromApprovals(
  projectDir: string,
  approved: Approvals,
  at: string,
): { accepted: Accepted; line: WorkingLine } {
  const accepted: Accepted = {};
  for (const stage of STAGES) {
    const v = approved[stage];
    if (v !== undefined) accepted[stage] = { [String(v)]: at };
  }
  const line = normalizeLine(projectDir, accepted, { ...approved });
  return { accepted, line };
}

/** Schema 1 → 3: accepted take → recording, reviews → input log. */
function migrateV1(projectDir: string, v1: StateV1, now = new Date()): ProjectState {
  backup(projectDir, "state.v1.json");
  const { acceptedTake, schema: _schema, approved: old, ...rest } = v1;
  const approved: Approvals = { ...old };
  const take = acceptedTake ? takeNumber(acceptedTake) : undefined;
  if (take !== undefined) approved.recording = take;
  const at = now.toISOString();
  const { accepted, line } = fromApprovals(projectDir, approved, at);
  const state: ProjectState = {
    ...rest,
    schema: 3,
    accepted,
    line,
    updatedAt: at,
    history: [
      ...v1.history,
      { at, event: "state-migrated", detail: { from: 1, to: 3, line: formatLine(line) } },
    ],
  };
  for (const [artifact, reviews] of [
    ["storyboard", v1.reviews],
    ["vo", v1.voReviews],
  ] as const) {
    for (const [version, review] of Object.entries(reviews ?? {})) {
      if (!review.submittedAt) continue;
      recordInput(projectDir, {
        stage: artifact,
        version: Number(version),
        source: "panel",
        kind: "review",
        text: reviewText(review),
        at: review.submittedAt,
      });
    }
  }
  writeState(projectDir, state);
  return state;
}

/** Schema 2 → 3: each approval becomes an acceptance; the working line runs through them. */
/**
 * Approvals lost to a cascade reset (schema 2, D33) are restored: under D44
 * accepting never resets, so a version the user approved stays accepted
 * (orphaned if its chain is broken). Uses the original approval time.
 */
function restoreCascadeResets(
  projectDir: string,
  history: HistoryEntry[],
  accepted: Accepted,
): string[] {
  const restored: string[] = [];
  history.forEach((h, i) => {
    if (h.event !== "approval-reset") return;
    const stage = h.detail?.stage as Stage | undefined;
    const version = h.detail?.version as number | undefined;
    if (!stage || !STAGES.includes(stage) || typeof version !== "number") return;
    if (!stageVersions(projectDir, stage).includes(version)) return;
    if (accepted[stage]?.[String(version)]) return;
    const approvedAt = history
      .slice(0, i)
      .reverse()
      .find(
        (e) =>
          e.event === "approved" && e.detail?.artifact === stage && e.detail?.version === version,
      )?.at;
    accepted[stage] = { ...(accepted[stage] ?? {}), [String(version)]: approvedAt ?? h.at };
    restored.push(versionLabel(stage, version));
  });
  return restored;
}

/** Schema 2 → 3: approvals become acceptances (cascade-reset ones restored); the working line runs through them. */
function migrateV2(projectDir: string, v2: StateV2, now = new Date()): ProjectState {
  backup(projectDir, "state.v2.json");
  const { schema: _schema, approved, ...rest } = v2;
  const at = now.toISOString();
  const { accepted } = fromApprovals(projectDir, approved, at);
  const restored = restoreCascadeResets(projectDir, v2.history, accepted);
  const line = normalizeLine(projectDir, accepted, { ...approved });
  const state: ProjectState = {
    ...rest,
    schema: 3,
    accepted,
    line,
    updatedAt: at,
    history: [
      ...v2.history,
      {
        at,
        event: "state-migrated",
        detail: {
          from: 2,
          to: 3,
          line: formatLine(line),
          ...(restored.length ? { restored } : {}),
        },
      },
    ],
  };
  writeState(projectDir, state);
  return state;
}

/** One review as text (for the input log and agent messages). */
export function reviewText(review: StoryboardReview): string {
  const lines = Object.entries(review.scenes).map(
    ([id, r]) => `${id}: ${r.status}${r.note ? ` — ${r.note}` : ""}`,
  );
  if (review.note) lines.push(`overall: ${review.note}`);
  return lines.join("\n");
}

export function writeState(projectDir: string, state: ProjectState): void {
  writeFileAtomic(path.join(projectDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Read-modify-write with a history entry. Returns the new state. */
export function updateState(
  projectDir: string,
  event: string,
  mutate: (s: ProjectState) => void = () => {},
  detail?: Record<string, unknown>,
  now = new Date(),
): ProjectState {
  const state = readState(projectDir);
  if (!state) throw new Error(`no state.json in ${projectDir}`);
  mutate(state);
  const at = now.toISOString();
  state.updatedAt = at;
  state.history.push(detail ? { at, event, detail } : { at, event });
  writeState(projectDir, state);
  return state;
}

export function setPhase(projectDir: string, phase: Phase): ProjectState {
  return updateState(
    projectDir,
    "phase-changed",
    (s) => {
      s.phase = phase;
    },
    { phase },
  );
}

/** Earliest phase the working line needs (only moves backwards). */
function phaseForLine(s: ProjectState): Phase {
  const order = PHASES.indexOf(s.phase);
  const want: Phase =
    s.line.storyboard === undefined
      ? "storyboard-review"
      : s.line.recording === undefined
        ? "recording"
        : s.line.vo === undefined
          ? "vo-review"
          : s.phase;
  return PHASES.indexOf(want) < order ? want : s.phase;
}

/**
 * Accept a version (D44): it must exist and be based on an accepted, usable
 * parent. Nothing is reset. If its parent is on the working line (or it's a
 * storyboard), it becomes the line's selection for its stage — the most
 * recent decision is the default.
 */
export function acceptStage(projectDir: string, stage: Stage, version: number): ProjectState {
  return updateState(
    projectDir,
    "accepted",
    (s) => {
      checkAcceptable(projectDir, s.accepted, stage, version);
      s.accepted[stage] = {
        ...(s.accepted[stage] ?? {}),
        [String(version)]: new Date().toISOString(),
      };
      const parent = PARENT[stage];
      const onLine =
        !parent ||
        s.line[parent] === undefined ||
        parentOf(projectDir, stage, version) === s.line[parent];
      s.line = onLine
        ? lineThrough(projectDir, s.accepted, s.line, stage, version)
        : normalizeLine(projectDir, s.accepted, s.line);
      s.phase = phaseForLine(s);
    },
    { artifact: stage, version },
  );
}

/**
 * Un-accept a version (D45). Never resets: accepted versions built on it stay
 * accepted but become orphaned (returned). The working line re-picks.
 */
export function unacceptStage(
  projectDir: string,
  stage: Stage,
  version: number,
): { state: ProjectState; orphaned: VersionRef[] } {
  let orphaned: VersionRef[] = [];
  const state = updateState(
    projectDir,
    "unaccepted",
    (s) => {
      if (!s.accepted[stage]?.[String(version)])
        throw new Error(`${versionLabel(stage, version)} is not accepted`);
      orphaned = orphansIfUnaccepted(projectDir, s.accepted, stage, version);
      const rest = { ...(s.accepted[stage] ?? {}) };
      delete rest[String(version)];
      s.accepted[stage] = rest;
      s.line = normalizeLine(projectDir, s.accepted, s.line);
      s.phase = phaseForLine(s);
    },
    { artifact: stage, version },
  );
  return { state, orphaned };
}

/** Put a usable version on the working line: its ancestors follow, descendants re-pick (D46). */
export function selectStage(projectDir: string, stage: Stage, version: number): ProjectState {
  return updateState(
    projectDir,
    "line-changed",
    (s) => {
      s.line = lineThrough(projectDir, s.accepted, s.line, stage, version);
      s.phase = phaseForLine(s);
    },
    { artifact: stage, version },
  );
}

/** Kept for callers of the S2–S4 API: accepting = approving. */
export function approve(projectDir: string, stage: Stage, version: number): ProjectState {
  return acceptStage(projectDir, stage, version);
}

/**
 * Hard gate: the working line's version of `stage` (or an explicit one),
 * which must be accepted and usable. Returns it.
 */
export function requireSelected(
  projectDir: string,
  state: ProjectState,
  stage: Stage,
  explicit?: number,
): number {
  const v = explicit ?? state.line[stage];
  if (v === undefined)
    throw new Error(
      `no accepted ${STAGE_LABEL[stage]} on the working line of "${state.project}" — accept one in the demo panel first`,
    );
  if (!state.accepted[stage]?.[String(v)])
    throw new Error(
      `${versionLabel(stage, v)} is not accepted — accept it in the demo panel first`,
    );
  const why = orphanReason(projectDir, state.accepted, stage, v);
  if (why) throw new Error(`${versionLabel(stage, v)} can't be used: ${why}`);
  return v;
}

/** S2–S4 gate (no orphan check): the working line has an accepted version of `stage`. */
export function requireApproved(state: ProjectState, stage: Stage): number {
  const v = state.line[stage];
  if (v === undefined || !state.accepted[stage]?.[String(v)])
    throw new Error(
      `${STAGE_LABEL[stage]} is not accepted yet for project "${state.project}" — accept it in the demo panel first`,
    );
  return v;
}

/** Same check without throwing. */
export const selectedUsable = (projectDir: string, state: ProjectState, stage: Stage) =>
  state.line[stage] !== undefined &&
  isUsable(projectDir, state.accepted, stage, state.line[stage] as number);

/** The working line's take id (`take-NNN`). */
export function acceptedTakeId(state: ProjectState): string | undefined {
  return state.line.recording !== undefined ? takeId(state.line.recording) : undefined;
}

function reviewsOf(s: ProjectState, artifact: GatedArtifact): Record<string, StoryboardReview> {
  if (artifact === "vo") {
    s.voReviews ??= {};
    return s.voReviews;
  }
  s.reviews ??= {};
  return s.reviews;
}

function ensureReview(s: ProjectState, version: number, artifact: GatedArtifact): StoryboardReview {
  const all = reviewsOf(s, artifact);
  const key = String(version);
  const existing = all[key];
  if (existing) return existing;
  const created: StoryboardReview = { scenes: {} };
  all[key] = created;
  return created;
}

export function getReview(
  state: ProjectState,
  version: number,
  artifact: GatedArtifact = "storyboard",
): StoryboardReview {
  const all = artifact === "vo" ? state.voReviews : state.reviews;
  return all?.[String(version)] ?? { scenes: {} };
}

/** Record (or clear, with status null) a draft review for one scene/section. */
export function setSceneReview(
  projectDir: string,
  version: number,
  scene: string,
  status: SceneReviewStatus | null,
  note?: string,
  artifact: GatedArtifact = "storyboard",
): ProjectState {
  return updateState(
    projectDir,
    "scene-reviewed",
    (s) => {
      const review = ensureReview(s, version, artifact);
      if (status === null) delete review.scenes[scene];
      else
        review.scenes[scene] = {
          status,
          ...(note?.trim() ? { note: note.trim() } : {}),
          at: new Date().toISOString(),
        };
    },
    { artifact, version, scene, status },
  );
}

export function setReviewNote(
  projectDir: string,
  version: number,
  note: string,
  artifact: GatedArtifact = "storyboard",
): ProjectState {
  return updateState(
    projectDir,
    "review-noted",
    (s) => {
      const review = ensureReview(s, version, artifact);
      if (note.trim()) review.note = note.trim();
      else review.note = undefined;
    },
    { artifact, version },
  );
}

export function submitReview(
  projectDir: string,
  version: number,
  artifact: GatedArtifact = "storyboard",
): { state: ProjectState; review: StoryboardReview } {
  let submitted: StoryboardReview = { scenes: {} };
  const state = updateState(
    projectDir,
    "review-submitted",
    (s) => {
      const review = ensureReview(s, version, artifact);
      if (!Object.keys(review.scenes).length && !review.note)
        throw new Error("nothing to submit — mark at least one scene or add a note");
      review.submittedAt = new Date().toISOString();
      submitted = review;
    },
    { artifact, version },
  );
  return { state, review: submitted };
}

/** Accept a take (recording version); chain-checked; it joins the working line when its storyboard is on it. */
export function acceptTake(projectDir: string, take: string): ProjectState {
  const n = takeNumber(take);
  if (n === undefined) throw new Error(`invalid take id "${take}"`);
  acceptStage(projectDir, "recording", n);
  return updateState(
    projectDir,
    "take-accepted",
    (s) => {
      if (s.phase === "recording" && s.line.recording !== undefined) s.phase = "vo-review";
    },
    { take },
  );
}
