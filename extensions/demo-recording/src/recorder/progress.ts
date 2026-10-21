/**
 * Recording progress (S3, user request): expected duration per step, a
 * tracker that turns step completions into overall/per-scene fractions, and
 * an ETA that self-calibrates against how fast the take actually runs.
 *
 * Waits are open-ended: they count with a nominal estimate, and the fraction
 * never jumps past a wait until it is satisfied.
 */

import { moveDuration } from "../browser/cursor/motion.ts";
import { expectedTypingMs } from "../browser/cursor/typing.ts";
import type { Step, Storyboard } from "../storyboard/types.ts";

/** The take lingers on the first frame and on the last one (the runner sleeps this long before and after the scenes). */
export const LEAD_IN_MS = 700;
export const TAIL_MS = 900;

export const DEFAULT_DWELL: Record<Step["do"], number> = {
  goto: 500,
  move: 150,
  hover: 900,
  click: 350,
  type: 400,
  press: 250,
  wait: 600,
  pause: 0,
  scroll: 400,
  improvise: 400,
};

const NOMINAL_MOVE = moveDuration(450, 60);
const NOMINAL_WAIT = 1500;

/** Expected wall time (ms) of one step, including its dwell. */
export function estimateStepMs(step: Step): number {
  const dwell = step.dwell ?? DEFAULT_DWELL[step.do];
  switch (step.do) {
    case "goto":
      return 1200 + dwell;
    case "move":
    case "hover":
      return NOMINAL_MOVE + dwell;
    case "click":
      return NOMINAL_MOVE + 120 + dwell;
    case "type":
      return (step.target ? NOMINAL_MOVE + 400 : 0) + expectedTypingMs(step.text) + dwell;
    case "press":
      return 100 + dwell;
    case "wait":
      return ("ms" in step.for ? step.for.ms : NOMINAL_WAIT) + dwell;
    case "pause":
      return step.ms;
    case "scroll":
      return 300 + Math.abs(step.dy ?? 500) * 0.6 + dwell;
    case "improvise":
      return (
        NOMINAL_MOVE +
        400 +
        expectedTypingMs("x".repeat(Math.round(step.max_chars * 0.6))) +
        (step.submit ? 100 : 0) +
        dwell
      );
  }
}

export interface ProgressSnapshot {
  scene: { index: number; total: number; id: string; title: string };
  step: { index: number; total: number; label: string };
  /** 0..1 over the whole storyboard. */
  fraction: number;
  /** Per-scene completion 0..1 (for the segmented bar). */
  scenes: { id: string; title: string; weight: number; done: number; attempt: number }[];
  elapsedMs: number;
  etaMs: number;
  attempt: number;
  phase: "setup" | "recording" | "recovering" | "encoding" | "done" | "failed";
  /** The running step has taken much longer than it should (set only then): a step that may be stuck. */
  slow?: { runMs: number; expectedMs: number };
}

export function stepLabel(step: Step): string {
  switch (step.do) {
    case "type":
      return `typing "${step.text.length > 40 ? `${step.text.slice(0, 37)}…` : step.text}"`;
    case "improvise":
      return "improvising input";
    case "wait":
      return "waiting for the app";
    case "goto":
      return `opening ${step.url}`;
    case "press":
      return `pressing ${step.key}`;
    case "pause":
      return "pausing";
    case "scroll":
      return "scrolling";
    default:
      return `${step.do}`;
  }
}

export class ProgressTracker {
  private readonly weights: number[][];
  private readonly total: number;
  private readonly sb: Storyboard;
  private readonly started: number;
  private readonly now: () => number;
  private doneMs = 0;
  private sceneIdx = 0;
  private stepIdx = 0;
  private stepStarted = 0;
  private sceneDone: number[];
  private attempts: number[];
  phase: ProgressSnapshot["phase"] = "setup";

  constructor(sb: Storyboard, now: () => number = Date.now) {
    this.sb = sb;
    this.now = now;
    this.weights = sb.scenes.map((s) => s.steps.map(estimateStepMs));
    this.total = this.weights.flat().reduce((a, b) => a + b, 0) || 1;
    this.sceneDone = sb.scenes.map(() => 0);
    this.attempts = sb.scenes.map(() => 1);
    this.started = now();
  }

  private sceneWeight(i: number): number {
    return (this.weights[i] ?? []).reduce((a, b) => a + b, 0) || 1;
  }

  startStep(scene: number, step: number): void {
    this.phase = "recording";
    this.sceneIdx = scene;
    this.stepIdx = step;
    this.stepStarted = this.now();
  }

  finishStep(scene: number, step: number): void {
    const w = this.weights[scene]?.[step] ?? 0;
    this.doneMs += w;
    this.sceneDone[scene] = (this.sceneDone[scene] ?? 0) + w;
  }

  /** A scene is re-shot: its progress restarts (shown as a restarted segment). */
  restartScene(scene: number): void {
    this.doneMs -= this.sceneDone[scene] ?? 0;
    this.sceneDone[scene] = 0;
    this.attempts[scene] = (this.attempts[scene] ?? 1) + 1;
    this.phase = "recovering";
  }

  snapshot(): ProgressSnapshot {
    const elapsed = this.now() - this.started;
    const sceneW = this.weights[this.sceneIdx] ?? [];
    const current = sceneW[this.stepIdx] ?? 0;
    const step = this.sb.scenes[this.sceneIdx]?.steps[this.stepIdx];
    // Credit the running step up to 90 % of its estimate — never past an open wait.
    const inStep =
      this.phase === "recording" ? Math.min(current * 0.9, this.now() - this.stepStarted) : 0;
    const fraction =
      this.phase === "done" ? 1 : Math.min(0.999, (this.doneMs + inStep) / this.total);
    // Calibrate: how fast are we vs. estimates so far (bounded to avoid wild swings).
    const rate = this.doneMs > 2000 ? Math.min(1.8, Math.max(0.6, elapsed / this.doneMs)) : 1;
    const eta =
      this.phase === "done"
        ? 0
        : Math.max(0, Math.round((this.total - this.doneMs - inStep) * rate));
    const scene = this.sb.scenes[this.sceneIdx];
    const runMs = this.phase === "recording" ? this.now() - this.stepStarted : 0;
    const slow = runMs > Math.max(15_000, current * 2) ? { runMs, expectedMs: current } : undefined;
    return {
      ...(slow ? { slow } : {}),
      scene: {
        index: this.sceneIdx + 1,
        total: this.sb.scenes.length,
        id: scene?.id ?? "",
        title: scene?.title ?? "",
      },
      step: { index: this.stepIdx + 1, total: sceneW.length, label: step ? stepLabel(step) : "" },
      fraction: +fraction.toFixed(4),
      scenes: this.sb.scenes.map((s, i) => ({
        id: s.id,
        title: s.title,
        weight: +(this.sceneWeight(i) / this.total).toFixed(4),
        done: +Math.min(
          1,
          ((this.sceneDone[i] ?? 0) + (i === this.sceneIdx ? inStep : 0)) / this.sceneWeight(i),
        ).toFixed(4),
        attempt: this.attempts[i] ?? 1,
      })),
      elapsedMs: elapsed,
      etaMs: eta,
      attempt: this.attempts[this.sceneIdx] ?? 1,
      phase: this.phase,
    };
  }
}

export function formatProgress(p: ProgressSnapshot): string {
  const pct = Math.round(p.fraction * 100);
  const mmss = (ms: number) =>
    `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  if (p.phase === "encoding") return `🎬 encoding take · ${mmss(p.elapsedMs)}`;
  if (p.phase === "done") return `🎬 take recorded · ${mmss(p.elapsedMs)}`;
  if (p.slow)
    return `🎬 ${pct}% · scene ${p.scene.index}/${p.scene.total} · step ${p.step.index}/${p.step.total} · ${p.step.label} · ⚠ this step has run ${Math.round(p.slow.runMs / 1000)} s (expected ${Math.max(1, Math.round(p.slow.expectedMs / 1000))} s): the browser may be stuck · ${mmss(p.elapsedMs)} elapsed`;
  return (
    `🎬 ${pct}% · scene ${p.scene.index}/${p.scene.total} · step ${p.step.index}/${p.step.total} · ${p.step.label}` +
    `${p.attempt > 1 ? ` · retry ${p.attempt - 1}` : ""} · ${mmss(p.elapsedMs)} elapsed · ~${mmss(p.etaMs)} left`
  );
}
