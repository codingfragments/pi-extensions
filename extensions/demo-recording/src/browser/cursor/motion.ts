/**
 * Human cursor motion (S3, D1) — tuned for screen recordings.
 *
 * Geometry: one smooth cubic bezier arc per move (both control points on the
 * same side → a gentle C-curve, never an S or a loop), evaluated densely so
 * there are no visible polyline corners. Seeded RNG, so a take replays exactly.
 *
 * Timing: Fitts-law duration with a minimum-jerk velocity profile (slow
 * start, fast middle, slow landing), sampled from REAL elapsed time on every
 * tick — a late timer never produces a jump, the cursor just lands where it
 * should be at that moment.
 *
 * Measured in a 30 fps sampling bench (direction change between consecutive
 * video frames): the previous sparse-polyline version had a median kink of
 * 19° (p90 53°) and ~3 speed jumps per move; this version stays smooth.
 *
 * Every sample is a real `page.mouse.move`, so hover states fire and the
 * injected overlay cursor (overlay.js) follows.
 */

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

/** Tick interval for driving the mouse (≈120 Hz; the page paints at 60 Hz). */
const TICK_MS = 8;

/** Fitts-like movement time: farther and smaller targets take longer. Demo-paced. */
export function moveDuration(distance: number, targetWidth = 40): number {
  return Math.round(
    Math.min(1600, 380 + 170 * Math.log2(1 + distance / Math.max(16, targetWidth))),
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

/** Dense polyline with cumulative arc length. */
interface Curve {
  pts: Point[];
  cum: number[];
  length: number;
}

function cubic(p0: Point, c1: Point, c2: Point, p3: Point, samples: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({
      x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
      y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
    });
  }
  return out;
}

function toCurve(pts: Point[]): Curve {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Point;
    const b = pts[i] as Point;
    cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { pts, cum, length: cum.at(-1) as number };
}

/** A gentle arc from `from` to `to` (C-curve, bend ∝ distance, capped). */
export function arc(from: Point, to: Point, rng: Rng): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [from, to];
  const nx = -dy / dist;
  const ny = dx / dist;
  const side = rng.next() < 0.5 ? -1 : 1;
  const bend = side * Math.min(110, dist * rng.range(0.05, 0.14));
  const k1 = rng.range(0.22, 0.36);
  const k2 = rng.range(0.64, 0.8);
  const c1 = {
    x: from.x + dx * k1 + nx * bend * rng.range(0.75, 1.05),
    y: from.y + dy * k1 + ny * bend * rng.range(0.75, 1.05),
  };
  const c2 = {
    x: from.x + dx * k2 + nx * bend * rng.range(0.75, 1.05),
    y: from.y + dy * k2 + ny * bend * rng.range(0.75, 1.05),
  };
  return cubic(from, c1, c2, to, Math.max(24, Math.min(240, Math.round(dist / 4))));
}

function pointAt(curve: Curve, d: number): Point {
  if (d <= 0) return curve.pts[0] as Point;
  if (d >= curve.length) return curve.pts.at(-1) as Point;
  // binary search the cumulative table
  let lo = 0;
  let hi = curve.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((curve.cum[mid] as number) < d) lo = mid;
    else hi = mid;
  }
  const a = curve.pts[lo] as Point;
  const b = curve.pts[hi] as Point;
  const span = (curve.cum[hi] as number) - (curve.cum[lo] as number) || 1;
  const f = (d - (curve.cum[lo] as number)) / span;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Piecewise trajectory: min-jerk along each curve segment, sampled by time. */
export class Trajectory {
  private readonly segs: { curve: Curve; start: number; duration: number }[] = [];
  readonly end: Point;
  duration = 0;

  constructor(start: Point) {
    this.end = start;
  }

  add(points: Point[], duration: number, gapMs = 0): this {
    const start = this.duration + gapMs;
    this.segs.push({ curve: toCurve(points), start, duration: Math.max(1, duration) });
    this.duration = start + Math.max(1, duration);
    (this as { end: Point }).end = points.at(-1) as Point;
    return this;
  }

  sample(t: number): Point {
    const seg = this.segs.find((s) => t < s.start + s.duration) ?? this.segs.at(-1);
    if (!seg) return this.end;
    if (t < seg.start) return seg.curve.pts[0] as Point; // in a gap: hold
    const tau = Math.min(1, Math.max(0, (t - seg.start) / seg.duration));
    return pointAt(seg.curve, minJerk(tau) * seg.curve.length);
  }
}

/** Kept for tests/compat: a single-curve min-jerk sampling at `hz`. */
export function timePath(points: Point[], duration: number, hz = 60): TimedPoint[] {
  const tr = new Trajectory(points[0] as Point).add(points, duration);
  const steps = Math.max(2, Math.round((duration / 1000) * hz));
  return Array.from({ length: steps + 1 }, (_, k) => {
    const t = (k / steps) * duration;
    return { ...tr.sample(t), t: Math.round(t) };
  });
}

/**
 * Full human move as a trajectory: one gentle arc with Fitts duration
 * (±9 %); moves > 600 px occasionally (35 %) overshoot by 1.5–3 % and flow
 * straight into a short correction.
 */
export function planTrajectory(from: Point, to: Point, targetWidth: number, rng: Rng): Trajectory {
  const tr = new Trajectory(from);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 1) return tr.add([from, to], 1);
  const duration = moveDuration(dist, targetWidth) * rng.range(0.92, 1.09);
  if (!(dist > 600 && rng.next() < 0.35)) return tr.add(arc(from, to, rng), duration);
  const k = rng.range(0.015, 0.03);
  const past = {
    x: to.x + (to.x - from.x) * k + rng.range(-3, 3),
    y: to.y + (to.y - from.y) * k + rng.range(-3, 3),
  };
  return tr
    .add(arc(from, past, rng), duration * 0.94)
    .add(arc(past, to, rng), rng.range(180, 260), rng.range(0, 25));
}

/** Timed points of a planned move at 60 Hz (tests, progress estimates). */
export function planMove(from: Point, to: Point, targetWidth: number, rng: Rng): TimedPoint[] {
  const tr = planTrajectory(from, to, targetWidth, rng);
  const steps = Math.max(1, Math.ceil(tr.duration / (1000 / 60)));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = Math.min(tr.duration, (i * 1000) / 60);
    return { ...tr.sample(t), t: Math.round(t) };
  });
}

/**
 * Idle-drift tuning (user-tuned after S3 review: "slower, and longer waits
 * between jiggles"). The cursor rests after landing, then makes a slow,
 * tiny move every couple of seconds — alive, never twitchy.
 */
export const DRIFT = {
  /** Dwells shorter than this stay perfectly still. */
  minDwellMs: 1800,
  /** Rest after landing before the first jiggle. */
  firstRestMs: [900, 1600] as const,
  /** Pause between jiggles. */
  gapMs: [1600, 3000] as const,
  /** Duration of one jiggle (slow). */
  moveMs: [1400, 2200] as const,
  /** Max offset from the landing point. */
  amplitude: { x: 2, y: 1.2 },
};

export interface DriftMove {
  /** Wait before this jiggle starts. */
  waitMs: number;
  moveMs: number;
  to: Point;
}

/** Plan the jiggles that fit in a dwell of `ms` (pure, seeded). */
export function planDrift(ms: number, home: Point, rng: Rng): DriftMove[] {
  if (ms < DRIFT.minDwellMs) return [];
  const out: DriftMove[] = [];
  let t = 0;
  let wait = rng.range(...DRIFT.firstRestMs);
  for (;;) {
    const moveMs = rng.range(...DRIFT.moveMs);
    if (t + wait + moveMs > ms - 200) break; // always end at rest
    out.push({
      waitMs: Math.round(wait),
      moveMs: Math.round(moveMs),
      to: {
        x: home.x + rng.range(-DRIFT.amplitude.x, DRIFT.amplitude.x),
        y: home.y + rng.range(-DRIFT.amplitude.y, DRIFT.amplitude.y),
      },
    });
    t += wait + moveMs;
    wait = rng.range(...DRIFT.gapMs);
  }
  return out;
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

  /**
   * Drive along a trajectory. The overlay animates it on the page's own
   * animation clock (smooth in video); real mouse events follow the same path
   * by elapsed time so hover states fire.
   */
  private async follow(tr: Trajectory): Promise<void> {
    const samples: number[][] = [];
    for (let t = 0; t < tr.duration; t += TICK_MS) {
      const p = tr.sample(t);
      samples.push([t, +p.x.toFixed(1), +p.y.toFixed(1)]);
    }
    samples.push([tr.duration, +tr.end.x.toFixed(1), +tr.end.y.toFixed(1)]);
    await this.page
      .evaluate(
        `window.__demoRecCursor ? window.__demoRecCursor.animate(${JSON.stringify(samples)}) : false`,
      )
      .catch(() => false);
    const start = Date.now();
    for (;;) {
      const t = Date.now() - start;
      const p = tr.sample(Math.min(t, tr.duration));
      await this.page.mouse.move(p.x, p.y);
      if (t >= tr.duration) break;
      await sleep(TICK_MS);
    }
    this.pos = tr.end;
  }

  async moveTo(to: Point, targetWidth = 40): Promise<void> {
    if (this.fast) return this.place(to);
    if (Math.hypot(to.x - this.pos.x, to.y - this.pos.y) < 1) return;
    await this.follow(planTrajectory(this.pos, to, targetWidth, this.rng));
  }

  /** Subtle hand drift while "reading" (see planDrift). Skipped in fast mode. */
  async drift(ms: number): Promise<void> {
    if (this.fast || ms <= 0) return;
    const end = Date.now() + ms;
    for (const j of planDrift(ms, this.pos, this.rng)) {
      await sleep(Math.max(0, j.waitMs));
      await this.follow(new Trajectory(this.pos).add([this.pos, j.to], j.moveMs));
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
