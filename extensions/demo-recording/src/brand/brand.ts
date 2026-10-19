/**
 * Brand packages (S5, D24/D25).
 *
 *   <pkg>/brand.json           colors, font, frame, title, logo bug, callout
 *   <pkg>/logo-light.(svg|png) logo for DARK backgrounds (light-colored mark)
 *   <pkg>/logo-dark.(svg|png)  logo for LIGHT backgrounds
 *   <pkg>/backdrop.(png|jpg)   optional backdrop image (else a gradient)
 *   <pkg>/font.(woff2|ttf|otf) optional font file
 *
 * Built-in brands ship in the extension (`brands/`, e.g. `neutral`). User
 * brands live in `<root>/brands/<name>/` — outside the repo, so trademarked
 * assets (e.g. a company logo) never land in the public package.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILTIN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "brands",
);

export const TITLE_LOGO_POSITIONS = [
  "inline",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "none",
] as const;
export type TitleLogoPosition = (typeof TITLE_LOGO_POSITIONS)[number];

export interface Brand {
  name: string;
  displayName: string;
  colors: {
    /** Backdrop gradient from → to (and the title card background). */
    backdrop: string;
    backdropTo: string;
    /** Accent for highlights, callout pills, title rule. */
    accent: string;
    text: string;
    muted: string;
    /** Callout pill background. */
    pill: string;
    pillText: string;
  };
  font: { family: string; weight: number; file?: string };
  frame: {
    mode: "inset" | "fullbleed";
    inset: number;
    radius: number;
    shadow: number;
    /**
     * Rim around the inset footage, outside it (never covers app pixels).
     * width: px at 1080p (scaled with the output), 0 = off. color: hex (alpha
     * allowed) or "auto" = only when the footage edge and the backdrop are
     * too similar, light on dark backdrops, dark on light ones.
     */
    border: { width: number; color: string };
  };
  title: {
    enabled: boolean;
    durationMs: number;
    dissolveMs: number;
    /**
     * Where the logo sits on the title card: "inline" (above the app name,
     * the default), one of the four corners at the card's safe margin, or
     * "none" to leave it off the card.
     */
    logoPosition: TitleLogoPosition;
  };
  logo: { light?: string; dark?: string };
  logoBug: {
    enabled: boolean;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    opacity: number;
    heightPx: number;
  };
  backdropImage?: string;
}

export interface LoadedBrand {
  brand: Brand;
  dir: string;
  builtin: boolean;
  warnings: string[];
}

export const DEFAULT_BRAND: Omit<Brand, "name" | "displayName"> = {
  colors: {
    backdrop: "#14161d",
    backdropTo: "#262a36",
    accent: "#8aa4f8",
    text: "#f2f4f8",
    muted: "#a3a9b8",
    pill: "#14161dE6",
    pillText: "#f2f4f8",
  },
  font: { family: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", weight: 600 },
  frame: {
    mode: "inset",
    inset: 0.92,
    radius: 18,
    shadow: 0.45,
    border: { width: 1.5, color: "auto" },
  },
  title: { enabled: true, durationMs: 2500, dissolveMs: 800, logoPosition: "inline" },
  logo: {},
  logoBug: { enabled: false, position: "bottom-right", opacity: 0.7, heightPx: 34 },
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const BRAND_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function userBrandsDir(root: string): string {
  return path.join(root, "brands");
}

/** Relative luminance (WCAG) of a #rgb/#rrggbb color. */
export function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4]
    .map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return ((x as number) + 0.05) / ((y as number) + 0.05);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate + fill defaults. Throws with a path-precise message on bad values. */
export function parseBrand(
  raw: unknown,
  name: string,
  dir: string,
): { brand: Brand; warnings: string[] } {
  if (!isObj(raw)) throw new Error(`brand ${name}: brand.json must be an object`);
  const warnings: string[] = [];
  const fail = (field: string, msg: string): never => {
    throw new Error(`brand ${name}: ${field} ${msg}`);
  };
  const colors = { ...DEFAULT_BRAND.colors };
  if (raw.colors !== undefined) {
    if (!isObj(raw.colors)) fail("colors", "must be an object");
    for (const [k, v] of Object.entries(raw.colors as Obj)) {
      if (!(k in colors)) {
        warnings.push(`colors.${k} is not used (known: ${Object.keys(colors).join(", ")})`);
        continue;
      }
      if (typeof v !== "string" || !HEX.test(v))
        fail(`colors.${k}`, `must be a hex color like #632CA6 (got ${JSON.stringify(v)})`);
      (colors as Record<string, string>)[k] = v as string;
    }
  }
  const sub = <T extends Obj>(key: string, base: T): T => {
    const v = raw[key];
    if (v === undefined) return { ...base };
    if (!isObj(v)) return fail(key, "must be an object");
    return { ...base, ...v } as T;
  };
  const font = sub("font", DEFAULT_BRAND.font as unknown as Obj) as unknown as Brand["font"];
  if (typeof font.family !== "string" || !font.family.trim())
    fail("font.family", "must be a string");
  if (typeof font.weight !== "number" || font.weight < 100 || font.weight > 900)
    fail("font.weight", "must be 100..900");
  if (font.file && !fs.existsSync(path.join(dir, font.file)))
    fail("font.file", `${font.file} not found in the package`);
  const frame = sub("frame", DEFAULT_BRAND.frame as unknown as Obj) as unknown as Brand["frame"];
  if (frame.mode !== "inset" && frame.mode !== "fullbleed")
    fail("frame.mode", 'must be "inset" or "fullbleed"');
  if (typeof frame.inset !== "number" || frame.inset < 0.7 || frame.inset > 1)
    fail("frame.inset", "must be 0.7..1");
  if (typeof frame.radius !== "number" || frame.radius < 0 || frame.radius > 60)
    fail("frame.radius", "must be 0..60 px");
  if (typeof frame.shadow !== "number" || frame.shadow < 0 || frame.shadow > 1)
    fail("frame.shadow", "must be 0..1");
  const rawBorder = (raw.frame as Obj | undefined)?.border;
  if (rawBorder !== undefined && !isObj(rawBorder))
    fail("frame.border", "must be an object like {width, color}");
  frame.border = {
    ...DEFAULT_BRAND.frame.border,
    ...((rawBorder as Obj | undefined) ?? {}),
  } as Brand["frame"]["border"];
  if (typeof frame.border.width !== "number" || frame.border.width < 0 || frame.border.width > 6)
    fail("frame.border.width", "must be 0..6 px (at 1080p)");
  if (
    typeof frame.border.color !== "string" ||
    (frame.border.color !== "auto" && !HEX.test(frame.border.color))
  )
    fail(
      "frame.border.color",
      `must be "auto" or a hex color like #FFFFFF22 (got ${JSON.stringify(frame.border.color)})`,
    );
  const title = sub("title", DEFAULT_BRAND.title as unknown as Obj) as unknown as Brand["title"];
  if (typeof title.enabled !== "boolean") fail("title.enabled", "must be true/false");
  if (typeof title.durationMs !== "number" || title.durationMs < 1000 || title.durationMs > 8000)
    fail("title.durationMs", "must be 1000..8000");
  if (typeof title.dissolveMs !== "number" || title.dissolveMs < 0 || title.dissolveMs > 3000)
    fail("title.dissolveMs", "must be 0..3000");
  if (!TITLE_LOGO_POSITIONS.includes(title.logoPosition))
    fail("title.logoPosition", `must be ${TITLE_LOGO_POSITIONS.join("|")}`);
  const logo = sub("logo", {}) as Brand["logo"];
  for (const k of ["light", "dark"] as const) {
    const f = logo[k];
    if (f === undefined) continue;
    if (typeof f !== "string" || !/\.(svg|png)$/i.test(f))
      fail(`logo.${k}`, "must be a .svg or .png file name");
    if (!fs.existsSync(path.join(dir, f as string)))
      fail(`logo.${k}`, `${f} not found in the package`);
  }
  if (!logo.light && logo.dark)
    warnings.push(
      "no logo.light (for dark backdrops): the dark logo is used and may be hard to see",
    );
  const logoBug = sub(
    "logoBug",
    DEFAULT_BRAND.logoBug as unknown as Obj,
  ) as unknown as Brand["logoBug"];
  if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(logoBug.position))
    fail("logoBug.position", "must be top-left|top-right|bottom-left|bottom-right");
  if (typeof logoBug.enabled !== "boolean") fail("logoBug.enabled", "must be true/false");
  if (typeof logoBug.opacity !== "number" || logoBug.opacity < 0.1 || logoBug.opacity > 1)
    fail("logoBug.opacity", "must be 0.1..1");
  if (typeof logoBug.heightPx !== "number" || logoBug.heightPx < 12 || logoBug.heightPx > 120)
    fail("logoBug.heightPx", "must be 12..120 px (at 1080p)");
  if (logoBug.enabled && !logo.light && !logo.dark)
    warnings.push("logoBug.enabled but the brand has no logo: no bug is drawn");
  const backdropImage = typeof raw.backdropImage === "string" ? raw.backdropImage : undefined;
  if (backdropImage && !fs.existsSync(path.join(dir, backdropImage)))
    fail("backdropImage", `${backdropImage} not found in the package`);

  // Legibility checks (warnings, not errors).
  if (contrast(colors.text, colors.backdrop) < 4.5)
    warnings.push(
      `text on backdrop has low contrast (${contrast(colors.text, colors.backdrop).toFixed(1)}:1, aim ≥ 4.5)`,
    );
  const pillOpaque = colors.pill.length === 9 ? colors.pill.slice(0, 7) : colors.pill;
  if (contrast(colors.pillText, pillOpaque) < 4.5)
    warnings.push(
      `callout text on pill has low contrast (${contrast(colors.pillText, pillOpaque).toFixed(1)}:1)`,
    );
  if (contrast(colors.accent, colors.backdrop) < 2)
    warnings.push("accent barely differs from the backdrop: highlights will be hard to see");

  const brand: Brand = {
    name,
    displayName:
      typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : name,
    colors,
    font,
    frame,
    title,
    logo,
    logoBug,
    ...(backdropImage ? { backdropImage } : {}),
  };
  return { brand, warnings };
}

export function loadBrandDir(dir: string, builtin: boolean): LoadedBrand {
  const name = path.basename(dir);
  const file = path.join(dir, "brand.json");
  if (!fs.existsSync(file)) throw new Error(`brand ${name}: brand.json missing in ${dir}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`brand ${name}: brand.json is not valid JSON (${(err as Error).message})`);
  }
  const { brand, warnings } = parseBrand(raw, name, dir);
  return { brand, dir, builtin, warnings };
}

export interface BrandEntry {
  name: string;
  dir: string;
  builtin: boolean;
  error?: string;
}

/** Built-ins + user brands (a user brand with the same name overrides a built-in). */
export function listBrands(root: string): BrandEntry[] {
  const out = new Map<string, BrandEntry>();
  for (const [base, builtin] of [
    [BUILTIN_DIR, true],
    [userBrandsDir(root), false],
  ] as const) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory() || !fs.existsSync(path.join(base, d.name, "brand.json"))) continue;
      const dir = path.join(base, d.name);
      let error: string | undefined;
      try {
        loadBrandDir(dir, builtin);
      } catch (err) {
        error = (err as Error).message;
      }
      out.set(d.name, { name: d.name, dir, builtin, ...(error ? { error } : {}) });
    }
  }
  return [...out.values()].sort(
    (a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name),
  );
}

/**
 * The brand a render uses when nobody picked one: the configured brand when it exists (a built-in or in `<root>/brands/`), else the built-in
 * `neutral`, and which brand was wanted. A brand someone CHOSE is never replaced (see `resolveBrand`, which fails clearly): choosing is not
 * guessing. A new working folder has no `brands/`, while the global config can still name a brand of the old one (run 2, R2-8).
 */
export function effectiveBrand(
  root: string,
  wanted: string,
): { name: string; fellBackFrom?: string } {
  if (listBrands(root).some((b) => b.name === wanted)) return { name: wanted };
  return { name: "neutral", fellBackFrom: wanted };
}

export function resolveBrand(root: string, name: string): LoadedBrand {
  const entry = listBrands(root).find((b) => b.name === name);
  if (!entry) {
    const names = listBrands(root).map((b) => b.name);
    throw new Error(`unknown brand "${name}" (available: ${names.join(", ")})`);
  }
  return loadBrandDir(entry.dir, entry.builtin);
}
