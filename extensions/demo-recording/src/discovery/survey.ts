/**
 * The survey: the engine visits the app's navigation by itself, without a model in the loop, and hands the Director one overview (a contact sheet and a line per page)
 * to choose from. Measured on a real app: 2.2 s a page, about 90 s for 40 pages one after the other, against about 6 s a step with the model deciding every one of them.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { ffmpeg, hasBinary } from "../media/ffmpeg.ts";

/** Pages not to visit by themselves, whatever the safety net would say about a plain goto. */
const AVOID =
  /(log[-_]?out|sign[-_]?out|delete|remove|destroy|disconnect|unsubscribe|revoke|deactivate|cancel|reset|invite|billing|checkout|download|export)/i;
const FILE = /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|mov|dmg|exe|tar|gz)(\?|$)/i;

export interface Link {
  name: string;
  href: string;
}

/** The address as a key: the path (no trailing slash) and the query, never the hash. */
export function linkKey(href: string): string {
  const u = new URL(href);
  return `${u.origin}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
}

/** Same-origin links of the page's navigation (nav, role=navigation, aside, header), deduplicated, the harmless ones. Runs in the page. */
export async function collectNavLinks(page: Page, origin: string): Promise<Link[]> {
  // written as a string: the engine's TypeScript has no DOM types
  const script = `((o) => {
    const out = [];
    const scopes = document.querySelectorAll("nav, [role=navigation], aside, header, [data-test-id*=nav]");
    for (const sc of scopes)
      for (const el of sc.querySelectorAll("a[href]")) {
        let u;
        try { u = new URL(el.href, location.href); } catch { continue; }
        if (u.origin !== o) continue;
        if (el.getAttribute("target") === "_blank") continue;
        const name = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
        out.push({ name, href: u.toString() });
      }
    return out;
  })(${JSON.stringify(origin)})`;
  const raw = (await page.evaluate(script).catch(() => [])) as Link[];
  const seen = new Set<string>();
  const links: Link[] = [];
  for (const l of raw) {
    let key: string;
    try {
      key = linkKey(l.href);
    } catch {
      continue;
    }
    const u = new URL(l.href);
    if (seen.has(key) || AVOID.test(u.pathname) || FILE.test(u.pathname + u.search)) continue;
    seen.add(key);
    links.push({ name: l.name || u.pathname, href: l.href });
  }
  return links;
}

export interface Outline {
  headings: string[];
  rows: number;
  tables: number;
  buttons: number;
  links: number;
  inputs: number;
  charts: number;
}

/** What a page holds, from its aria snapshot: its headings and how much of what there is. */
export function outlineOf(raw: string): Outline {
  const headings: string[] = [];
  for (const m of raw.matchAll(/^\s*- heading "((?:[^"\\]|\\.)*)"/gm)) {
    const h = (m[1] ?? "").slice(0, 60);
    if (h && !headings.includes(h)) headings.push(h);
  }
  const count = (re: RegExp) => [...raw.matchAll(re)].length;
  return {
    headings: headings.slice(0, 6),
    rows: count(/^\s*- row\b/gm),
    tables: count(/^\s*- (table|grid)\b/gm),
    buttons: count(/^\s*- button\b/gm),
    links: count(/^\s*- link\b/gm),
    inputs: count(/^\s*- (textbox|combobox|searchbox|checkbox|switch|slider)\b/gm),
    charts: count(/^\s*- (img|figure|graphics-document)\b/gm),
  };
}

export interface SurveyPage {
  screen: string;
  url: string;
  path: string;
  title: string;
  outline?: Outline;
  /** The page loaded more rows when scrolled (it extended once, and was left at that). */
  extends?: { rows: number; px: number };
  status: "seen" | "skipped" | "failed";
  note?: string;
  ms?: number;
}

/** One line per page, for the Director. */
export function surveyLine(p: SurveyPage): string {
  if (p.status !== "seen")
    return `${p.screen || "—"}  ${p.path}  ${p.status.toUpperCase()}: ${p.note ?? ""}`;
  const o = p.outline as Outline;
  const bits = [
    o.headings.length ? `h: ${o.headings.slice(0, 3).join(" | ")}` : "no headings",
    `${o.tables} table${o.tables === 1 ? "" : "s"}, ${o.rows} rows, ${o.buttons} buttons, ${o.inputs} inputs, ${o.charts} images/charts`,
  ];
  if (p.extends)
    bits.push(
      `LOADS MORE ON SCROLL (+${p.extends.rows} rows after one extension; do not scroll it further)`,
    );
  return `${p.screen}  ${p.path}  “${p.title.slice(0, 50)}”  ${bits.join(" · ")}`;
}

/** Tiles of up to 12 screenshots (4×3), one image per tile sheet, in the order given. No sheet where ffmpeg is not installed. */
export async function contactSheets(
  files: string[],
  outDir: string,
  base: string,
): Promise<string[]> {
  if (!files.length || !hasBinary("ffmpeg")) return [];
  const sheets: string[] = [];
  for (let i = 0; i < files.length; i += 12) {
    const chunk = files.slice(i, i + 12);
    const out = path.join(outDir, `${base}-${sheets.length + 1}.jpg`);
    const cols = Math.min(4, chunk.length);
    const W = 480;
    const H = 270;
    const inputs = chunk.flatMap((f) => ["-i", f]);
    const scale = chunk
      .map(
        (_, k) =>
          `[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x222222[v${k}]`,
      )
      .join(";");
    const layout = chunk.map((_, k) => `${(k % cols) * W}_${Math.floor(k / cols) * H}`).join("|");
    const r = await ffmpeg([
      "-y",
      ...inputs,
      "-filter_complex",
      `${scale};${chunk.map((_, k) => `[v${k}]`).join("")}xstack=inputs=${chunk.length}:layout=${layout}:fill=black[o]`,
      "-map",
      "[o]",
      "-frames:v",
      "1",
      "-q:v",
      "4",
      out,
    ]).catch(() => undefined);
    if (r && fs.existsSync(out)) sheets.push(out);
  }
  return sheets;
}
