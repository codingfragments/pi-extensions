/**
 * Spike Q3 (S5): how to render smooth zooms.
 *
 * A static source (3200×1800, like a dpr-2 capture) with Gaussian dots at
 * known positions is zoomed 1 → 1.5× → 1 with eased timing. Every candidate
 * renders 1766×994 gray frames (the neutral brand's inset size). We track each
 * dot's centroid per frame and compare it with the analytic ideal:
 *   - jitter: RMS of (second difference measured − second difference ideal), px
 *     (integer snapping shows up here; smooth sub-pixel motion ≈ 0)
 *   - drift: RMS position error after removing each dot's mean offset, px
 *   - speed: wall time for the same graph on a real UI frame with x264.
 *
 * Usage: node src/spike/zoom.ts [realFrame.png]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SW = 3200;
const SH = 1800;
const OW = 1766;
const OH = 994;
const FPS = 30;
const DUR = 5;
const Z = 1.5;
const IN = { at: 1.0, dur: 0.6 };
const OUT = { at: 3.4, dur: 0.5 };
// Zoom target: a box's center (source px), rect clamped to the frame.
const TARGET = { cx: 2300, cy: 640 };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-zoom-spike-"));

// ---- zoom curve (shared by all candidates and the ideal) ----
const ease = (u: number) => u * u * (3 - 2 * u); // smoothstep
function progress(t: number): number {
  if (t < IN.at) return 0;
  if (t < IN.at + IN.dur) return ease((t - IN.at) / IN.dur);
  if (t < OUT.at) return 1;
  if (t < OUT.at + OUT.dur) return 1 - ease((t - OUT.at) / OUT.dur);
  return 0;
}
function target(): { L: number; T: number; w: number; h: number } {
  const w = SW / Z;
  const h = SH / Z;
  const L = Math.min(Math.max(TARGET.cx - w / 2, 0), SW - w);
  const T = Math.min(Math.max(TARGET.cy - h / 2, 0), SH - h);
  return { L, T, w, h };
}
/** Source rect at time t: lerp(full frame, target rect, progress). */
function rect(t: number) {
  const p = progress(t);
  const g = target();
  return { L: g.L * p, T: g.T * p, w: SW + (g.w - SW) * p, h: SH + (g.h - SH) * p };
}

// ---- same curve as an ffmpeg expression in variable `T` (seconds) ----
function progressExpr(T: string): string {
  const u1 = `((${T}-${IN.at})/${IN.dur})`;
  const u2 = `((${T}-${OUT.at})/${OUT.dur})`;
  const e = (u: string) => `(${u}*${u}*(3-2*${u}))`;
  return `if(lt(${T},${IN.at}),0,if(lt(${T},${IN.at + IN.dur}),${e(u1)},if(lt(${T},${OUT.at}),1,if(lt(${T},${OUT.at + OUT.dur}),1-${e(u2)},0))))`;
}
function rectExprs(T: string) {
  const g = target();
  const P = progressExpr(T);
  return {
    L: `(${g.L.toFixed(3)}*${P})`,
    Tp: `(${g.T.toFixed(3)}*${P})`,
    w: `(${SW}+(${(g.w - SW).toFixed(3)})*${P})`,
    h: `(${SH}+(${(g.h - SH).toFixed(3)})*${P})`,
  };
}

// ---- candidates ----
function perspective(T: string, interp: "linear" | "cubic", srcW = SW, srcH = SH): string {
  const r = rectExprs(T);
  const k = srcW / SW; // when zooming after a downscale, scale the rect
  const L = `(${r.L}*${k})`;
  const Tp = `(${r.Tp}*${k})`;
  const w = `(${r.w}*${k})`;
  const h = `(${r.h}*${srcH / SH})`;
  const R = `(${L}+${w})`;
  const B = `(${Tp}+${h})`;
  return `perspective=x0='${L}':y0='${Tp}':x1='${R}':y1='${Tp}':x2='${L}':y2='${B}':x3='${R}':y3='${B}':interpolation=${interp}:sense=source:eval=frame`;
}
const CANDIDATES: { id: string; label: string; graph: string }[] = [
  {
    id: "zoompan",
    label: "zoompan at source res (classic)",
    graph: (() => {
      const r = rectExprs("(on/30)");
      return `zoompan=z='${SW}/${r.w}':x='${r.L}':y='${r.Tp}':d=1:s=${OW}x${OH}:fps=${FPS}`;
    })(),
  },
  {
    id: "crop-int",
    label: "integer crop at source res + scale (what crop/scale expressions give)",
    // crop's w/h are init-only, so emulate per-frame integer cropping with
    // zoompan on an exact integer grid — same snapping as crop=x:y + scale.
    graph: (() => {
      const r = rectExprs("(on/30)");
      return `zoompan=z='${SW}/floor(${r.w})':x='floor(${r.L})':y='floor(${r.Tp})':d=1:s=${OW}x${OH}:fps=${FPS}`;
    })(),
  },
  {
    id: "persp-linear",
    label: "perspective (linear) at source res → scale",
    graph: `${perspective("((in-1)/30)", "linear")},scale=${OW}:${OH}:flags=lanczos`,
  },
  {
    id: "persp-cubic",
    label: "perspective (cubic) at source res → scale",
    graph: `${perspective("((in-1)/30)", "cubic")},scale=${OW}:${OH}:flags=lanczos`,
  },
  {
    id: "persp-after",
    label: "scale to inset first → perspective (cubic) (zoom upscales)",
    graph: `scale=${OW}:${OH}:flags=lanczos,${perspective("((in-1)/30)", "cubic", OW, OH)}`,
  },
];

// ---- synthetic dot source ----
const DOTS = [
  [1700, 300],
  [2300, 640],
  [2900, 980],
  [1800, 1000],
  [2700, 400],
  [400, 300],
  [1600, 1500],
  [3000, 1650],
] as const;
function dotSource(): string {
  const buf = Buffer.alloc(SW * SH, 255);
  const s = 3.2;
  for (const [cx, cy] of DOTS) {
    for (let y = cy - 14; y <= cy + 14; y++)
      for (let x = cx - 14; x <= cx + 14; x++) {
        const v = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
        const i = y * SW + x;
        buf[i] = Math.min(buf[i] as number, Math.round(255 * (1 - v)));
      }
  }
  const file = path.join(dir, "dots.pgm");
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${SW} ${SH}\n255\n`), buf]));
  return file;
}

function ffmpeg(args: string[]): number {
  const t0 = performance.now();
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().slice(-800)}`);
  return performance.now() - t0;
}

function ideal(t: number, x: number, y: number): [number, number] {
  const r = rect(t);
  // pixel-center convention: (p + 0.5 - L) * OW/w - 0.5
  return [((x + 0.5 - r.L) * OW) / r.w - 0.5, ((y + 0.5 - r.T) * OH) / r.h - 0.5];
}

function centroid(frame: Buffer, ex: number, ey: number): [number, number] | undefined {
  const R = 9;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let y = Math.round(ey) - R; y <= Math.round(ey) + R; y++)
    for (let x = Math.round(ex) - R; x <= Math.round(ex) + R; x++) {
      if (x < 0 || y < 0 || x >= OW || y >= OH) return undefined;
      const w = Math.max(0, 250 - (frame[y * OW + x] as number));
      sx += w * x;
      sy += w * y;
      sw += w;
    }
  return sw > 50 ? [sx / sw, sy / sw] : undefined;
}

function measure(rawFile: string): { jitter: number; drift: number; worstJitter: number } {
  const raw = fs.readFileSync(rawFile);
  const frames = Math.floor(raw.length / (OW * OH));
  let j2 = 0;
  let jn = 0;
  let worst = 0;
  let d2 = 0;
  let dn = 0;
  for (const [x, y] of DOTS) {
    const meas: ([number, number] | undefined)[] = [];
    const ide: [number, number][] = [];
    for (let n = 0; n < frames; n++) {
      const e = ideal(n / FPS, x, y);
      ide.push(e);
      meas.push(centroid(raw.subarray(n * OW * OH, (n + 1) * OW * OH), e[0], e[1]));
    }
    const ok = meas.map((m, n) =>
      m
        ? [m[0] - (ide[n] as [number, number])[0], m[1] - (ide[n] as [number, number])[1]]
        : undefined,
    );
    const valid = ok.filter(Boolean) as number[][];
    if (valid.length < frames * 0.8) continue; // dot leaves the frame while zoomed
    const mx = valid.reduce((s, v) => s + (v[0] as number), 0) / valid.length;
    const my = valid.reduce((s, v) => s + (v[1] as number), 0) / valid.length;
    for (const v of valid) {
      d2 += ((v[0] as number) - mx) ** 2 + ((v[1] as number) - my) ** 2;
      dn++;
    }
    for (let n = 1; n < frames - 1; n++) {
      const a = ok[n - 1];
      const b = ok[n];
      const c = ok[n + 1];
      if (!a || !b || !c) continue;
      const jx = (a[0] as number) - 2 * (b[0] as number) + (c[0] as number);
      const jy = (a[1] as number) - 2 * (b[1] as number) + (c[1] as number);
      const j = Math.hypot(jx, jy);
      worst = Math.max(worst, j);
      j2 += j * j;
      jn++;
    }
  }
  return {
    jitter: Math.sqrt(j2 / Math.max(1, jn)),
    drift: Math.sqrt(d2 / Math.max(1, dn)),
    worstJitter: worst,
  };
}

/** Sharpness at full zoom: mean absolute Laplacian of a crop (higher = crisper). */
function sharpness(file: string): number {
  const out = path.join(dir, "sharp.gray");
  ffmpeg([
    "-ss",
    "2.5",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=600:400:${OW - 700}:150,format=gray`,
    "-f",
    "rawvideo",
    out,
  ]);
  const b = fs.readFileSync(out);
  const W = 600;
  let s = 0;
  let n = 0;
  for (let y = 1; y < 399; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      s += Math.abs(
        4 * (b[i] as number) -
          (b[i - 1] as number) -
          (b[i + 1] as number) -
          (b[i - W] as number) -
          (b[i + W] as number),
      );
      n++;
    }
  return s / n;
}

function debugSeries(id: string): void {
  const c = CANDIDATES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown candidate ${id}`);
  const raw = path.join(dir, `${c.id}.gray`);
  ffmpeg([
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    String(DUR),
    "-i",
    dotSource(),
    "-vf",
    `format=gray,${c.graph},format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    raw,
  ]);
  const b = fs.readFileSync(raw);
  const [x, y] = DOTS[2] as readonly [number, number];
  for (let n = 20; n < 60; n++) {
    const e = ideal(n / FPS, x, y);
    const m = centroid(b.subarray(n * OW * OH, (n + 1) * OW * OH), e[0], e[1]);
    const e1 = ideal((n - 1) / FPS, x, y);
    console.log(
      `${n} ideal ${e[0].toFixed(1)},${e[1].toFixed(1)} meas ${m?.map((v) => v.toFixed(1)).join(",")} err ${m ? (m[0] - e[0]).toFixed(2) : "-"} (vs n-1: ${m ? (m[0] - e1[0]).toFixed(2) : "-"})`,
    );
  }
}
if (process.env.DEMO_ZOOM_DEBUG) {
  debugSeries(process.env.DEMO_ZOOM_DEBUG);
  process.exit(0);
}

const dots = dotSource();
const real = process.argv[2];
console.log(
  `spike dir: ${dir}\nsource ${SW}×${SH} → ${OW}×${OH}, zoom ${Z}× at (${TARGET.cx},${TARGET.cy}), ${DUR}s@${FPS}\n`,
);
const rows: string[] = [];
for (const c of CANDIDATES) {
  const raw = path.join(dir, `${c.id}.gray`);
  ffmpeg([
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    String(DUR),
    "-i",
    dots,
    "-vf",
    `format=gray,${c.graph},format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    raw,
  ]);
  const m = measure(raw);
  let speed = "";
  let sharp = "";
  if (real) {
    const mp4 = path.join(dir, `${c.id}.mp4`);
    const ms = ffmpeg([
      "-loop",
      "1",
      "-framerate",
      String(FPS),
      "-t",
      String(DUR),
      "-i",
      real,
      "-vf",
      `scale=${SW}:${SH},format=yuv420p,${c.graph},format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      mp4,
    ]);
    speed = `${((DUR * FPS) / (ms / 1000)).toFixed(0)} fps`;
    sharp = sharpness(mp4).toFixed(1);
  }
  rows.push(
    `| ${c.id} | ${c.label} | ${m.jitter.toFixed(3)} | ${m.worstJitter.toFixed(2)} | ${m.drift.toFixed(3)} | ${speed} | ${sharp} |`,
  );
  fs.rmSync(raw, { force: true });
}
console.log(
  "| id | candidate | jitter RMS px | worst jitter px | drift RMS px | speed (x264, real frame) | sharpness @1.5× |",
);
console.log("|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
