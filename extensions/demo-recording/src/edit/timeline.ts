/**
 * Edit timeline (IMPLEMENTATION_PLAN §3.5): take analysis + voice manifest →
 * per-scene edits (sync solver) + the full-video sequence (intro, bridges,
 * scenes, outro). Pure apart from reading inputs; written as
 * `edit/timeline.vN.json`.
 */

import type { TakeAnalysis } from "../analysis/take.ts";
import type { VoiceManifest } from "../tts/synthesize.ts";
import { LIMITS, type SceneEdit, solveScene } from "./sync.ts";

export interface CardClip {
  kind: "intro" | "bridge" | "outro";
  /** Take time of the frame to hold under the narration. */
  holdAt: number;
  durationMs: number;
  audio: { file: string; src: [number, number] } | null;
}

export interface SceneTimeline extends SceneEdit {
  title: string;
  /** Section audio file (relative to the project), if narrated. */
  audioFile: string | null;
}

export type FullItem = { type: "scene"; id: string } | ({ type: "card" } & CardClip);

export interface Timeline {
  schema: 1;
  take: string;
  voVersion: number;
  voice: { engine: string; name: string };
  fps: number;
  size: { width: number; height: number };
  scenes: SceneTimeline[];
  full: FullItem[];
  totals: {
    fullMs: number;
    cutMs: number;
    frozenMs: number;
    silenceMs: number;
    worstDriftMs: number;
  };
}

const CARD_PAD_MS = 500;

export function buildTimeline(
  analysis: TakeAnalysis,
  voice: VoiceManifest,
  out: { fps: number; size: { width: number; height: number } },
): Timeline {
  const scenes: SceneTimeline[] = analysis.scenes.map((sc) => {
    const audio = voice.sections[sc.id];
    const usable = sc.end - sc.start - sc.idle.reduce((n, r) => n + (r.end - r.start), 0);
    const anchorsMs = Object.fromEntries(
      Object.entries(audio?.alignment.anchors ?? {}).map(([k, v]) => [k, Math.round(v * 1000)]),
    );
    const edit = solveScene({
      id: sc.id,
      start: sc.start,
      end: sc.end,
      protected: sc.protected,
      dead: sc.idle,
      stream: sc.streaming,
      motion: sc.motion,
      events: Object.fromEntries(sc.marks.map((m) => [m.mark, m.t])),
      // A silent scene keeps its footage (dead time still cut).
      audioMs: audio
        ? Math.round(audio.durationSec * 1000)
        : Math.max(1000, usable - LIMITS.tailMs),
      anchors: anchorsMs,
    });
    if (!audio) edit.audio = [];
    return { ...edit, title: sc.title, audioFile: audio?.file ?? null };
  });

  const card = (kind: CardClip["kind"], key: string, holdAt: number): FullItem | undefined => {
    const a = voice.sections[key];
    if (!a) return undefined;
    const ms = Math.round(a.durationSec * 1000);
    return {
      type: "card",
      kind,
      holdAt,
      durationMs: ms + CARD_PAD_MS * 2,
      audio: { file: a.file, src: [0, ms] },
    };
  };
  const full: FullItem[] = [];
  const first = analysis.scenes[0];
  const last = analysis.scenes.at(-1);
  if (first) {
    const intro = card("intro", "_intro", first.start);
    if (intro) full.push(intro);
  }
  analysis.scenes.forEach((sc, i) => {
    if (i > 0) {
      const bridge = card("bridge", `_bridge:${sc.id}`, sc.start);
      if (bridge) full.push(bridge);
    }
    full.push({ type: "scene", id: sc.id });
  });
  if (last) {
    const outro = card("outro", "_outro", Math.max(last.start, last.end - 34));
    if (outro) full.push(outro);
  }

  const sceneMs = new Map(scenes.map((s) => [s.id, s.durationMs]));
  const fullMs = full.reduce(
    (n, it) => n + (it.type === "scene" ? (sceneMs.get(it.id) ?? 0) : it.durationMs),
    0,
  );
  return {
    schema: 1,
    take: analysis.take,
    voVersion: voice.voVersion,
    voice: { engine: voice.engine, name: voice.voice.name },
    fps: out.fps,
    size: out.size,
    scenes,
    full,
    totals: {
      fullMs,
      cutMs: Math.round(scenes.reduce((n, s) => n + s.stats.cutMs, 0)),
      frozenMs: Math.round(scenes.reduce((n, s) => n + s.stats.frozenMs, 0)),
      silenceMs: Math.round(scenes.reduce((n, s) => n + s.stats.silenceMs, 0)),
      worstDriftMs: Math.max(0, ...scenes.flatMap((s) => s.anchors.map((a) => Math.abs(a.drift)))),
    },
  };
}
