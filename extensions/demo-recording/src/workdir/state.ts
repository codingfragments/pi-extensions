/**
 * Project state (`state.json`) — phase, approved versions, history.
 *
 * Human gates (IMPLEMENTATION_PLAN §1 principle 1) are enforced here, not in
 * prompts: `requireApproved` throws unless the named stage has an approved
 * version, and `approve` only accepts versions that chain up to the approved
 * parent (stages.ts). Approving resets downstream approvals that no longer
 * chain up (cascade reset, D33).
 *
 * Schema 2 (S5 part 3): `approved` covers all five stages; the accepted take
 * is `approved.recording` (its take number). Schema-1 files are migrated on
 * first read (backup kept as `state.v1.json`), and their submitted reviews are
 * copied into the project input log.
 */

import fs from "node:fs";
import path from "node:path";
import { recordInput } from "./inputs.ts";
import {
  type ApprovalReset,
  type Approvals,
  STAGE_LABEL,
  type Stage,
  cascade,
  checkApprovable,
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
  schema: 2;
  project: string;
  app: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  /** Approved version per stage (recording = take number). */
  approved: Approvals;
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
    schema: 2,
    project,
    app,
    phase: "brief",
    createdAt: at,
    updatedAt: at,
    approved: {},
    history: [{ at, event: "project-created" }],
  };
}

export function readState(projectDir: string): ProjectState | undefined {
  const file = path.join(projectDir, STATE_FILE);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: number };
  if (raw.schema === 1) return migrateV1(projectDir, raw as unknown as StateV1);
  if (raw.schema !== 2) throw new Error(`${file}: unsupported state schema ${String(raw.schema)}`);
  return raw as ProjectState;
}

interface StateV1 extends Omit<ProjectState, "schema" | "approved"> {
  schema: 1;
  approved: { storyboard?: number; vo?: number };
  acceptedTake?: string;
}

/** One review as text (for the input log and agent messages). */
export function reviewText(review: StoryboardReview): string {
  const lines = Object.entries(review.scenes).map(
    ([id, r]) => `${id}: ${r.status}${r.note ? ` — ${r.note}` : ""}`,
  );
  if (review.note) lines.push(`overall: ${review.note}`);
  return lines.join("\n");
}

/** Schema 1 → 2: accepted take → approved.recording, inconsistent approvals dropped, reviews → input log. */
function migrateV1(projectDir: string, v1: StateV1, now = new Date()): ProjectState {
  const backup = path.join(projectDir, "state.v1.json");
  if (!fs.existsSync(backup)) fs.copyFileSync(path.join(projectDir, STATE_FILE), backup);
  const { acceptedTake, schema: _schema, ...rest } = v1;
  const approved: Approvals = { ...v1.approved };
  const take = acceptedTake ? takeNumber(acceptedTake) : undefined;
  if (take !== undefined) approved.recording = take;
  const resets = cascade(projectDir, approved);
  const at = now.toISOString();
  const state: ProjectState = {
    ...rest,
    schema: 2,
    approved,
    updatedAt: at,
    history: [
      ...v1.history,
      {
        at,
        event: "state-migrated",
        detail: { from: 1, to: 2, ...(resets.length ? { resets } : {}) },
      },
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

/** Earliest phase that needs work after approvals were reset (only moves backwards). */
function phaseAfterReset(s: ProjectState): Phase {
  const order = PHASES.indexOf(s.phase);
  const want: Phase = !s.approved.storyboard
    ? "storyboard-review"
    : !s.approved.recording
      ? "recording"
      : !s.approved.vo
        ? "vo-review"
        : s.phase;
  return PHASES.indexOf(want) < order ? want : s.phase;
}

/**
 * Approve a version of a stage. It must exist and be based on the approved
 * parent version (stages.ts). Downstream approvals that no longer chain up
 * are reset (D33), each recorded in history.
 */
export function approveStage(
  projectDir: string,
  stage: Stage,
  version: number,
): { state: ProjectState; resets: ApprovalReset[] } {
  let resets: ApprovalReset[] = [];
  const state = updateState(
    projectDir,
    "approved",
    (s) => {
      checkApprovable(projectDir, s.approved, stage, version);
      s.approved[stage] = version;
      resets = cascade(projectDir, s.approved);
      if (resets.length) {
        const at = new Date().toISOString();
        for (const r of resets)
          s.history.push({
            at,
            event: "approval-reset",
            detail: { ...r, because: versionLabel(stage, version) },
          });
        s.phase = phaseAfterReset(s);
      }
    },
    { artifact: stage, version },
  );
  return { state, resets };
}

export function approve(projectDir: string, stage: Stage, version: number): ProjectState {
  return approveStage(projectDir, stage, version).state;
}

/** Hard gate: throws unless `stage` has an approved version. Returns that version. */
export function requireApproved(state: ProjectState, stage: Stage): number {
  const version = state.approved[stage];
  if (version === undefined) {
    throw new Error(
      `${STAGE_LABEL[stage]} is not approved yet for project "${state.project}" — approve it in the demo panel first`,
    );
  }
  return version;
}

/** The accepted take id (`take-NNN`), i.e. the approved recording. */
export function acceptedTakeId(state: ProjectState): string | undefined {
  return state.approved.recording !== undefined ? takeId(state.approved.recording) : undefined;
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

/** Accept a take = approve that recording version (chain-checked, cascades). */
export function acceptTake(projectDir: string, take: string): ProjectState {
  const n = takeNumber(take);
  if (n === undefined) throw new Error(`invalid take id "${take}"`);
  approveStage(projectDir, "recording", n);
  return updateState(
    projectDir,
    "take-accepted",
    (s) => {
      if (s.phase === "recording") s.phase = "vo-review";
    },
    { take },
  );
}
