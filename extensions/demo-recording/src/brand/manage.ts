/**
 * Brand management (S5, D24): inspect a zip/folder of brand material, create
 * a user brand package from a chosen mapping, update (Brand tab tweaks),
 * duplicate, and render previews. User brands live in <root>/brands/<name>/.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lineDiff } from "../config-edit.ts";
import { type BrandAssets, type TitleInfo, insetBox, renderBrandAssets } from "./assets.ts";
import {
  BRAND_NAME,
  type LoadedBrand,
  loadBrandDir,
  parseBrand,
  resolveBrand,
  userBrandsDir,
} from "./brand.ts";

export interface InventoryFile {
  rel: string;
  kind: "logo-candidate" | "image" | "font" | "colors-source" | "other";
  bytes: number;
  /** Image size, when known. */
  size?: { w: number; h: number };
  /** Mean luminance 0..1 of non-transparent pixels (light marks → for dark backgrounds). */
  luminance?: number;
}

export interface Inventory {
  root: string;
  files: InventoryFile[];
  /** Hex colors found in css/svg/json/txt sources, most frequent first. */
  colors: { hex: string; count: number }[];
  /** Absolute paths of rendered PNG previews of logo candidates (for the model to look at). */
  previews: { rel: string; png: string }[];
}

const IMG = /\.(svg|png|jpe?g|webp)$/i;
const FONT = /\.(woff2?|ttf|otf)$/i;
const COLOR_SRC = /\.(css|scss|json|svg|txt|md|ase|xml|html)$/i;

/** Unzip (if needed) into a temp dir; returns the folder to read. */
export function materializeSource(source: string): string {
  const abs = path.resolve(source.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(abs)) throw new Error(`brand source not found: ${abs}`);
  if (fs.statSync(abs).isDirectory()) return abs;
  if (!/\.zip$/i.test(abs)) throw new Error("brand source must be a folder or a .zip file");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-brand-"));
  execFileSync("unzip", ["-q", "-o", abs, "-d", dir]);
  return dir;
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

export function extractColors(texts: string[]): { hex: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const m of t.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      let hex = m[0].toLowerCase();
      if (hex.length === 4) hex = `#${[...hex.slice(1)].map((c) => c + c).join("")}`;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 24);
}

/** Inventory of brand material, with logo candidates rendered for a visual check. */
export async function inspectSource(source: string, previewDir: string): Promise<Inventory> {
  const root = materializeSource(source);
  const rels = walk(root).slice(0, 400);
  const texts: string[] = [];
  const files: InventoryFile[] = rels.map((rel) => {
    const abs = path.join(root, rel);
    const bytes = fs.statSync(abs).size;
    if (COLOR_SRC.test(rel) && bytes < 2_000_000) texts.push(fs.readFileSync(abs, "utf8"));
    const isLogo = /logo|mark|wordmark|icon|symbol|brand/i.test(rel) && /\.(svg|png)$/i.test(rel);
    const kind: InventoryFile["kind"] = isLogo
      ? "logo-candidate"
      : IMG.test(rel)
        ? "image"
        : FONT.test(rel)
          ? "font"
          : COLOR_SRC.test(rel)
            ? "colors-source"
            : "other";
    return { rel, kind, bytes };
  });
  // Render logo candidates (svg/png) on a checkerboard and measure size + luminance.
  const candidates = files
    .filter(
      (f) => f.kind === "logo-candidate" || (f.kind === "image" && /\.(svg|png)$/i.test(f.rel)),
    )
    .slice(0, 8);
  const previews: Inventory["previews"] = [];
  if (candidates.length) {
    fs.mkdirSync(previewDir, { recursive: true });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      for (const [i, f] of candidates.entries()) {
        const abs = path.join(root, f.rel);
        const mime = f.rel.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
        const page = await browser.newPage({ viewport: { width: 640, height: 260 } });
        await page.setContent(
          `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;width:640px;height:260px;
          background:repeating-conic-gradient(#888 0 25%,#bbb 0 50%) 0 0/24px 24px">
          <img id="i" style="max-width:560px;max-height:200px" src="data:${mime};base64,${fs.readFileSync(abs).toString("base64")}"></body></html>`,
          { waitUntil: "load" },
        );
        const stats = (await page.evaluate(`(() => {
          const img = document.getElementById("i");
          const c = document.createElement("canvas"); c.width = img.naturalWidth || 200; c.height = img.naturalHeight || 80;
          const g = c.getContext("2d"); g.drawImage(img, 0, 0, c.width, c.height);
          const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0, n = 0;
          for (let k = 0; k < d.length; k += 16) { if (d[k + 3] > 64) { sum += (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255; n++; } }
          return { w: img.naturalWidth, h: img.naturalHeight, lum: n ? sum / n : null };
        })()`)) as { w: number; h: number; lum: number | null };
        if (stats.w) f.size = { w: stats.w, h: stats.h };
        if (stats.lum !== null) f.luminance = +stats.lum.toFixed(2);
        const png = path.join(previewDir, `candidate-${i + 1}.png`);
        await page.screenshot({ path: png });
        previews.push({ rel: f.rel, png });
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  return { root, files, colors: extractColors(texts), previews };
}

export function formatInventory(inv: Inventory): string {
  const lines = [`source: ${inv.root}`, "files:"];
  for (const f of inv.files.slice(0, 80)) {
    lines.push(
      `  ${f.kind.padEnd(15)} ${f.rel}${f.size ? `  ${f.size.w}×${f.size.h}` : ""}${f.luminance !== undefined ? `  luminance ${f.luminance} (${f.luminance > 0.6 ? "light mark → logo.light, for dark backdrops" : f.luminance < 0.35 ? "dark mark → logo.dark" : "mid"})` : ""}`,
    );
  }
  if (inv.files.length > 80) lines.push(`  … ${inv.files.length - 80} more`);
  lines.push(
    `colors found (most used first): ${inv.colors.map((c) => `${c.hex}×${c.count}`).join(", ") || "none"}`,
  );
  return lines.join("\n");
}

export interface CreateBrandInput {
  name: string;
  source?: string;
  displayName?: string;
  /** Paths relative to the source root. */
  logoLight?: string;
  logoDark?: string;
  font?: string;
  backdropImage?: string;
  /** brand.json fields (colors, font.family/weight, frame, title, logoBug). */
  settings?: Record<string, unknown>;
  overwrite?: boolean;
}

/** Create a user brand package; validates before writing anything. */
export function createBrand(root: string, input: CreateBrandInput): LoadedBrand {
  if (!BRAND_NAME.test(input.name))
    throw new Error(`brand name "${input.name}" must be lowercase letters, digits and dashes`);
  const dir = path.join(userBrandsDir(root), input.name);
  if (fs.existsSync(dir) && !input.overwrite)
    throw new Error(
      `brand "${input.name}" already exists — pass overwrite to replace it, or use update`,
    );
  const src = input.source ? materializeSource(input.source) : undefined;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `demo-rec-brand-${input.name}-`));
  const copy = (rel: string | undefined, as: string): string | undefined => {
    if (!rel) return undefined;
    if (!src) throw new Error("a source folder/zip is needed to copy brand files");
    const from = path.resolve(src, rel);
    if (!from.startsWith(src + path.sep) || !fs.existsSync(from))
      throw new Error(`file not found in the source: ${rel}`);
    const name = `${as}${path.extname(from).toLowerCase()}`;
    fs.copyFileSync(from, path.join(staging, name));
    return name;
  };
  const logoLight = copy(input.logoLight, "logo-light");
  const logoDark = copy(input.logoDark, "logo-dark");
  const fontFile = copy(input.font, "font");
  const backdrop = copy(input.backdropImage, "backdrop");
  const settings = (input.settings ?? {}) as Record<string, unknown>;
  const json: Record<string, unknown> = {
    ...settings,
    displayName: input.displayName ?? settings.displayName ?? input.name,
    ...(logoLight || logoDark
      ? {
          logo: {
            ...(logoLight ? { light: logoLight } : {}),
            ...(logoDark ? { dark: logoDark } : {}),
          },
        }
      : {}),
    ...(backdrop ? { backdropImage: backdrop } : {}),
  };
  if (fontFile)
    json.font = {
      ...((settings.font as Record<string, unknown>) ?? {}),
      file: fontFile,
      family:
        (settings.font as { family?: string } | undefined)?.family ??
        "BrandFont, system-ui, sans-serif",
    };
  fs.writeFileSync(path.join(staging, "brand.json"), `${JSON.stringify(json, null, 2)}\n`);
  parseBrand(json, input.name, staging); // throws on invalid values — nothing written yet
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(staging, dir, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  return loadBrandDir(dir, false);
}

/** Deep merge for brand.json patches (objects merge, everything else replaces). */
export function mergePatch(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = a[k];
    out[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
        ? mergePatch(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** The brand with a patch applied in memory (for live previews; nothing is written). */
export function patchedBrand(
  root: string,
  name: string,
  patch: Record<string, unknown>,
): LoadedBrand {
  const loaded = resolveBrand(root, name);
  const current = JSON.parse(
    fs.readFileSync(path.join(loaded.dir, "brand.json"), "utf8"),
  ) as Record<string, unknown>;
  const { brand, warnings } = parseBrand(mergePatch(current, patch), name, loaded.dir);
  return { ...loaded, brand, warnings };
}

export interface BrandUpdatePlan {
  name: string;
  file: string;
  before: string;
  after: string;
  diff: string;
  warnings: string[];
}

/** Validated update plan for a user brand: the brand.json diff, not written yet. */
export function planBrandUpdate(
  root: string,
  name: string,
  patch: Record<string, unknown>,
): BrandUpdatePlan {
  const loaded = resolveBrand(root, name);
  if (loaded.builtin)
    throw new Error(
      `"${name}" is built in — duplicate it first (e.g. ${name}-custom) and edit the copy`,
    );
  const file = path.join(loaded.dir, "brand.json");
  const before = fs.readFileSync(file, "utf8");
  const next = mergePatch(JSON.parse(before) as Record<string, unknown>, patch);
  const { warnings } = parseBrand(next, name, loaded.dir);
  const after = `${JSON.stringify(next, null, 2)}\n`;
  return { name, file, before, after, diff: lineDiff(before, after), warnings };
}

/** Deep-merge a patch into a user brand's brand.json (validated first). */
export function updateBrand(
  root: string,
  name: string,
  patch: Record<string, unknown>,
): LoadedBrand {
  const plan = planBrandUpdate(root, name, patch);
  fs.writeFileSync(plan.file, plan.after);
  return loadBrandDir(path.dirname(plan.file), false);
}

export function duplicateBrand(root: string, from: string, to: string): LoadedBrand {
  if (!BRAND_NAME.test(to))
    throw new Error(`brand name "${to}" must be lowercase letters, digits and dashes`);
  const src = resolveBrand(root, from);
  const dir = path.join(userBrandsDir(root), to);
  if (fs.existsSync(dir)) throw new Error(`brand "${to}" already exists`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(src.dir, dir, { recursive: true });
  const json = JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")) as Record<
    string,
    unknown
  >;
  json.displayName = `${src.brand.displayName} (copy)`;
  fs.writeFileSync(path.join(dir, "brand.json"), `${JSON.stringify(json, null, 2)}\n`);
  return loadBrandDir(dir, false);
}

export interface BrandPreview {
  title?: string;
  framed: string;
}

/**
 * Preview: the title card + a framed sample frame (backdrop, inset keyframe,
 * a sample callout pill, the logo bug). `keyframe` = a real frame from a take
 * if available; else a neutral placeholder.
 */
export async function renderBrandPreview(
  loaded: LoadedBrand,
  opts: {
    cacheDir: string;
    outDir: string;
    size: { width: number; height: number };
    title: TitleInfo;
    keyframe?: string;
  },
): Promise<BrandPreview> {
  const assets: BrandAssets = await renderBrandAssets(loaded, opts.size, {
    cacheDir: opts.cacheDir,
    title: opts.title,
    withLogoBug: true,
  });
  const box = insetBox(loaded.brand, opts.size);
  const c = loaded.brand.colors;
  const uri = (f: string) =>
    `data:image/${f.endsWith(".png") ? "png" : "jpeg"};base64,${fs.readFileSync(f).toString("base64")}`;
  const frame = opts.keyframe
    ? `<img src="${uri(opts.keyframe)}" style="width:100%;height:100%;object-fit:cover;display:block">`
    : `<div style="width:100%;height:100%;background:#f4f5f8;display:flex"><div style="width:15%;background:#1d2233"></div><div style="flex:1;padding:4%"><div style="height:7%;width:38%;background:#cfd3de;border-radius:6px;margin-bottom:4%"></div><div style="display:flex;gap:3%">${'<div style="flex:1;height:120px;background:#fff;border:1px solid #e3e6ee;border-radius:10px"></div>'.repeat(3)}</div></div></div>`;
  const html = `<!doctype html><html><head><style>body{margin:0;width:${opts.size.width}px;height:${opts.size.height}px;overflow:hidden;font-family:${loaded.brand.font.family}}</style></head><body>
<div style="position:absolute;inset:0;${assets.backdrop ? `background:url('${uri(assets.backdrop)}') 0 0/100% 100%` : `background:${c.backdrop}`}"></div>
<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;border-radius:${loaded.brand.frame.mode === "inset" ? loaded.brand.frame.radius : 0}px;overflow:hidden">${frame}</div>
<div style="position:absolute;left:${box.x + 32}px;top:${box.y + box.h - 86}px;padding:12px 22px;border-radius:999px;background:${c.pill};color:${c.pillText};font-size:26px;font-weight:${loaded.brand.font.weight};box-shadow:0 4px 18px rgba(0,0,0,.25)">Regional breakdown</div>
${assets.logoBug ? `<img src="${uri(assets.logoBug.file)}" style="position:absolute;left:${assets.logoBug.x}px;top:${assets.logoBug.y}px;opacity:${assets.logoBug.opacity}">` : ""}
</body></html>`;
  fs.mkdirSync(opts.outDir, { recursive: true });
  const framed = path.join(opts.outDir, `${loaded.brand.name}-framed.png`);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: opts.size });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: framed });
  } finally {
    await browser.close();
  }
  let title: string | undefined;
  if (assets.title) {
    title = path.join(opts.outDir, `${loaded.brand.name}-title.png`);
    fs.copyFileSync(assets.title, title);
  }
  return { ...(title ? { title } : {}), framed };
}
