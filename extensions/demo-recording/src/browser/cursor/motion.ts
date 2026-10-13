/**
 * Human cursor motion (S3, D1).
 *
 * Geometry: ghost-cursor's bezier paths (curvature + jitter), generated with
 * our seeded RNG swapped in for Math.random so a take replays exactly.
 * Timing: Fitts-law duration with a minimum-jerk velocity profile (slow start,
 * fast middle, slow landing) — ghost-cursor's own timestamps are far too slow
 * for demos. Long moves overshoot slightly and correct, like a real hand.
 *
 * Every point is a real `page.mouse.move`, so hover states fire and the
 * injected overlay cursor (overlay.js) follows.
 */

import { path as ghostPath } from "@playwright-labs/ghost-cursor";
import type { Page } from "playwright";
import type { Box } from "../../recorder/events.ts";
import { sleep } from "../../util/duration.ts";
import type { Rng } from "../../util/rng.ts";

export interface Point {
  x: number;
  y: number;
}

export interface TimedPoint extends Point {
  /** ms from the start of the move */
  t: number;
}

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

/** Minimum-jerk position profile s(τ) for τ ∈ [0,1]. */
export const minJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Run `fn` with Math.random replaced by the seeded RNG (ghost-cursor uses Math.random). */
function withSeededRandom<T>(rng: Rng, fn: () => T): T {
  const original = Math.random;
  Math.random = () => rng.next();
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function geometry(from: Point, to: Point, rng: Rng): Point[] {
  const pts = withSeededRandom(rng, () => ghostPath(from, to, { useTimestamps: false })) as Point[];
  const out = pts.length >= 2 ? pts : [from, to];
  out[0] = { ...from };
  out[out.length - 1] = { ...to };
  return out;
}

/** Resample a polyline by arc length on a min-jerk timeline at ~60 Hz. */
export function timePath(points: Point[], duration: number, hz = 60): TimedPoint[] {
  const seg: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    seg.push((seg[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = seg.at(-1) as number;
  const steps = Math.max(2, Math.round((duration / 1000) * hz));
  const out: TimedPoint[] = [];
  let j = 1;
  for (let k = 0; k <= steps; k++) {
    const tau = k / steps;
    const d = minJerk(tau) * total;
    while (j < seg.length - 1 && (seg[j] as number) < d) j++;
    const a = points[j - 1] as Point;
    const b = points[j] as Point;
    const span = (seg[j] as number) - (seg[j - 1] as number) || 1;
    const f = Math.min(1, Math.max(0, (d - (seg[j - 1] as number)) / span));
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, t: Math.round(tau * duration) });
  }
  return out;
}

/**
 * Full human move: curved path, Fitts duration with ±12 % variation, and for
 * long moves an overshoot of 3–6 % past the target followed by a short
 * correction. Returns the timed points (ms from move start).
 */
export function planMove(from: Point, to: Point, targetWidth: number, rng: Rng): TimedPoint[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 1) return [{ ...to, t: 0 }];
  const duration = moveDuration(dist, targetWidth) * rng.range(0.9, 1.12);
  const overshoot = dist > 450 && rng.next() < 0.6;
  if (!overshoot) return timePath(geometry(from, to, rng), duration);

  const k = rng.range(0.03, 0.06);
  const past = {
    x: to.x + (to.x - from.x) * k + rng.range(-4, 4),
    y: to.y + (to.y - from.y) * k + rng.range(-4, 4),
  };
  const main = timePath(geometry(from, past, rng), duration * 0.9);
  const settleDur = rng.range(140, 220);
  const end = (main.at(-1) as TimedPoint).t;
  const pause = rng.range(40, 80); // the hand notices the overshoot, then corrects
  const correction = timePath([past, to], settleDur, 60)
    .slice(1)
    .map((p) => ({ ...p, t: end + pause + p.t }));
  return [...main, ...correction];
}

export class Cursor {
  private readonly page: Page;
  private readonly rng: Rng;
  pos: Point;
  /** Fast mode: teleport, no animation (off-camera replay). */
  fast = false;

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
    if (this.fast) return this.place(to);
    const plan = planMove(this.pos, to, targetWidth, this.rng);
    const start = Date.now();
    for (const p of plan) {
      const wait = start + p.t - Date.now();
      if (wait > 2) await sleep(wait);
      await this.page.mouse.move(p.x, p.y);
    }
    this.pos = to;
  }

  /** Tiny hand drift while "reading" (a few px over `ms`). Skipped in fast mode. */
  async drift(ms: number): Promise<void> {
    if (this.fast || ms < 300) {
      if (ms > 0 && !this.fast) await sleep(ms);
      return;
    }
    const home = this.pos;
    const end = Date.now() + ms;
    while (Date.now() < end - 200) {
      const target = { x: home.x + this.rng.range(-5, 5), y: home.y + this.rng.range(-3, 3) };
      const plan = timePath(
        [this.pos, target],
        Math.min(end - Date.now(), this.rng.range(250, 600)),
        30,
      );
      const start = Date.now();
      for (const p of plan) {
        const wait = start + p.t - Date.now();
        if (wait > 2) await sleep(wait);
        await this.page.mouse.move(p.x, p.y);
      }
      this.pos = target;
      await sleep(Math.max(0, Math.min(end - Date.now(), this.rng.range(150, 450))));
    }
    const rest = end - Date.now();
    if (rest > 0) await sleep(rest);
  }

  /** Eased wheel scroll by `dy` CSS px (positive = down), ~human speed. */
  async scrollBy(dy: number): Promise<void> {
    if (Math.abs(dy) < 2) return;
    if (this.fast) {
      await this.page.mouse.wheel(0, dy);
      return;
    }
    const duration = Math.min(1600, 300 + Math.abs(dy) * 0.6) * this.rng.range(0.9, 1.1);
    const start = Date.now();
    let done = 0;
    for (;;) {
      const t = Math.min(1, (Date.now() - start) / duration);
      const target = dy * easeInOutCubic(t);
      const step = target - done;
      if (Math.abs(step) >= 1 || t >= 1) {
        await this.page.mouse.wheel(0, step);
        done += step;
      }
      if (t >= 1) break;
      await sleep(16);
    }
  }

  async click(): Promise<void> {
    await this.page.mouse.down();
    if (!this.fast) await sleep(this.rng.range(60, 120));
    await this.page.mouse.up();
  }
}
