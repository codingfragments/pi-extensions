export interface Step {
  tab: string;
  stage: string;
  label: string;
}
export const STEPS: Step[];
export const JOB_STAGE: Record<string, string>;
export const JOB_TITLE: Record<string, string>;
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
}
export interface Band {
  tone: "needs" | "blocked" | "idle" | "done";
  label: string;
  text: string;
  title?: string;
  action: { label: string; tab: string } | null;
  /** Graph node to show in the map (a blocked step). */
  map?: string;
  more: { tab: string; text: string }[];
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
}): Record<string, StepState>;
export function nextBand(o: {
  stages: StagesData | null | undefined;
  states: Record<string, StepState>;
  jobs: JobData[] | undefined;
}): Band | null;
export function stripState(o: {
  jobs: JobData[] | undefined;
  rows: Row[] | undefined;
  status?: string;
  dismissed?: Set<string>;
}): Strip;
export function newsTab(e: { type: string; data?: { by?: string } }): string | null;
