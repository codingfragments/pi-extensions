/**
 * The recording review's data (item 7, R0): per scene of a take, its frames as chapter navigation (the start, each
 * mark, anything notable such as a toast, the end), what the storyboard meant the scene to show (its goal and the
 * findings it covers) and what the take itself found there (engine findings: toasts, dead time, improvised inputs,
 * resumes). Pure: the route supplies the analysis, the storyboard and the findings.
 */

import type { Scene } from "../storyboard/types.ts";
import type { Finding } from "../workdir/findings.ts";
import type { SceneAnalysis, TakeAnalysis } from "./take.ts";

export type FrameKind = "start" | "mark" | "event" | "end";

export interface ReviewFrame {
  label: string;
  kind: FrameKind;
  /** Take clock, ms: seek the raw video to t / 1000. */
  t: number;
  /** Project-relative path of the still, absent when the file is missing. */
  file?: string;
}

export interface ReviewFinding {
  id: string;
  kind: string;
  text: string;
  state: string;
  /** Where in the take (ms), when known. */
  t?: number;
}

export interface ReviewScene {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  /** The scene's intent in the storyboard: what it should show. */
  goal?: string;
  emphasis?: string;
  /** The storyboard scene's own plan for the narration, as outline lines. */
  outline: string[];
  /** Findings the storyboard scene is meant to cover (the ones it names). */
  planned: ReviewFinding[];
  /** What this take found in the scene. */
  found: ReviewFinding[];
  frames: ReviewFrame[];
}

const inScene = (t: number, s: SceneAnalysis) => t >= s.start && t < s.end;

/**
 * `localize` turns an analysis file path into a project-relative one (or undefined when the file is gone).
 * `findings` are all of the project's findings (agent and engine).
 */
export function reviewScenes(opts: {
  analysis: TakeAnalysis;
  storyboardScenes?: Scene[];
  findings: (Omit<Finding, "state"> & { state?: string })[];
  localize: (file: string) => string | undefined;
}): ReviewScene[] {
  const { analysis, localize } = opts;
  const all = opts.findings;
  const bySb = new Map((opts.storyboardScenes ?? []).map((s) => [s.id, s]));
  const take = analysis.take;
  return analysis.scenes.map((s) => {
    const sb = bySb.get(s.id);
    const markNames = new Set((s.marks ?? []).map((m) => m.mark));
    const frames: ReviewFrame[] = s.keyframes
      .map((k) => {
        const file = localize(k.file);
        const kind: FrameKind =
          k.label === "start"
            ? "start"
            : k.label === "end"
              ? "end"
              : markNames.has(k.label)
                ? "mark"
                : "event";
        return { label: k.label, kind, t: k.t, ...(file ? { file } : {}) };
      })
      .sort((a, b) => a.t - b.t);
    const planned = (sb?.findings ?? []).flatMap((id) => {
      const f = all.find((x) => x.id === id);
      return f ? [{ id: f.id, kind: f.kind, text: f.text, state: f.state ?? "auto" }] : [];
    });
    const found: ReviewFinding[] = [];
    for (const f of all) {
      if (f.source !== "engine" || f.stage !== "recording") continue;
      // an engine finding belongs to this scene when its evidence in THIS take names it, or falls inside its span
      const ev = f.evidence.find(
        (e) =>
          e.type === "take" &&
          e.take === take &&
          (e.scene === s.id || (e.scene === undefined && inScene(e.t, s))),
      );
      if (ev && ev.type === "take")
        found.push({ id: f.id, kind: f.kind, text: f.text, state: f.state ?? "auto", t: ev.t });
    }
    found.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    return {
      id: s.id,
      title: s.title,
      startMs: s.start,
      endMs: s.end,
      ...(sb?.takeaway ? { goal: sb.takeaway } : {}),
      ...(sb?.emphasis ? { emphasis: sb.emphasis } : {}),
      outline: sb?.narration_outline ?? [],
      planned,
      found,
      frames,
    };
  });
}

/** The chapter the playhead is in (the last scene that has started), by take time in ms; -1 before the first. */
export function chapterAt(scenes: { startMs: number }[], ms: number): number {
  let at = -1;
  for (let i = 0; i < scenes.length; i++)
    if ((scenes[i] as { startMs: number }).startMs <= ms) at = i;
  return at;
}
