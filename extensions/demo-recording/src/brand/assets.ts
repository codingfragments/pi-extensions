/**
 * Render a brand's visual layers to PNGs (S5, D25) with the same Playwright
 * used for recording — HTML/CSS templates, no new dependencies:
 *
 *   backdrop.png  W×H   gradient/image + soft shadow plate behind the inset
 *   mask.png      w×h   white rounded rect on black (alpha for the footage)
 *   title.png     W×H   title card (app, demo title, date, logo)
 *   logo-bug.png  …     small logo for a corner of the full video
 *
 * Cached by a content hash of brand.json + assets + inputs.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Brand, LoadedBrand } from "./brand.ts";

export interface InsetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TitleInfo {
  app: string;
  title: string;
  date: string;
}

export interface BrandAssets {
  brand: Brand;
  size: { width: number; height: number };
  /** Where the footage goes (full frame for fullbleed). */
  inset: InsetBox;
  backdrop?: string;
  mask?: string;
  title?: string;
  logoBug?: { file: string; x: number; y: number; w: number; h: number; opacity: number };
}

/**
 * Effective logo-bug height. The light logo is made for the backdrop, so in
 * inset mode the bug stays in the margin and shrinks to fit it (down to 20 px);
 * only full-bleed (or a hair-thin margin) puts it over the footage.
 */
export function logoBugHeight(
  brand: Brand,
  box: InsetBox,
  size: { width: number; height: number },
): number {
  const want = brand.logoBug.heightPx;
  if (brand.frame.mode !== "inset") return want;
  const top = brand.logoBug.position.startsWith("top");
  const margin = top ? box.y : size.height - box.y - box.h;
  const fit = margin - 12;
  return fit >= 20 ? Math.min(want, fit) : want;
}

/**
 * Logo bug placement, never straddling the footage edge: centered in the
 * margin around the inset footage (aligned with its edge) when the margin is
 * tall enough, else inside the footage corner with padding.
 */
export function logoBugPosition(
  pos: Brand["logoBug"]["position"],
  bug: { w: number; h: number },
  box: InsetBox,
  size: { width: number; height: number },
): { x: number; y: number } {
  const top = pos.startsWith("top");
  const left = pos.endsWith("left");
  const margin = top ? box.y : size.height - box.y - box.h;
  if (margin >= bug.h + 12) {
    const x = left ? box.x : box.x + box.w - bug.w;
    const y = top
      ? Math.round((margin - bug.h) / 2)
      : Math.round(box.y + box.h + (margin - bug.h) / 2);
    return { x, y };
  }
  const pad = Math.round(size.width * 0.018);
  return {
    x: left ? box.x + pad : box.x + box.w - bug.w - pad,
    y: top ? box.y + pad : box.y + box.h - bug.h - pad,
  };
}

/** Footage box: inset% of the width, 16:9 kept, centered; even pixel sizes for yuv420p. */
export function insetBox(brand: Brand, size: { width: number; height: number }): InsetBox {
  if (brand.frame.mode === "fullbleed") return { x: 0, y: 0, w: size.width, h: size.height };
  const even = (n: number) => Math.round(n / 2) * 2;
  const w = even(size.width * brand.frame.inset);
  const h = even((w * size.height) / size.width);
  return { x: even((size.width - w) / 2), y: even((size.height - h) / 2), w, h };
}

function dataUri(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".svg"
      ? "image/svg+xml"
      : ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".woff2"
            ? "font/woff2"
            : ext === ".ttf"
              ? "font/ttf"
              : "font/otf";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

function fontCss(l: LoadedBrand): string {
  const f = l.brand.font;
  const face = f.file
    ? `@font-face { font-family: "BrandFont"; src: url("${dataUri(path.join(l.dir, f.file))}"); font-weight: 100 900; }`
    : "";
  return `${face} body { margin: 0; font-family: ${f.file ? '"BrandFont", ' : ""}${f.family}; }`;
}

function backgroundCss(l: LoadedBrand): string {
  const c = l.brand.colors;
  if (l.brand.backdropImage)
    return `background: url("${dataUri(path.join(l.dir, l.brand.backdropImage))}") center/cover no-repeat, ${c.backdrop};`;
  return `background: radial-gradient(120% 140% at 15% 10%, ${c.backdropTo} 0%, ${c.backdrop} 60%), ${c.backdrop};`;
}

/** Logo for a dark (default) or light background. */
function logoFor(l: LoadedBrand, onDark = true): string | undefined {
  const f = onDark
    ? (l.brand.logo.light ?? l.brand.logo.dark)
    : (l.brand.logo.dark ?? l.brand.logo.light);
  return f ? path.join(l.dir, f) : undefined;
}

export function backdropHtml(
  l: LoadedBrand,
  size: { width: number; height: number },
  box: InsetBox,
): string {
  const b = l.brand;
  const shadow = b.frame.shadow;
  return `<!doctype html><html><head><style>${fontCss(l)}
html,body{width:${size.width}px;height:${size.height}px;overflow:hidden}
body{${backgroundCss(l)}}
.plate{position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;border-radius:${b.frame.radius}px;
background:${b.colors.backdrop};box-shadow:0 ${Math.round(28 * shadow)}px ${Math.round(80 * shadow)}px rgba(0,0,0,${(0.55 * shadow).toFixed(2)}),0 2px 6px rgba(0,0,0,${(0.35 * shadow).toFixed(2)});}
</style></head><body><div class="plate"></div></body></html>`;
}

export function maskHtml(l: LoadedBrand, box: InsetBox): string {
  return `<!doctype html><html><head><style>html,body{margin:0;width:${box.w}px;height:${box.h}px;background:#000;overflow:hidden}
div{width:100%;height:100%;background:#fff;border-radius:${l.brand.frame.radius}px}</style></head><body><div></div></body></html>`;
}

/** CSS for the title-card logo: inline above the app name, or pinned to a corner. */
export function titleLogoCss(pos: Brand["title"]["logoPosition"], s: number): string {
  const h = `height:${Math.round(64 * s)}px;display:block`;
  if (pos === "inline") return `${h};margin-bottom:${Math.round(56 * s)}px`;
  const x = Math.round(150 * s);
  const y = Math.round(96 * s);
  const horiz = pos.endsWith("left") ? `left:${x}px` : `right:${x}px`;
  const vert = pos.startsWith("top") ? `top:${y}px` : `bottom:${y}px`;
  return `position:absolute;${horiz};${vert};${h}`;
}

export function titleHtml(
  l: LoadedBrand,
  size: { width: number; height: number },
  info: TitleInfo,
): string {
  const b = l.brand;
  const logo = logoFor(l, true);
  const s = size.width / 1920;
  return `<!doctype html><html><head><style>${fontCss(l)}
html,body{width:${size.width}px;height:${size.height}px;overflow:hidden}
body{${backgroundCss(l)};color:${b.colors.text};display:flex;align-items:center}
.wrap{margin-left:${Math.round(150 * s)}px;max-width:${Math.round(1300 * s)}px}
.logo{${titleLogoCss(b.title.logoPosition, s)}}
.app{font-size:${Math.round(30 * s)}px;letter-spacing:.08em;text-transform:uppercase;color:${b.colors.muted};font-weight:${b.font.weight}}
.rule{width:${Math.round(84 * s)}px;height:${Math.max(3, Math.round(5 * s))}px;background:${b.colors.accent};border-radius:3px;margin:${Math.round(26 * s)}px 0 ${Math.round(30 * s)}px}
.title{font-size:${Math.round(76 * s)}px;line-height:1.08;font-weight:${Math.max(600, b.font.weight)};letter-spacing:-.01em}
.date{margin-top:${Math.round(40 * s)}px;font-size:${Math.round(26 * s)}px;color:${b.colors.muted}}
</style></head><body><div class="wrap">
${logo && b.title.logoPosition !== "none" ? `<img class="logo" src="${dataUri(logo)}">` : ""}
${info.app ? `<div class="app">${esc(info.app)}</div>` : ""}<div class="rule"></div>
<div class="title">${esc(info.title)}</div>
<div class="date">${esc(info.date)}</div></div></body></html>`;
}

export function logoBugHtml(l: LoadedBrand, heightPx: number): string | undefined {
  const logo = logoFor(l, true);
  if (!logo) return undefined;
  return `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{height:${heightPx}px;display:block}</style></head>
<body><img src="${dataUri(logo)}"></body></html>`;
}

function hashOf(l: LoadedBrand, parts: unknown): string {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify(l.brand));
  for (const f of fs.readdirSync(l.dir).sort()) {
    const p = path.join(l.dir, f);
    if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p));
  }
  // Layout changes in the HTML templates must invalidate cached PNGs too.
  h.update(titleHtml.toString()).update(titleLogoCss.toString()).update(logoBugHtml.toString());
  h.update(JSON.stringify(parts));
  return h.digest("hex").slice(0, 20);
}

export async function renderBrandAssets(
  l: LoadedBrand,
  size: { width: number; height: number },
  opts: { cacheDir: string; title?: TitleInfo; withTitle?: boolean; withLogoBug?: boolean },
): Promise<BrandAssets> {
  const box = insetBox(l.brand, size);
  const wantTitle = (opts.withTitle ?? true) && l.brand.title.enabled && !!opts.title;
  const wantBug = (opts.withLogoBug ?? l.brand.logoBug.enabled) && !!logoFor(l, true);
  const bugHeight = logoBugHeight(l.brand, box, size);
  const dir = path.join(
    opts.cacheDir,
    hashOf(l, { size, title: wantTitle ? opts.title : null, wantBug, bugHeight }),
  );
  const out: BrandAssets = { brand: l.brand, size, inset: box };
  const files = {
    backdrop: path.join(dir, "backdrop.png"),
    mask: path.join(dir, "mask.png"),
    title: path.join(dir, "title.png"),
    bug: path.join(dir, "logo-bug.png"),
    bugMeta: path.join(dir, "logo-bug.json"),
  };
  const inset = l.brand.frame.mode === "inset";
  const need =
    (inset && (!fs.existsSync(files.backdrop) || !fs.existsSync(files.mask))) ||
    (wantTitle && !fs.existsSync(files.title)) ||
    (wantBug && !fs.existsSync(files.bugMeta));
  if (need) {
    fs.mkdirSync(dir, { recursive: true });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const shot = async (
        html: string,
        w: number,
        h: number,
        file: string,
        transparent = false,
      ) => {
        const page = await browser.newPage({
          viewport: { width: w, height: h },
          deviceScaleFactor: 1,
        });
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate("document.fonts && document.fonts.ready");
        await page.screenshot({ path: file, omitBackground: transparent, type: "png" });
        await page.close();
      };
      if (inset) {
        await shot(backdropHtml(l, size, box), size.width, size.height, files.backdrop);
        await shot(maskHtml(l, box), box.w, box.h, files.mask);
      }
      if (wantTitle && opts.title)
        await shot(titleHtml(l, size, opts.title), size.width, size.height, files.title);
      if (wantBug) {
        const html = logoBugHtml(l, bugHeight) as string;
        const page = await browser.newPage({
          viewport: { width: 800, height: 200 },
          deviceScaleFactor: 1,
        });
        await page.setContent(html, { waitUntil: "load" });
        const bb = await page.locator("img").boundingBox();
        const w = Math.max(2, Math.round(bb?.width ?? 100));
        const h = Math.max(2, Math.round(bb?.height ?? l.brand.logoBug.heightPx));
        await page.locator("img").screenshot({ path: files.bug, omitBackground: true });
        await page.close();
        fs.writeFileSync(files.bugMeta, JSON.stringify({ w, h }));
      }
    } finally {
      await browser.close();
    }
  }
  if (inset) {
    out.backdrop = files.backdrop;
    out.mask = files.mask;
  }
  if (wantTitle) out.title = files.title;
  if (wantBug && fs.existsSync(files.bugMeta)) {
    const { w, h } = JSON.parse(fs.readFileSync(files.bugMeta, "utf8")) as { w: number; h: number };
    out.logoBug = {
      file: files.bug,
      ...logoBugPosition(l.brand.logoBug.position, { w, h }, box, size),
      w,
      h,
      opacity: l.brand.logoBug.opacity,
    };
  }
  return out;
}
