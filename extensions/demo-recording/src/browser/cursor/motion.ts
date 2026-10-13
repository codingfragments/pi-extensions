/**
 * Cursor motion. S1: eased straight-line moves with Fitts-like duration and a
 * seeded aim point inside the target. S3 replaces the path with ghost-cursor
 * bezier/overshoot paths and adds typing/scroll models — same interface.
 */

import type { Page } from "playwright";
import type { Box } from "../../recorder/events.ts";
import { sleep } from "../../util/duration.ts";
import type { Rng } from "../../util/rng.ts";

export interface Point {
  x: number;
  y: number;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Fitts-like movement time: farther and smaller targets take longer. */
export function moveDuration(distance: number, targetWidth = 40): number {
  return Math.round(
    Math.min(1400, 220 + 140 * Math.log2(1 + distance / Math.max(12, targetWidth))),
  );
}

/** A point inside the box, biased to the center (never in the outer 25%). */
export function aimPoint(box: Box, rng: Rng): Point {
  return {
    x: Math.round(box.x + box.w * (0.5 + rng.range(-0.25, 0.25))),
    y: Math.round(box.y + box.h * (0.5 + rng.range(-0.2, 0.2))),
  };
}

export class Cursor {
  private readonly page: Page;
  private readonly rng: Rng;
  pos: Point;

  constructor(page: Page, rng: Rng, start: Point) {
    this.page = page;
    this.rng = rng;
    this.pos = start;
  }

  /** Teleport without animation (off-camera placement). */
  async place(p: Point): Promise<void> {
    await this.page.mouse.move(p.x, p.y);
    this.pos = p;
  }

  async moveTo(to: Point, targetWidth = 40): Promise<void> {
    const from = this.pos;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 1) return;
    const duration = moveDuration(dist, targetWidth) * this.rng.range(0.9, 1.15);
    const start = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - start) / duration);
      const k = easeInOutCubic(t);
      const x = from.x + (to.x - from.x) * k;
      const y = from.y + (to.y - from.y) * k;
      await this.page.mouse.move(x, y);
      if (t >= 1) break;
      await sleep(16);
    }
    this.pos = to;
  }

  async click(): Promise<void> {
    await this.page.mouse.down();
    await sleep(this.rng.range(60, 120));
    await this.page.mouse.up();
  }
}
