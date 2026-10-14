/**
 * Layout snapshots (S5 part 6, D34 / Q8): positions of the visible elements,
 * so annotations can target anything on screen — not only what a step clicked.
 *
 *   takes/take-NNN/layout.jsonl   one snapshot per line (take time)
 *
 * When: after each step once the page is quiet (≤ 1.5 s), at every mark, and
 * at most one settle snapshot per 500 ms. Captured in the background: the
 * cursor never waits for it.
 *
 * What: elements intersecting the viewport that are visible (not hidden, not
 * transparent): elements with their own text (cut to 200 chars — a long
 * paragraph such as an assistant's answer is kept, shortened), interactive roles,
 * table cells and rows, headings, images with alt text, inputs (their value
 * only when not a password / credential / one-time-code field). At most 400
 * per snapshot — larger boxes and interactive elements first. Boxes are CSS px
 * in the viewport; × dpr = source px.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

export const LAYOUT_FILE = "layout.jsonl";
export const MAX_ELEMENTS = 400;

export interface LayoutElement {
  id: string;
  role: string;
  /** Accessible name (aria-label / alt / label), when different from the text. */
  name?: string;
  text?: string;
  /** Input value (never for password / credential fields). */
  value?: string;
  box: { x: number; y: number; w: number; h: number };
}

export interface LayoutSnapshot {
  t: number;
  reason: "settle" | "mark";
  mark?: string;
  scene?: string;
  step?: number;
  url: string;
  scroll: { x: number; y: number };
  viewport: { w: number; h: number };
  els: LayoutElement[];
}

/** Runs in the page (a string, so no DOM types are needed here). */
export const LAYOUT_SCRIPT = `(() => {
  const MAX = ${MAX_ELEMENTS};
  const vw = innerWidth, vh = innerHeight;
  const IMPLICIT = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    TD: "cell", TH: "columnheader", TR: "row", LI: "listitem", LABEL: "label", SUMMARY: "button", OPTION: "option" };
  const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "option", "slider", "spinbutton"]);
  const SECRET_AUTOCOMPLETE = /(password|one-time-code|cc-|credit)/i;
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r.split(/\\s+/)[0];
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return t === "checkbox" ? "checkbox" : t === "radio" ? "radio" : t === "range" ? "slider" : t === "search" ? "searchbox" : t === "submit" || t === "button" ? "button" : "textbox";
    }
    return IMPLICIT[el.tagName] || "";
  };
  const ownText = (el) => {
    let s = "";
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
    return s.replace(/\\s+/g, " ").trim();
  };
  const visible = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    let p = el;
    while (p && p.nodeType === 1) {
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.1) return false;
      p = p.parentElement;
    }
    return true;
  };
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.id === "__demo_rec_cursor" || el.closest("#__demo_rec_cursor")) continue;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH"].includes(el.tagName.toUpperCase())) continue;
    const role = roleOf(el);
    const text = ownText(el);
    const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    const alt = el.tagName === "IMG" ? (el.getAttribute("alt") || "").trim() : "";
    const label = (el.getAttribute("aria-label") || "").trim();
    const keep = INTERACTIVE.has(role) || role === "heading" || role === "cell" || role === "columnheader" || role === "row" || !!text || alt || isInput;
    if (!keep) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const item = { role: role || el.tagName.toLowerCase(), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
    const name = label || alt;
    if (name) item.name = name.slice(0, 200);
    const t = role === "row" ? (el.innerText || "").replace(/\\s+/g, " ").trim() : text;
    if (t) item.text = t.slice(0, 200);
    if (isInput) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      const ac = el.getAttribute("autocomplete") || "";
      if (type !== "password" && !SECRET_AUTOCOMPLETE.test(ac) && typeof el.value === "string" && el.value) item.value = el.value.slice(0, 200);
    }
    out.push(item);
  }
  // Cap: interactive first, then larger boxes.
  out.sort((a, b) => (INTERACTIVE.has(b.role) ? 1 : 0) - (INTERACTIVE.has(a.role) ? 1 : 0) || b.box.w * b.box.h - a.box.w * a.box.h);
  const els = out.slice(0, MAX).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x).map((e, i) => ({ id: "e" + (i + 1), ...e }));
  return { url: location.href, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) }, viewport: { w: vw, h: vh }, els };
})()`;

export async function captureLayout(
  page: Page,
): Promise<Omit<LayoutSnapshot, "t" | "reason"> | undefined> {
  try {
    return (await page.evaluate(LAYOUT_SCRIPT)) as Omit<LayoutSnapshot, "t" | "reason">;
  } catch {
    // Navigation destroyed the context mid-capture: the next settle captures the new page.
    return undefined;
  }
}

/** Appends snapshots to `<take>/layout.jsonl`, throttling settle snapshots. */
export class LayoutRecorder {
  private readonly file: string;
  private lastSettle = Number.NEGATIVE_INFINITY;
  readonly minGapMs: number;
  count = 0;

  constructor(takeDir: string, minGapMs = 500) {
    this.file = path.join(takeDir, LAYOUT_FILE);
    this.minGapMs = minGapMs;
  }

  /** Whether a settle snapshot at take time `t` is allowed (marks are always kept). */
  allow(reason: LayoutSnapshot["reason"], t: number): boolean {
    if (reason === "mark") return true;
    if (t - this.lastSettle < this.minGapMs) return false;
    this.lastSettle = t;
    return true;
  }

  write(snap: LayoutSnapshot): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(snap)}\n`);
    this.count++;
  }

  /** Drop snapshots at or after take time `t` (a failed attempt that gets re-shot). */
  discardFrom(t: number): void {
    if (!fs.existsSync(this.file)) return;
    const keep = fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim() && (JSON.parse(l) as LayoutSnapshot).t < t);
    fs.writeFileSync(this.file, keep.length ? `${keep.join("\n")}\n` : "");
    this.count = keep.length;
  }
}

/** All snapshots of a take, oldest first. */
export function readLayout(takeDir: string): LayoutSnapshot[] {
  const file = path.join(takeDir, LAYOUT_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LayoutSnapshot);
}

/** The snapshot in effect at take time `t` (the last one at or before it). */
export function layoutAt(snaps: LayoutSnapshot[], t: number): LayoutSnapshot | undefined {
  let best: LayoutSnapshot | undefined;
  for (const s of snaps) if (s.t <= t && (!best || s.t >= best.t)) best = s;
  return best;
}
