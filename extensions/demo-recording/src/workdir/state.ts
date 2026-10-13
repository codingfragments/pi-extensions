/**
 * Project state (`state.json`) — phase, approved versions, history.
 *
 * Human gates (IMPLEMENTATION_PLAN §1 principle 1) are enforced here, not in
 * prompts: `requireApproved` throws unless the named artifact has an approved
 * version. Later slices call it from `demo_rec_record` / `demo_rec_tts`.
 */

import fs from "node:fs";
import path from "node:path";
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
  schema: 1;
  project: string;
  app: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  /** Latest approved version per gated artifact. */
  approved: Partial<Record<GatedArtifact, number>>;
  /** The take the voice-over is written for (S4). */
  acceptedTake?: string;
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
    schema: 1,
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
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectState;
  if (state.schema !== 1)
    throw new Error(`${file}: unsupported state schema ${String(state.schema)}`);
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

export function approve(
  projectDir: string,
  artifact: GatedArtifact,
  version: number,
): ProjectState {
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`invalid ${artifact} version ${version}`);
  return updateState(
    projectDir,
    "approved",
    (s) => {
      s.approved[artifact] = version;
    },
    { artifact, version },
  );
}

/** Hard gate: throws unless `artifact` has an approved version. Returns that version. */
export function requireApproved(state: ProjectState, artifact: GatedArtifact): number {
  const version = state.approved[artifact];
  if (version === undefined) {
    throw new Error(
      `${artifact} is not approved yet for project "${state.project}" — approve it in the demo panel first`,
    );
  }
  return version;
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

export function acceptTake(projectDir: string, take: string): ProjectState {
  if (!/^take-\d{3,}$/.test(take)) throw new Error(`invalid take id "${take}"`);
  return updateState(
    projectDir,
    "take-accepted",
    (s) => {
      s.acceptedTake = take;
      if (s.phase === "recording") s.phase = "vo-review";
    },
    { take },
  );
}
