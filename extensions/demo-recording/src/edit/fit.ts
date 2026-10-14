/**
 * How well each scene's REAL narration fits its footage (S5, user request):
 *
 *   ok    — fits as is
 *   info  — narration a bit longer: the scene's end is stretched gently
 *           (dwell slowed ≤ 0.85×, final settled frame held) — no action needed
 *   warn  — stretch beyond max(1.5 s, 25 % of usable footage), a hold over
 *           moving content (overrun), or an anchor off-sync > 150 ms
 *
 * The audio always fits — it's never cut; the warning says the VIDEO had to wait.
 */

import type { Timeline } from "./timeline.ts";

export interface SceneFit {
  scene: string;
  /** Real narration length of the section (s), from the voice manifest. */
  voiceSec: number | null;
  /** Rendered scene length (s). */
  sceneSec: number;
  stretchMs: number;
  overrunMs: number;
  worstDriftMs: number;
  level: "ok" | "info" | "warn";
  message: string;
}

export const FIT = { stretchSilentMs: 1500, stretchShare: 0.25, driftMs: 150 };

export function sceneFits(
  t: Timeline,
  voiceSec: Record<string, number>,
  usableMs: Record<string, number>,
): SceneFit[] {
  return t.scenes.map((s) => {
    const stretch = Math.round(s.stats.stretchMs ?? 0);
    const overrun = Math.round(s.stats.overrunMs ?? 0);
    const drift = Math.max(0, ...s.anchors.map((a) => Math.abs(a.drift)));
    const limit = Math.max(FIT.stretchSilentMs, (usableMs[s.id] ?? 0) * FIT.stretchShare);
    const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    let level: SceneFit["level"] = "ok";
    let message = "fits";
    if (overrun > 100) {
      level = "warn";
      message = `⚠ overrun: narration runs ${sec(overrun)} past moving content (video/animation/streaming freezes) — shorten the end of this section`;
    } else if (drift > FIT.driftMs) {
      level = "warn";
      message = `⚠ narration reaches an anchor ${sec(drift)} late — shorten the text before it`;
    } else if (stretch > limit) {
      level = "warn";
      message = `⚠ narration runs ${sec(stretch)} past the action (end held) — consider trimming`;
    } else if (stretch > 100) {
      level = "info";
      message = `stretched +${sec(stretch)} at the end (dwell slowed / last frame held) so the narration fits`;
    }
    return {
      scene: s.id,
      voiceSec: voiceSec[s.id] ?? null,
      sceneSec: +(s.durationMs / 1000).toFixed(2),
      stretchMs: stretch,
      overrunMs: overrun,
      worstDriftMs: Math.round(drift),
      level,
      message,
    };
  });
}

export function formatFits(fits: SceneFit[]): string {
  return fits
    .map(
      (f) =>
        `- ${f.scene}: voice ${f.voiceSec === null ? "—" : `${f.voiceSec.toFixed(1)} s`} / scene ${f.sceneSec.toFixed(1)} s — ${f.message}`,
    )
    .join("\n");
}
