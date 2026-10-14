/**
 * Footage rim (brand `frame.border`): a thin line just outside the inset
 * footage that separates it from the backdrop when the two are too similar
 * (a dark app on a dark backdrop, a light app on a light one). The shadow
 * cannot do that on dark backdrops.
 *
 * `color: "auto"` decides per render from the take itself: the mean
 * luminance of the outer ring of a few keyframes vs. the backdrop colors.
 */

import { spawnSync } from "node:child_process";
import type { Brand } from "./brand.ts";
import { luminance } from "./brand.ts";

/** Below this WCAG contrast between footage edge and backdrop, auto draws a rim. */
export const RIM_MIN_CONTRAST = 1.8;
const LIGHT_RIM = "#ffffff1f"; // ~12 % white, for dark backdrops
const DARK_RIM = "#00000026"; // ~15 % black, for light backdrops

const toLinear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Mean relative luminance (0..1) of the outer 2-px ring of each frame
 * (scaled to 64×36 gray), averaged over the frames. Undefined when no frame
 * could be read (no ffmpeg, missing files).
 */
export function edgeLuminance(frames: string[]): number | undefined {
  const W = 64;
  const H = 36;
  const values: number[] = [];
  for (const f of frames) {
    const r = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        f,
        "-vf",
        `scale=${W}:${H},format=gray`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ],
      {
        maxBuffer: 1 << 20,
      },
    );
    if (r.status !== 0 || r.stdout.length < W * H) continue;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (x >= 2 && x < W - 2 && y >= 2 && y < H - 2) continue;
        sum += toLinear((r.stdout[y * W + x] as number) / 255);
        n++;
      }
    values.push(sum / n);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

export interface Rim {
  /** Hex color with alpha. */
  color: string;
  /** Width in output pixels. */
  widthPx: number;
  /** Why (for summaries and the Brand tab). */
  reason: string;
}

/**
 * Resolve the brand's rim for one render. `edgeLum` = edgeLuminance of the
 * take's keyframes (undefined: unknown footage → auto draws the rim, which is
 * faint enough to be harmless on any footage).
 */
export function resolveRim(
  brand: Brand,
  size: { width: number; height: number },
  edgeLum: number | undefined,
): Rim | undefined {
  const b = brand.frame.border;
  if (brand.frame.mode !== "inset" || b.width <= 0) return undefined;
  const widthPx = Math.max(1, Math.round(b.width * (size.height / 1080) * 2) / 2);
  if (b.color !== "auto") return { color: b.color, widthPx, reason: "brand color" };
  const backdrops = [brand.colors.backdrop, brand.colors.backdropTo].map((c) =>
    luminance(c.slice(0, 7)),
  );
  const backdropLum = backdrops.reduce((a, x) => a + x, 0) / backdrops.length;
  const color = backdropLum < 0.18 ? LIGHT_RIM : DARK_RIM;
  if (edgeLum === undefined) return { color, widthPx, reason: "auto (footage unknown)" };
  // Worst case over the gradient: the backdrop color closest to the edge.
  const worst = Math.min(
    ...backdrops.map((l) => (Math.max(l, edgeLum) + 0.05) / (Math.min(l, edgeLum) + 0.05)),
  );
  if (worst >= RIM_MIN_CONTRAST) return undefined;
  return {
    color,
    widthPx,
    reason: `auto: footage edge vs backdrop contrast ${worst.toFixed(2)} < ${RIM_MIN_CONTRAST}`,
  };
}
