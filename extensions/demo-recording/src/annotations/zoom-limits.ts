/**
 * How many zooms a demo may have (item 12b, F21). A zoom is the loudest annotation, so there is a limit, and it is no longer a fixed "2 per demo": it
 * scales with the demo (zooms per minute) and keeps zooms apart (zooms per scene). Both are settings (`annotations.zoomsPerMinute`,
 * `annotations.zoomsPerScene`, global with a project override). ONE function decides, and every place that enforces or tells the limit uses it:
 * the designer's selection, the panel's edit rules, the input pack the designer reads, the budget meter.
 *
 * The validation of a stored file keeps only a sanity cap (`HARD_MAX_ZOOMS`): lowering a setting must never make an old version unreadable.
 */

import type { AnnotationItem } from "./types.ts";

export interface ZoomLimits {
  /** Zooms allowed per minute of the demo (0 = no zooms at all). */
  perMinute: number;
  /** Zooms allowed in one scene (0 = no zooms at all). */
  perScene: number;
}

/** The defaults: for an 80 s demo this is the 2 zooms it always was, and a longer demo gets more. */
export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { perMinute: 1.5, perScene: 1 };

/** A demo whose length is not known (no edit yet) is treated as this long. */
export const ASSUMED_DEMO_MS = 80_000;

/** What a stored annotation file may hold at most, whatever the settings say. */
export const HARD_MAX_ZOOMS = 12;

/** The limits of a resolved config (`annotations.zoomsPerMinute` / `zoomsPerScene`). */
export const zoomLimitsOf = (cfg: {
  annotations: { zoomsPerMinute: number; zoomsPerScene: number };
}): ZoomLimits => ({
  perMinute: cfg.annotations.zoomsPerMinute,
  perScene: cfg.annotations.zoomsPerScene,
});

/** The most zooms the whole demo may have: per minute times the length, rounded up, at least 1 (unless zooms are off). */
export function zoomTotal(limits: ZoomLimits, durationMs: number = ASSUMED_DEMO_MS): number {
  if (limits.perMinute <= 0 || limits.perScene <= 0) return 0;
  return Math.max(1, Math.ceil((durationMs / 60_000) * limits.perMinute - 1e-6));
}

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The limit in words: "at most 2 zooms in this 1 min 20 s demo (1.5 per minute), 1 per scene". */
export function zoomLimitWords(limits: ZoomLimits, durationMs: number = ASSUMED_DEMO_MS): string {
  if (limits.perMinute <= 0 || limits.perScene <= 0) return "zooms are turned off";
  return `at most ${plural(zoomTotal(limits, durationMs), "zoom")} in this ${clock(durationMs)} demo (${limits.perMinute} per minute), ${limits.perScene} per scene`;
}

const isZoomOn = (it: AnnotationItem) => it.enabled && it.type === "zoom";

/**
 * Would switching `item` (a zoom) on break a limit? Returns the reason, or undefined when it fits. `items` is the file as it is now, `item`
 * itself not counted.
 */
export function zoomRefusal(
  items: AnnotationItem[],
  item: AnnotationItem,
  limits: ZoomLimits,
  durationMs: number = ASSUMED_DEMO_MS,
): string | undefined {
  if (limits.perMinute <= 0 || limits.perScene <= 0)
    return "zooms are turned off (annotations.zoomsPerMinute or zoomsPerScene is 0)";
  const others = items.filter((x) => x.id !== item.id && isZoomOn(x));
  const here = others.filter((x) => x.scene === item.scene).length;
  if (here >= limits.perScene)
    return `at most ${plural(limits.perScene, "zoom")} per scene (${item.scene} has ${here}) — turn that zoom off first, or raise annotations.zoomsPerScene`;
  const total = zoomTotal(limits, durationMs);
  if (others.length >= total)
    return `${zoomLimitWords(limits, durationMs)} — turn another zoom off first, or raise annotations.zoomsPerMinute`;
  return undefined;
}

/**
 * Switch off the zooms that go over the limits, keeping the first in file order; returns the ones switched off. For a file that just came in
 * (a suggestion, an import) so nothing over the limit is ever pre-enabled.
 */
export function trimZooms(
  items: AnnotationItem[],
  limits: ZoomLimits,
  durationMs: number = ASSUMED_DEMO_MS,
): AnnotationItem[] {
  const off: AnnotationItem[] = [];
  const kept: AnnotationItem[] = [];
  const perScene = new Map<string, number>();
  const total = zoomTotal(limits, durationMs);
  for (const it of items) {
    if (!isZoomOn(it)) continue;
    const n = perScene.get(it.scene) ?? 0;
    if (kept.length >= total || n >= limits.perScene) {
      it.enabled = false;
      off.push(it);
    } else {
      kept.push(it);
      perScene.set(it.scene, n + 1);
    }
  }
  return off;
}

/** What the budget meter says: "Zooms 1 of 2" with the reason in a title. */
export function zoomUse(
  items: AnnotationItem[],
  limits: ZoomLimits,
  durationMs: number = ASSUMED_DEMO_MS,
): { used: number; total: number; words: string } {
  return {
    used: items.filter(isZoomOn).length,
    total: zoomTotal(limits, durationMs),
    words: zoomLimitWords(limits, durationMs),
  };
}
