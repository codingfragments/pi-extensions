/**
 * Turn resolved annotations into render operations (S5 part 7):
 *
 *   page space  (source px, before the zoom — they move with it):
 *     redact     → blur of the element's region (never fades)
 *     highlight  → rounded outline PNG in the brand accent with a faint glow
 *     spotlight  → full-frame PNG darkening everything except the element
 *   zoom        → `perspective` window at source resolution (spike Q3)
 *   screen space (output px, after the brand frame — they stay put):
 *     callout    → branded pill at the bottom left of the footage
 *     chapter    → chapter title in the lower third (bottom left; callouts stack above it)
 *
 * Overlays are HTML templates rendered to transparent PNGs with Playwright,
 * cached by content hash (like the brand assets).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LoadedBrand } from "../brand/brand.ts";
import type { Box, ResolvedAnnotation } from "./resolve.ts";
import { type AnnotationType, MOTION, ZOOM_IN_MS, ZOOM_OUT_MS } from "./types.ts";

/**
 * Entry motion on top of the fade (D-part-7: "fade + small motion"):
 * dx/dy = start offset in px that eases to 0; grow = start scale − 1 that eases to 0.
 */
export interface Motion {
  dx?: number;
  dy?: number;
  grow?: number;
  ms: number;
}

export interface OverlayOp {
  id: string;
  type: AnnotationType;
  file: string;
  /** PNG size (px). */
  w: number;
  h: number;
  x: number;
  y: number;
  startMs: number;
  endMs: number;
  fadeMs: number;
  motion?: Motion;
}
export interface BlurOp {
  id: string;
  box: Box;
  startMs: number;
  endMs: number;
}
export interface ZoomOp {
  id: string;
  /** Target crop in source px (aspect = source aspect). */
  rect: Box;
  startMs: number;
  endMs: number;
}
export interface RenderAnnotations {
  page: OverlayOp[];
  blurs: BlurOp[];
  zooms: ZoomOp[];
  screen: OverlayOp[];
}

export const hasPageOps = (a: RenderAnnotations | undefined) =>
  !!a && (a.page.length > 0 || a.blurs.length > 0 || a.zooms.length > 0);
export const isEmpty = (a: RenderAnnotations | undefined) =>
  !a || (!hasPageOps(a) && a.screen.length === 0);

export interface BuildOptions {
  brand: LoadedBrand;
  /** Source (capture) size. */
  source: { w: number; h: number };
  /** Output frame size. */
  out: { width: number; height: number };
  /** Where the footage sits in the output frame (inset), or the whole frame. */
  footage: { x: number; y: number; w: number; h: number };
  cacheDir: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Zoom crop: centered on the target, source aspect, clamped; factor lowered if the target wouldn't fit. */
export function zoomRect(
  box: Box,
  factor: number,
  source: { w: number; h: number },
): { rect: Box; factor: number } {
  const fit = Math.min(factor, (source.w / box.w) * 0.85, (source.h / box.h) * 0.85);
  const f = Math.max(1, fit);
  const w = source.w / f;
  const h = source.h / f;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = Math.min(Math.max(cx - w / 2, 0), source.w - w);
  const y = Math.min(Math.max(cy - h / 2, 0), source.h - h);
  return { rect: { x, y, w, h }, factor: f };
}

function hash(parts: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
}

interface PngJob {
  key: string;
  html: string;
  /** Viewport for the page. */
  w: number;
  h: number;
  /** Clip to this element's box (pill-like overlays); else the whole viewport. */
  clipSelector?: string;
  /** Extra px around the clip (the drop shadow); the PNG's content then starts at (pad, pad). */
  clipPad?: number;
}

async function renderPngs(
  jobs: PngJob[],
  cacheDir: string,
): Promise<Map<string, { file: string; w: number; h: number; pad: number }>> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = new Map<string, { file: string; w: number; h: number; pad: number }>();
  const todo: PngJob[] = [];
  for (const j of jobs) {
    const file = path.join(
      cacheDir,
      `${hash([j.html, j.w, j.h, j.clipSelector ?? "", j.clipPad ?? 0])}.png`,
    );
    const meta = `${file}.json`;
    if (fs.existsSync(file) && fs.existsSync(meta))
      out.set(j.key, {
        file,
        pad: j.clipPad ?? 0,
        ...(JSON.parse(fs.readFileSync(meta, "utf8")) as { w: number; h: number }),
      });
    else todo.push(j);
  }
  if (!todo.length) return out;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const j of todo) {
      const page = await browser.newPage({
        viewport: { width: j.w, height: j.h },
        deviceScaleFactor: 1,
      });
      await page.setContent(j.html, { waitUntil: "load" });
      await page.evaluate("document.fonts && document.fonts.ready");
      const file = path.join(
        cacheDir,
        `${hash([j.html, j.w, j.h, j.clipSelector ?? "", j.clipPad ?? 0])}.png`,
      );
      let w = j.w;
      let h = j.h;
      if (j.clipSelector) {
        const bb = await page.locator(j.clipSelector).boundingBox();
        if (!bb) throw new Error(`overlay ${j.key}: nothing to render`);
        const pad = j.clipPad ?? 0;
        const clip = {
          x: Math.floor(bb.x) - pad,
          y: Math.floor(bb.y) - pad,
          width: Math.ceil(bb.width) + 1 + 2 * pad,
          height: Math.ceil(bb.height) + 1 + 2 * pad,
        };
        if (clip.x < 0 || clip.y < 0)
          throw new Error(`overlay ${j.key}: the shadow margin doesn't fit the page`);
        await page.screenshot({ path: file, omitBackground: true, clip });
        w = clip.width;
        h = clip.height;
      } else await page.screenshot({ path: file, omitBackground: true });
      fs.writeFileSync(`${file}.json`, JSON.stringify({ w, h }));
      out.set(j.key, { file, w, h, pad: j.clipPad ?? 0 });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

const fontCss = (l: LoadedBrand) => `font-family:${l.brand.font.family};`;

export async function buildRenderAnnotations(
  items: ResolvedAnnotation[],
  o: BuildOptions,
): Promise<{ ops: RenderAnnotations; warnings: string[] }> {
  const warnings: string[] = [];
  const b = o.brand.brand;
  const accent = b.colors.accent;
  /** Source px per output px of footage (e.g. 3200 / 1766 ≈ 1.8). */
  const k = o.source.w / o.footage.w;
  /** Output scale vs. 1080p. */
  const s = o.out.height / 1080;
  /** Room for the pills' drop shadow (offset 6 + blur 22 at 1080p). */
  const shadowPad = Math.round(32 * s);
  const jobs: PngJob[] = [];
  const ops: RenderAnnotations = { page: [], blurs: [], zooms: [], screen: [] };
  const pending: {
    r: ResolvedAnnotation;
    key: string;
    place: (w: number, h: number) => { x: number; y: number };
    space: "page" | "screen";
    motion?: Motion;
  }[] = [];

  for (const r of items) {
    if (r.type === "zoom" && r.box) {
      const z = zoomRect(r.box, r.factor ?? 1.5, o.source);
      if (z.factor < 1.1) {
        warnings.push(`${r.id}: the target is too large to zoom into — skipped`);
        continue;
      }
      if (z.factor < (r.factor ?? 1.5) - 0.01)
        warnings.push(
          `${r.id}: zoom lowered to ${z.factor.toFixed(2)}× so the whole target stays in view`,
        );
      if (r.endMs - r.startMs < ZOOM_IN_MS + ZOOM_OUT_MS + 300) {
        warnings.push(
          `${r.id}: too short for a zoom (needs ≥ ${(ZOOM_IN_MS + ZOOM_OUT_MS + 300) / 1000} s) — skipped`,
        );
        continue;
      }
      ops.zooms.push({ id: r.id, rect: z.rect, startMs: r.startMs, endMs: r.endMs });
    } else if (r.type === "redact" && r.box) {
      const pad = Math.round(4 * k);
      const x = even(r.box.x - pad);
      const y = even(r.box.y - pad);
      ops.blurs.push({
        id: r.id,
        box: {
          x: Math.max(0, x),
          y: Math.max(0, y),
          w: Math.min(even(r.box.w + 2 * pad), o.source.w - Math.max(0, x)),
          h: Math.min(even(r.box.h + 2 * pad), o.source.h - Math.max(0, y)),
        },
        startMs: r.startMs,
        endMs: r.endMs,
      });
    } else if (r.type === "highlight" && r.box) {
      const pad = Math.round(6 * k);
      const glow = Math.round(10 * k);
      const t = Math.max(2, Math.round(2 * k));
      const w = r.box.w + 2 * (pad + glow);
      const h = r.box.h + 2 * (pad + glow);
      const key = `hl-${r.id}`;
      jobs.push({
        key,
        w,
        h,
        html: `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:absolute;left:${glow}px;top:${glow}px;width:${r.box.w + 2 * pad}px;height:${r.box.h + 2 * pad}px;box-sizing:border-box;border:${t}px solid ${accent};border-radius:${Math.round(8 * k)}px;opacity:.78;box-shadow:0 0 ${glow}px ${Math.round(glow / 3)}px ${accent}55"></div></body></html>`,
      });
      pending.push({
        r,
        key,
        space: "page",
        motion: MOTION.highlight,
        place: () => ({ x: (r.box as Box).x - pad - glow, y: (r.box as Box).y - pad - glow }),
      });
    } else if (r.type === "spotlight" && r.box) {
      const pad = Math.round(8 * k);
      const key = `sp-${r.id}`;
      jobs.push({
        key,
        w: o.source.w,
        h: o.source.h,
        html: `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><div style="position:absolute;left:${r.box.x - pad}px;top:${r.box.y - pad}px;width:${r.box.w + 2 * pad}px;height:${r.box.h + 2 * pad}px;border-radius:${Math.round(10 * k)}px;box-shadow:0 0 0 ${o.source.w * 2}px rgba(0,0,0,.55)"></div></body></html>`,
      });
      pending.push({ r, key, space: "page", place: () => ({ x: 0, y: 0 }) });
    } else if (r.type === "callout" && r.text) {
      const key = `co-${r.id}`;
      jobs.push({
        key,
        w: o.out.width,
        h: Math.round(200 * s),
        clipSelector: "#pill",
        clipPad: shadowPad,
        html: `<!doctype html><html><body style="margin:0;background:transparent;${fontCss(o.brand)}"><div id="pill" style="display:inline-flex;align-items:center;gap:${Math.round(12 * s)}px;margin:${shadowPad + 4}px;padding:${Math.round(13 * s)}px ${Math.round(24 * s)}px;border-radius:999px;background:${b.colors.pill};color:${b.colors.pillText};font-size:${Math.round(28 * s)}px;font-weight:${b.font.weight};box-shadow:0 ${Math.round(6 * s)}px ${Math.round(22 * s)}px rgba(0,0,0,.35)"><span style="width:${Math.round(10 * s)}px;height:${Math.round(10 * s)}px;border-radius:50%;background:${accent}"></span>${esc(r.text)}</div></body></html>`,
      });
      pending.push({
        r,
        key,
        space: "screen",
        motion: { ...MOTION.callout, dy: Math.round((MOTION.callout.dy ?? 0) * s) },
        place: (_w, h) => ({
          x: o.footage.x + Math.round(30 * s),
          y: o.footage.y + o.footage.h - h - Math.round(30 * s),
        }),
      });
    } else if (r.type === "chapter" && r.text) {
      const key = `ch-${r.id}`;
      jobs.push({
        key,
        w: o.out.width,
        h: Math.round(220 * s),
        clipSelector: "#ch",
        clipPad: shadowPad,
        html: `<!doctype html><html><body style="margin:0;background:transparent;${fontCss(o.brand)}"><div id="ch" style="display:inline-flex;flex-direction:column;margin:${shadowPad + 4}px;padding:${Math.round(16 * s)}px ${Math.round(26 * s)}px ${Math.round(18 * s)}px;border-radius:${Math.round(14 * s)}px;background:${b.colors.pill};color:${b.colors.text};box-shadow:0 ${Math.round(6 * s)}px ${Math.round(22 * s)}px rgba(0,0,0,.35)"><div style="width:${Math.round(46 * s)}px;height:${Math.max(3, Math.round(4 * s))}px;border-radius:3px;background:${accent};margin-bottom:${Math.round(10 * s)}px"></div><div style="font-size:${Math.round(34 * s)}px;font-weight:${Math.max(600, b.font.weight)};letter-spacing:-.01em">${esc(r.text)}</div></div></body></html>`,
      });
      pending.push({
        r,
        key,
        space: "screen",
        motion: { ...MOTION.chapter, dx: Math.round((MOTION.chapter.dx ?? 0) * s) },
        place: (_w, h) => ({
          x: o.footage.x + Math.round(30 * s),
          y: o.footage.y + o.footage.h - h - Math.round(30 * s),
        }),
      });
    }
  }
  const pngs = await renderPngs(jobs, o.cacheDir);
  for (const p of pending) {
    const png = pngs.get(p.key);
    if (!png) continue;
    // Place by the visible element; the PNG extends `pad` px around it (shadow).
    const vis = p.place(png.w - 2 * png.pad, png.h - 2 * png.pad);
    const pos = { x: vis.x - png.pad, y: vis.y - png.pad };
    const op: OverlayOp = {
      id: p.r.id,
      type: p.r.type,
      file: png.file,
      w: png.w,
      h: png.h,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      startMs: p.r.startMs,
      endMs: p.r.endMs,
      fadeMs: p.r.fadeMs,
    };
    if (p.motion) op.motion = p.motion;
    (p.space === "page" ? ops.page : ops.screen).push(op);
  }
  // Chapter titles sit in the lower third; a callout shown at the same time stacks above it.
  const chapters = ops.screen.filter((x) => x.type === "chapter");
  for (const c of ops.screen) {
    if (c.type !== "callout") continue;
    const ch = chapters.find((x) => x.startMs < c.endMs && c.startMs < x.endMs);
    // (both PNGs carry the shadow pad around the visible element)
    if (ch) c.y = ch.y - c.h + 2 * shadowPad - Math.round(14 * s);
  }
  return { ops, warnings };
}

/** Image inputs for the annotation overlays, in filter-graph order (page, then screen). */
export const annotationImages = (a: RenderAnnotations | undefined) =>
  a ? [...a.page, ...a.screen].map((o) => o.file) : [];

/** Smoothstep zoom progress 0→1→0 over [s, e] with 0.6 s in and 0.5 s out (T = seconds). */
export function zoomProgressExpr(T: string, startMs: number, endMs: number): string {
  const s = startMs / 1000;
  const i = (startMs + ZOOM_IN_MS) / 1000;
  const o = (endMs - ZOOM_OUT_MS) / 1000;
  const e = endMs / 1000;
  const u1 = `((${T}-${s.toFixed(4)})/${(ZOOM_IN_MS / 1000).toFixed(4)})`;
  const u2 = `((${T}-${o.toFixed(4)})/${(ZOOM_OUT_MS / 1000).toFixed(4)})`;
  const ease = (u: string) => `(${u}*${u}*(3-2*${u}))`;
  return `if(lt(${T},${s.toFixed(4)}),0,if(lt(${T},${i.toFixed(4)}),${ease(u1)},if(lt(${T},${o.toFixed(4)}),1,if(lt(${T},${e.toFixed(4)}),1-${ease(u2)},0))))`;
}

/** One zoom as a `perspective` filter (cubic, per frame, only inside its window). */
export function zoomFilter(z: ZoomOp, source: { w: number; h: number }, fps: number): string {
  const P = zoomProgressExpr(`((in-1)/${fps})`, z.startMs, z.endMs);
  const L = `(${z.rect.x.toFixed(2)}*${P})`;
  const T = `(${z.rect.y.toFixed(2)}*${P})`;
  const W = `(${source.w}+(${(z.rect.w - source.w).toFixed(2)})*${P})`;
  const H = `(${source.h}+(${(z.rect.h - source.h).toFixed(2)})*${P})`;
  const R = `(${L}+${W})`;
  const B = `(${T}+${H})`;
  return `perspective=x0='${L}':y0='${T}':x1='${R}':y1='${T}':x2='${L}':y2='${B}':x3='${R}':y3='${B}':interpolation=cubic:sense=source:eval=frame:enable='between(t,${(z.startMs / 1000).toFixed(3)},${(z.endMs / 1000).toFixed(3)})'`;
}

const f3 = (n: number) => n.toFixed(3);
/** Eased entry 0→1 over [s, s+ms] as an expression in t (stored in register 0). */
const easeIn = (s: number, ms: number) =>
  `st(0,clip((t-${f3(s)})/${f3(ms / 1000)},0,1))*0+ld(0)*ld(0)*(3-2*ld(0))`;

/**
 * Filter chain for one overlay: `[img]…[o]` and `[main][o]overlay…[next]`.
 * Times are in the stream's own clock (seconds = ms / 1000 − offsetMs).
 */
export function overlayFilters(
  op: OverlayOp,
  imgLabel: string,
  main: string,
  next: string,
  offsetMs: number,
  tag: string,
): string[] {
  const S = (op.startMs - offsetMs) / 1000;
  const E = (op.endMs - offsetMs) / 1000;
  const F = Math.min(op.fadeMs / 1000, (E - S) / 3);
  const m = op.motion;
  const chain = [`trim=end=${f3(E + 0.04)}`, "format=rgba"];
  if (m?.grow) {
    const e = easeIn(S, m.ms);
    const g = `(1+${m.grow}*(1-(${e})))`;
    chain.push(`scale=w='trunc(${op.w}*${g}/2)*2':h='trunc(${op.h}*${g}/2)*2':eval=frame`);
  }
  if (F > 0)
    chain.push(
      `fade=t=in:st=${f3(S)}:d=${f3(F)}:alpha=1`,
      `fade=t=out:st=${f3(E - F)}:d=${f3(F)}:alpha=1`,
    );
  let x = String(op.x);
  let y = String(op.y);
  if (m?.grow) {
    x = `${op.x}-(overlay_w-${op.w})/2`;
    y = `${op.y}-(overlay_h-${op.h})/2`;
  }
  if (m?.dx) x = `${op.x}+${m.dx}*(1-(${easeIn(S, m.ms)}))`;
  if (m?.dy) y = `${op.y}+${m.dy}*(1-(${easeIn(S, m.ms)}))`;
  return [
    `${imgLabel}${chain.join(",")}[${tag}]`,
    `[${main}][${tag}]overlay=x='${x}':y='${y}':eval=frame:eof_action=pass:enable='between(t,${f3(S)},${f3(E)})':format=auto[${next}]`,
  ];
}

/** Redact: pixelate-and-smooth the region (irreversible), no fade. */
export function blurFilters(
  b: BlurOp,
  main: string,
  next: string,
  offsetMs: number,
  tag: string,
): string[] {
  const S = (b.startMs - offsetMs) / 1000;
  const E = (b.endMs - offsetMs) / 1000;
  // Blocks of ≥ 16 source px (≈ a glyph at dpr 2) or a third of the short side, then a
  // Gaussian on top: irreversible, unlike a plain pixelation (depixelization attacks).
  const B = Math.max(16, Math.round(Math.min(b.box.w, b.box.h) / 3));
  const sw = Math.max(1, Math.round(b.box.w / B));
  const sh = Math.max(1, Math.round(b.box.h / B));
  return [
    `[${main}]split[${tag}a][${tag}b]`,
    `[${tag}b]crop=${b.box.w}:${b.box.h}:${b.box.x}:${b.box.y},scale=${sw}:${sh}:flags=area,scale=${b.box.w}:${b.box.h}:flags=bicubic,gblur=sigma=${(B / 2).toFixed(1)}[${tag}c]`,
    `[${tag}a][${tag}c]overlay=${b.box.x}:${b.box.y}:enable='between(t,${f3(S)},${f3(E)})'[${next}]`,
  ];
}
