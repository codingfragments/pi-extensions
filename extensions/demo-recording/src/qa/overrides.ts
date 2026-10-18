/**
 * Render overrides (S5 part 10, D74): mechanical fixes applied to a COPY of
 * the edit's timeline for one render — the approved script, audio and
 * annotations stay untouched. Today one kind: shift a narration segment
 * (its audio piece) by Δ ms so it lands on its moment; later segments are
 * pushed when they would overlap, and the scene gets a held end frame when
 * the narration would run past it.
 */

import type { Timeline } from "../edit/timeline.ts";
import { readManifest } from "../tts/synthesize.ts";
import type { QaFix } from "./types.ts";

export interface RenderOverrides {
  fromRender: number;
  shifts: QaFix[];
}

/** Index of a segment's audio piece: the piece that starts where the segment starts in the section audio. */
export function pieceOfSegment(
  projectDir: string,
  timeline: Timeline,
  scene: string,
  anchor: string,
): number {
  const sc = timeline.scenes.find((s) => s.id === scene);
  if (!sc) return -1;
  if (!anchor) return sc.audio.findIndex((p) => p.src[0] <= 1);
  const sec = readManifest(projectDir, timeline.voVersion)?.sections[scene];
  const startSec = sec?.alignment.anchors[anchor];
  if (startSec === undefined) return -1;
  return sc.audio.findIndex((p) => Math.abs(p.src[0] - startSec * 1000) < 40);
}

export function applyShifts(
  projectDir: string,
  timeline: Timeline,
  shifts: QaFix[],
): { timeline: Timeline; applied: QaFix[]; skipped: { fix: QaFix; why: string }[] } {
  const t = structuredClone(timeline) as Timeline;
  const applied: QaFix[] = [];
  const skipped: { fix: QaFix; why: string }[] = [];
  for (const f of shifts) {
    const sc = t.scenes.find((s) => s.id === f.scene);
    const k = pieceOfSegment(projectDir, t, f.scene, f.anchor);
    if (!sc || k < 0) {
      skipped.push({
        fix: f,
        why: `no narration segment ${f.anchor ? `@${f.anchor}` : "at the start"} in ${f.scene}`,
      });
      continue;
    }
    const p = sc.audio[k] as (typeof sc.audio)[number];
    const prevEnd =
      k > 0
        ? (sc.audio[k - 1] as (typeof sc.audio)[number]).at +
          ((sc.audio[k - 1] as (typeof sc.audio)[number]).src[1] -
            (sc.audio[k - 1] as (typeof sc.audio)[number]).src[0])
        : 0;
    const before = p.at;
    p.at = Math.max(prevEnd, Math.max(0, p.at + f.deltaMs));
    const moved = p.at - before;
    // Push later segments that would overlap.
    for (let i = k + 1; i < sc.audio.length; i++) {
      const a = sc.audio[i - 1] as (typeof sc.audio)[number];
      const b = sc.audio[i] as (typeof sc.audio)[number];
      const end = a.at + (a.src[1] - a.src[0]);
      if (b.at < end) b.at = end;
    }
    // Anchors follow their audio.
    const sec = readManifest(projectDir, t.voVersion)?.sections[f.scene];
    for (const an of sc.anchors) {
      const startMs = (sec?.alignment.anchors[an.mark] ?? -1) * 1000;
      const pc = sc.audio.find((x) => Math.abs(x.src[0] - startMs) < 40);
      if (pc) {
        an.audioAt = pc.at;
        an.drift = an.audioAt - an.out - (an.hint ?? 0);
      }
    }
    // Narration past the scene end → hold the last frame.
    const last = sc.audio.at(-1) as (typeof sc.audio)[number];
    const end = last.at + (last.src[1] - last.src[0]) + 200;
    if (end > sc.durationMs) {
      const extra = Math.round(end - sc.durationMs);
      const lastSrc = [...sc.pieces].reverse().find((x) => "src" in x) as
        | { src: [number, number] }
        | undefined;
      const holdAt = lastSrc ? lastSrc.src[1] - 1 : 0;
      sc.pieces.push({ freeze: { at: holdAt, dur: extra } });
      sc.durationMs += extra;
      sc.stats.stretchMs += extra;
      t.totals.fullMs += extra;
    }
    if (moved !== 0) applied.push({ ...f, deltaMs: moved });
    else skipped.push({ fix: f, why: "no room to move it" });
  }
  return { timeline: t, applied, skipped };
}
