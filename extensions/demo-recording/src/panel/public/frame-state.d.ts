export interface Step {
  tab: string;
  stage: string;
  label: string;
}
export const STEPS: Step[];
export const JOB_STAGE: Record<string, string>;
export const JOB_TITLE: Record<string, string>;
export function jobTitle(j: { label?: string | null; kind?: string } | null | undefined): string;
export interface StageView {
  stage: string;
  selected?: number;
  accepted?: { version: number; orphaned?: string }[];
  onInput?: number[];
}
export interface StagesData {
  project: string | null;
  stages?: StageView[];
  next?: { who: "user" | "agent" | null; stage: string | null; text: string };
}
export interface JobData {
  id: string;
  kind: string;
  status: "running" | "done" | "failed" | "cancelled";
  error?: string | null;
}
export interface Row {
  key: string;
  state: string;
  fraction?: number | null;
  title?: string;
}
export interface StepState {
  state: "complete" | "needs" | "running" | "blocked" | "upcoming";
  why: string;
  pending: number;
  /** The graph node of a version that is blocked by dependency. */
  node?: string;
  /** The render whose QA fixes the newest draft was written from. */
  fixesFrom?: number;
}
export interface Band {
  tone: "needs" | "blocked" | "idle" | "done" | "working";
  /** For the working band: how the "N items … you" link reads ("wait for you"). */
  moreWord?: string;
  label: string;
  text: string;
  title?: string;
  action: { label: string; tab: string } | null;
  /** Graph node to show in the map (a blocked step). */
  map?: string;
  more: { tab: string; text: string }[];
  /** A question the Director asked you (D140): the band has no page to go to. */
  question?: boolean;
}
/** What the Director is doing now (src/director/state.ts). */
export interface DirectorView {
  working: boolean;
  task?: string;
  by?: "you" | "panel" | "report";
  since?: number;
  step?: { tool: string; label: string; stage?: string };
  lastAt?: number;
  last?: { task: string; aborted: boolean; ms: number; at: number };
}
export interface Strip {
  tone: "idle" | "running" | "err" | "warn";
  text: string;
  progress: number | null;
  running: JobData[];
  failure: JobData | null;
}
export const vLabel: (stage: string, n: number) => string;
export const stepOfStage: (stage: string) => Step | undefined;
export function pendingDrafts(s: StageView | undefined): number[];
export function failedJobs(jobs: JobData[] | undefined): JobData[];
export function runningJobs(jobs: JobData[] | undefined): JobData[];
export function stepStates(o: {
  stages: StagesData | null | undefined;
  jobs: JobData[] | undefined;
  discovery?: boolean;
  director?: DirectorView;
}): Record<string, StepState>;
export function nextBand(o: {
  stages: StagesData | null | undefined;
  states: Record<string, StepState>;
  jobs: JobData[] | undefined;
  director?: DirectorView;
  now?: number;
  /** The questions the Director asked you and waits for. */
  questions?: { id: string; role: string; what: string }[];
}): Band | null;
export function stripState(o: {
  jobs: JobData[] | undefined;
  rows: Row[] | undefined;
  status?: string;
  dismissed?: Set<string>;
  director?: DirectorView;
}): Strip;
export function directorNow(
  state: { director?: DirectorView; busSeq?: number } | null | undefined,
  events?: { seq: number; type: string; at: string; data: Record<string, unknown> }[],
): DirectorView;
export function newsTab(e: { type: string; data?: { by?: string } }): string | null;
export interface SuggestionItem {
  tab: string;
  text: string;
  first?: boolean;
  blocked?: boolean;
  here: boolean;
}
export function bandHiddenAt(
  band: { tone: string; action?: { tab: string } | null } | null | undefined,
  tab: string,
): boolean;
export function suggestions(band: unknown, tab: string): SuggestionItem[];
