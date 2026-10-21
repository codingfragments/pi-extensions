/**
 * Motion map of a take (S4): where does the screen change on its own?
 *
 * Decodes raw.mp4 at 320×180 gray (streamed, constant memory) and computes the
 * fraction of changed pixels per frame. Sustained change larger than a cursor
 * becomes a MOTION range: in-app video, animations, streaming text, spinners.
 * The editor never freezes or strongly speeds up motion ranges (an in-app
 * video would visibly stop or fast-forward); it prefers cuts there.
 *
 * Pure range logic (`motionRanges`) is separated from decoding for tests.
 */

import { spawn } from "node:child_process";
import { defaultTimeoutMs, guardChild } from "../util/bounded.ts";

export const MOTION_W = 320;
export const MOTION_H = 180;
/** Pixel-level change threshold (0..255). */
const PIXEL_DELTA = 18;
/** Changed fraction above which a frame counts as "moving" (≈ larger than a cursor trail). */
export const ACTIVE_FRACTION = 0.004;

export interface MotionRange {
  start: number;
  end: number;
  /** Mean changed fraction while active. */
  area: number;
  /** Changed-pixel bounding box in CSS px of the capture viewport. */
  box: { x: number; y: number; w: number; h: number };
}

export interface MotionMap {
  fps: number;
  /** Changed fraction per frame (index 0 = frame 1 vs frame 0). */
  scores: number[];
  boxes: ([number, number, number, number] | null)[];
  ranges: MotionRange[];
}

/** Merge active frames into sustained ranges (ms on the take timeline). */
export function motionRanges(
  scores: number[],
  boxes: ([number, number, number, number] | null)[],
  fps: number,
  scale: { x: number; y: number },
  opts: { minMs?: number; gapFrames?: number } = {},
): MotionRange[] {
  const minFrames = Math.round(((opts.minMs ?? 500) / 1000) * fps);
  const gap = opts.gapFrames ?? 3;
  const out: MotionRange[] = [];
  let start = -1;
  let last = -1;
  const flush = () => {
    if (start < 0) return;
    if (last - start + 1 >= minFrames) {
      let sum = 0;
      let n = 0;
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = 0;
      let y1 = 0;
      for (let i = start; i <= last; i++) {
        const s = scores[i] ?? 0;
        if (s < ACTIVE_FRACTION) continue;
        sum += s;
        n++;
        const b = boxes[i];
        if (b) {
          x0 = Math.min(x0, b[0]);
          y0 = Math.min(y0, b[1]);
          x1 = Math.max(x1, b[2]);
          y1 = Math.max(y1, b[3]);
        }
      }
      out.push({
        start: Math.round(((start + 1) * 1000) / fps),
        end: Math.round(((last + 2) * 1000) / fps),
        area: +(sum / Math.max(1, n)).toFixed(4),
        box: Number.isFinite(x0)
          ? {
              x: Math.round(x0 * scale.x),
              y: Math.round(y0 * scale.y),
              w: Math.round((x1 - x0 + 1) * scale.x),
              h: Math.round((y1 - y0 + 1) * scale.y),
            }
          : { x: 0, y: 0, w: 0, h: 0 },
      });
    }
    start = -1;
  };
  scores.forEach((s, i) => {
    if (s >= ACTIVE_FRACTION) {
      if (start < 0) start = i;
      else if (i - last > gap) {
        flush();
        start = i;
      }
      last = i;
    }
  });
  flush();
  return out;
}

/** Decode `video` and compute the motion map. `viewport` maps boxes back to CSS px. */
export function computeMotion(
  video: string,
  fps: number,
  viewport: { width: number; height: number },
): Promise<MotionMap> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video,
        "-vf",
        `fps=${fps},scale=${MOTION_W}:${MOTION_H}:flags=area,format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const size = MOTION_W * MOTION_H;
    let prev: Buffer | undefined;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const scores: number[] = [];
    const boxes: ([number, number, number, number] | null)[] = [];
    let stderr = "";
    const stopWatch = guardChild(child, {
      label: "ffmpeg (motion)",
      cmd: "ffmpeg",
      args: ["-i", video],
      timeoutMs: defaultTimeoutMs("ffmpeg"),
      stderrTail: () => stderr,
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (prev) {
          let changed = 0;
          let x0 = MOTION_W;
          let y0 = MOTION_H;
          let x1 = -1;
          let y1 = -1;
          for (let i = 0; i < size; i++) {
            if (Math.abs((frame[i] as number) - (prev[i] as number)) > PIXEL_DELTA) {
              changed++;
              const x = i % MOTION_W;
              const y = (i / MOTION_W) | 0;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
          scores.push(+(changed / size).toFixed(5));
          boxes.push(x1 >= 0 ? [x0, y0, x1, y1] : null);
        }
        prev = Buffer.from(frame);
      }
    });
    child.on("error", (err) => {
      stopWatch();
      reject(err);
    });
    child.on("close", (code) => {
      stopWatch();
      if (code !== 0)
        return reject(
          new Error(`ffmpeg motion decode failed: ${stderr.trim().split("\n").at(-1)}`),
        );
      const scale = { x: viewport.width / MOTION_W, y: viewport.height / MOTION_H };
      resolve({ fps, scores, boxes, ranges: motionRanges(scores, boxes, fps, scale) });
    });
  });
}
