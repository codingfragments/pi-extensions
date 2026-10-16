/**
 * The UX migration ratchet (D114). Counts what is left of the legacy styling in the panel and
 * compares it with the committed baseline (test/fixtures/ux-ratchet.json). A count may never go
 * up; when it goes down, the baseline is lowered to lock the improvement in.
 *
 *   node extensions/demo-recording/scripts/ux-ratchet.ts            # print the counts and the baseline
 *   node extensions/demo-recording/scripts/ux-ratchet.ts --update   # write the current counts as the baseline
 *
 * What is counted (ds/screens.css and the panel scripts; the rest of ds/ is the design system and is not counted):
 *   colourLiterals        hard-coded colours (hex, rgb(), hsl()) outside the tokens
 *   fontSizeLiterals      font-size declarations that are not a token
 *   radiusLiterals        border-radius declarations that are not a token (0 and 50% excepted)
 *   spacingLiterals       gap / padding / margin declarations with a non-zero literal and no token
 *   legacyVarUses         uses of the legacy variable names (--bg, --card, --line, --muted, …)
 *   legacyButtonClasses   distinct class names that style a button-like control (st, ghost, chip, …)
 *   inlineStyleLiterals   style="…" attributes in the scripts with a literal size or colour
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const PUBLIC = path.join(ROOT, "src", "panel", "public");
export const BASELINE_FILE = path.join(ROOT, "test", "fixtures", "ux-ratchet.json");

export interface Counts {
  colourLiterals: number;
  fontSizeLiterals: number;
  radiusLiterals: number;
  spacingLiterals: number;
  legacyVarUses: number;
  legacyButtonClasses: number;
  inlineStyleLiterals: number;
}

const LEGACY_VARS = [
  "bg",
  "card",
  "inset",
  "line",
  "chip",
  "border",
  "text",
  "muted",
  "mauve",
  "ok",
  "warn",
  "err",
  "on-accent",
  "mono",
];
const BUTTONISH = new Set([
  "st",
  "ghost",
  "chip",
  "tiny",
  "primary",
  "config-btn",
  "theme-toggle",
  "segmented",
  "pill",
  "engine",
  "tab",
  "icon-btn",
]);

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const hasLiteralLength = (v: string) => /(^|[\s(,])-?\d*\.?\d+(px|em|rem|%)\b/.test(v);
const nonZero = (v: string) =>
  /(^|[\s(,])-?(0*\.?0*[1-9]\d*\.?\d*|\d*\.\d*[1-9]\d*)(px|em|rem)\b/.test(v);

export function countCss(css: string): Omit<Counts, "inlineStyleLiterals" | "legacyButtonClasses"> {
  const src = stripComments(css);
  let fontSizeLiterals = 0;
  let radiusLiterals = 0;
  let spacingLiterals = 0;
  for (const m of src.matchAll(
    /(?:^|[;{\s])(font-size|border-radius|gap|row-gap|column-gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?)\s*:\s*([^;{}]+)/g,
  )) {
    const prop = m[1] as string;
    const value = (m[2] as string).trim();
    if (value.includes("var(--")) continue;
    if (prop === "font-size" && hasLiteralLength(value)) fontSizeLiterals++;
    else if (prop === "border-radius" && /\d/.test(value) && !/^(0|0px|50%|100%)$/.test(value))
      radiusLiterals++;
    else if (prop !== "font-size" && prop !== "border-radius" && nonZero(value)) spacingLiterals++;
  }
  const colourLiterals = (src.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []).length;
  const legacyVarUses = (
    src.match(new RegExp(`var\\(--(${LEGACY_VARS.join("|")})(?![\\w-])`, "g")) ?? []
  ).length;
  return { colourLiterals, fontSizeLiterals, radiusLiterals, spacingLiterals, legacyVarUses };
}

export function buttonClasses(css: string): Set<string> {
  const found = new Set<string>();
  for (const m of stripComments(css).matchAll(/([^{}]+)\{/g)) {
    for (const sel of (m[1] as string).split(",")) {
      for (const c of sel.matchAll(/\.([a-z][a-z0-9-]*)/gi)) {
        const name = c[1] as string;
        if (BUTTONISH.has(name) && !name.startsWith("ds-")) found.add(name);
      }
    }
  }
  return found;
}

export function countScripts(files: string[]): {
  legacyVarUses: number;
  colourLiterals: number;
  inlineStyleLiterals: number;
} {
  let legacyVarUses = 0;
  let colourLiterals = 0;
  let inlineStyleLiterals = 0;
  for (const f of files) {
    // a line may say why a literal is data and not styling (`ratchet-ok: …`), e.g. a colour input's default
    const src = fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !l.includes("ratchet-ok"))
      .join("\n");
    legacyVarUses += (
      src.match(new RegExp(`var\\(--(${LEGACY_VARS.join("|")})(?![\\w-])`, "g")) ?? []
    ).length;
    colourLiterals += (src.match(/["'`]#[0-9a-fA-F]{3,8}["'`]|["'`](rgba?|hsla?)\(/g) ?? []).length;
    for (const m of src.matchAll(/style=\$?\{?[`"']([^`"']*)[`"']/g)) {
      const v = m[1] as string;
      if (
        /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(v) ||
        (/\d(px|em|rem)\b/.test(v) && !v.includes("var(--"))
      )
        inlineStyleLiterals++;
    }
  }
  return { legacyVarUses, colourLiterals, inlineStyleLiterals };
}

export function measure(): Counts {
  const css = fs.readFileSync(path.join(PUBLIC, "ds", "screens.css"), "utf8");
  const scripts = fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(PUBLIC, f));
  const c = countCss(css);
  const s = countScripts(scripts);
  return {
    colourLiterals: c.colourLiterals + s.colourLiterals,
    fontSizeLiterals: c.fontSizeLiterals,
    radiusLiterals: c.radiusLiterals,
    spacingLiterals: c.spacingLiterals,
    legacyVarUses: c.legacyVarUses + s.legacyVarUses,
    legacyButtonClasses: buttonClasses(css).size,
    inlineStyleLiterals: s.inlineStyleLiterals,
  };
}

export function readBaseline(): Counts | undefined {
  return fs.existsSync(BASELINE_FILE)
    ? (JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) as Counts)
    : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = measure();
  const base = readBaseline();
  if (process.argv.includes("--update")) {
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(now, null, 2)}\n`);
    console.log("baseline written:", BASELINE_FILE);
  }
  for (const k of Object.keys(now) as (keyof Counts)[])
    console.log(
      `${k.padEnd(22)} ${String(now[k]).padStart(5)}${base ? `   baseline ${String(base[k]).padStart(5)}` : ""}`,
    );
}
