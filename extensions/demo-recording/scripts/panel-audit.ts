/**
 * Panel audit (UX1): accessibility checks of the real control room on the seeded project.
 * Every tab and the dialog states, in both themes at 1400 and 900 px:
 *
 *   - axe-core (pinned, fetched once from a CDN into ~/.cache/demo-recording/, so no new dependency):
 *     WCAG 2.0/2.1/2.2 A and AA rules, counted per rule and impact;
 *   - focus: tab through the first interactive elements; each must show a visible focus indicator;
 *   - target size: visible controls smaller than 24 × 24 CSS px (WCAG 2.2, 2.5.8), inline links excepted.
 *
 * An audit that could not run (no Chromium, axe-core not fetchable) says so. It never counts as a pass.
 * Axe alone does not prove conformance: it complements manual keyboard, zoom and screen-reader review.
 *
 *   node extensions/demo-recording/scripts/panel-audit.ts                  # table to the terminal
 *   node extensions/demo-recording/scripts/panel-audit.ts --json out.json  # and the raw numbers
 *   node extensions/demo-recording/scripts/panel-audit.ts --update         # write the regression baseline
 *   node extensions/demo-recording/scripts/panel-audit.ts --widths 1400 --themes latte --tabs voice,render
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

export const AXE_VERSION = "4.10.2";
const AXE_URL = `https://cdn.jsdelivr.net/npm/axe-core@${AXE_VERSION}/axe.min.js`;
export const AUDIT_BASELINE = path.join(
  import.meta.dirname,
  "..",
  "test",
  "fixtures",
  "panel-audit-baseline.json",
);

/** The cached axe-core source, fetched once; undefined when it cannot be had (offline, no cache). */
export async function axeSource(): Promise<string | undefined> {
  const dir = path.join(os.homedir(), ".cache", "demo-recording");
  const file = path.join(dir, `axe-core-${AXE_VERSION}.min.js`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  try {
    const res = await fetch(AXE_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (!text.includes("axe")) return undefined;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    return text;
  } catch {
    return undefined;
  }
}

export interface PageAudit {
  /** violations by rule: nodes affected */
  axe: Record<string, { impact: string; nodes: number }>;
  /** nodes in serious and critical violations */
  axeSerious: number;
  /** visible controls below 24 × 24 px */
  smallTargets: number;
  /** of the first tab stops, those with no visible focus indicator */
  focusMissing: number;
  focusChecked: number;
}
export interface AuditResult {
  axeVersion: string | null;
  pages: Record<string, PageAudit>;
}

export const SCREENS = [
  "project",
  "storyboard",
  "recording",
  "voice",
  "annotations",
  "render",
  "config",
  "project-brief",
  "project-history",
  "map",
  "map-focus",
  "dialog-cost",
  "dialog-danger",
  "toast",
] as const;
const LABELS: Record<string, string> = {
  project: "Project",
  storyboard: "Storyboard",
  recording: "Recording",
  voice: "Voice over",
  annotations: "Annotations",
  render: "Render",
  config: "Config",
};

const SMALL_TARGETS = `(() => {
  let n = 0;
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    if (el.tagName === 'A' && st.display === 'inline') continue; // inline links in text are exempt
    if (el.type === 'checkbox' || el.type === 'radio') {
      const label = el.closest('label');
      if (label) { const b = label.getBoundingClientRect(); if (b.width >= 24 && b.height >= 24) continue; }
    }
    if (r.width < 24 || r.height < 24) {
      n++;
      (window.__small = window.__small || []).push(el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') + '.' + String(el.className).split(' ').slice(0, 3).join('.') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (el.getAttribute('aria-label') || el.innerText || el.title || '').slice(0, 24).split(String.fromCharCode(10)).join(' ') + '"');
    }
  }
  return n;
})()`;

const FOCUS_INDICATOR = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const st = getComputedStyle(el);
  const outline = st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0;
  const shadow = st.boxShadow !== 'none';
  const border = false;
  return outline || shadow || border;
})()`;

export interface AuditOptions {
  widths?: number[];
  themes?: string[];
  screens?: string[];
  tabStops?: number;
  /** a prepared panel to audit instead of a fresh seed */
  panelUrl?: string;
}

export async function runAudit(o: AuditOptions = {}): Promise<AuditResult> {
  const widths = o.widths ?? [1400, 900];
  const themes = o.themes ?? ["macchiato", "latte"];
  const screens = o.screens ?? [...SCREENS];
  const stops = o.tabStops ?? 40;
  const axe = await axeSource();
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = o.panelUrl ? undefined : seedPanelProject();
  let rt: Runtime | undefined;
  let url = o.panelUrl;
  if (seed) {
    rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    url = (await rt.ensurePanel()).url;
  }
  const pw = await import("playwright");
  const browser = await pw.chromium.launch();
  const pages: Record<string, PageAudit> = {};
  try {
    for (const theme of themes) {
      for (const width of widths) {
        for (const screen of screens) {
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          await page.addInitScript(`localStorage.setItem("demo-rec-theme", "${theme}")`);
          await page.goto(url as string);
          await page.waitForSelector("header.top");
          if (screen === "project-brief" || screen === "project-history") {
            await page.goto(
              `${url}#/project?group=${screen === "project-brief" ? "brief" : "history"}`,
            );
            await page.waitForSelector(screen === "project-brief" ? ".fact-groups" : ".brief-text");
            await page.waitForTimeout(400);
          } else if (screen === "map" || screen === "map-focus") {
            await page.goto(
              `${url}#/map${screen === "map-focus" ? "?sel=render%3A2&focus=1" : ""}`,
            );
            await page.waitForSelector(".ds-map .ds-node");
            await page.waitForTimeout(400);
          } else if (screen in LABELS) {
            await page
              .locator("header.top a", {
                hasText: screen === "config" ? "Config" : LABELS[screen],
              })
              .first()
              .click();
            await page.waitForTimeout(400);
          } else {
            await page.waitForTimeout(250);
            const open = (body: string) =>
              page.evaluate(`import("/dialog.js").then((m) => { ${body} })`).catch(() => undefined);
            if (screen === "dialog-cost") {
              void open(
                `m.ask({ title: "Generate voice and render", facts: [["Sections", "4 to synthesize"], ["Cost", "≈ $0.28"]], confirmLabel: "Generate (≈ $0.28)" })`,
              );
              await page.waitForSelector(".modal.dialog");
            } else if (screen === "dialog-danger") {
              void open(
                `m.ask({ title: "Delete the files of Final v7?", text: "This cannot be undone.", danger: true, confirmLabel: "Delete files" })`,
              );
              await page.waitForSelector(".modal.dialog");
            } else {
              await page.evaluate(
                `import("/dialog.js").then((m) => { m.errorToast(new Error("config.json is read-only"), "fps"); m.toast("Draft saved", { kind: "info" }); })`,
              );
              await page.waitForSelector(".toast");
            }
            await page.waitForTimeout(200);
          }
          const audit: PageAudit = {
            axe: {},
            axeSerious: 0,
            smallTargets: (await page.evaluate(SMALL_TARGETS)) as number,
            focusMissing: 0,
            focusChecked: 0,
          };
          if (process.env.AUDIT_WHERE)
            console.log(
              `SMALL ${screen} ${theme} ${width}`,
              await page.evaluate("window.__small || []"),
            );
          if (axe) {
            await page.addScriptTag({ content: axe });
            const found = (await page.evaluate(`axe.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
              resultTypes: ["violations"],
            }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, where: v.nodes.map((n) => n.target.join(" ") + " :: " + (n.any[0]?.message ?? "")).slice(0, 4) })))`)) as {
              id: string;
              impact: string;
              nodes: number;
              where?: string[];
            }[];
            if (process.env.AUDIT_WHERE)
              for (const v of found) console.log(`WHERE ${screen} ${theme} ${v.id}`, v.where);
            for (const v of found) {
              audit.axe[v.id] = { impact: v.impact, nodes: v.nodes };
              if (v.impact === "serious" || v.impact === "critical") audit.axeSerious += v.nodes;
            }
          }
          // a dialog already holds the focus; otherwise start from the top of the page
          if (!screen.startsWith("dialog"))
            await page.evaluate("document.activeElement && document.activeElement.blur()");
          for (let i = 0; i < stops; i++) {
            await page.keyboard.press("Tab");
            const r = (await page.evaluate(FOCUS_INDICATOR)) as boolean | null;
            if (r === null) break;
            audit.focusChecked++;
            if (!r) audit.focusMissing++;
          }
          pages[`${screen}|${theme}|${width}`] = audit;
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    await rt?.shutdown();
    if (seed) fs.rmSync(seed.root, { recursive: true, force: true });
  }
  return { axeVersion: axe ? AXE_VERSION : null, pages };
}

/** Regressions: any page whose serious axe nodes, small targets or missing focus indicators grew. */
export function compare(
  now: AuditResult,
  base: AuditResult,
): { worse: string[]; better: string[] } {
  const worse: string[] = [];
  const better: string[] = [];
  for (const [key, cur] of Object.entries(now.pages)) {
    const was = base.pages[key];
    if (!was) continue;
    const check = (what: string, a: number, b: number) => {
      if (a > b) worse.push(`${key}: ${what} ${a} > baseline ${b}`);
      else if (a < b) better.push(`${key}: ${what} ${a} < baseline ${b}`);
    };
    if (now.axeVersion && base.axeVersion)
      check("serious axe nodes", cur.axeSerious, was.axeSerious);
    check("targets < 24 px", cur.smallTargets, was.smallTargets);
    check("tab stops without a focus indicator", cur.focusMissing, was.focusMissing);
  }
  return { worse, better };
}

export function summary(r: AuditResult): string {
  const lines = [
    `axe-core ${r.axeVersion ?? "NOT RUN (not available offline: run with network once to cache it)"}`,
    "screen          theme       width   serious  small  no-focus/tabbed",
  ];
  for (const [key, a] of Object.entries(r.pages)) {
    const [screen, theme, width] = key.split("|") as [string, string, string];
    lines.push(
      `${screen.padEnd(15)} ${theme.padEnd(11)} ${width.padEnd(7)} ${String(r.axeVersion ? a.axeSerious : "—").padStart(7)}  ${String(a.smallTargets).padStart(5)}  ${a.focusMissing}/${a.focusChecked}`,
    );
  }
  const total = (f: (a: PageAudit) => number) =>
    Object.values(r.pages).reduce((n, a) => n + f(a), 0);
  lines.push(
    `TOTAL serious axe nodes ${r.axeVersion ? total((a) => a.axeSerious) : "n/a"}, small targets ${total((a) => a.smallTargets)}, tab stops without a focus indicator ${total((a) => a.focusMissing)}`,
  );
  const rules = new Map<string, { impact: string; nodes: number }>();
  for (const a of Object.values(r.pages))
    for (const [id, v] of Object.entries(a.axe)) {
      const cur = rules.get(id);
      rules.set(id, { impact: v.impact, nodes: (cur?.nodes ?? 0) + v.nodes });
    }
  for (const [id, v] of [...rules].sort((a, b) => b[1].nodes - a[1].nodes))
    lines.push(`  ${id.padEnd(30)} ${v.impact.padEnd(9)} ${v.nodes} node(s) across all pages`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? (process.argv[i + 1] as string) : undefined;
  };
  const result = await runAudit({
    ...(arg("widths") ? { widths: (arg("widths") as string).split(",").map(Number) } : {}),
    ...(arg("themes") ? { themes: (arg("themes") as string).split(",") } : {}),
    ...(arg("tabs") ? { screens: (arg("tabs") as string).split(",") } : {}),
  });
  console.log(summary(result));
  if (arg("json")) fs.writeFileSync(arg("json") as string, `${JSON.stringify(result, null, 2)}\n`);
  if (process.argv.includes("--update")) {
    if (!result.axeVersion) {
      console.error("not writing a baseline: axe-core did not run");
      process.exitCode = 1;
    } else {
      fs.mkdirSync(path.dirname(AUDIT_BASELINE), { recursive: true });
      fs.writeFileSync(AUDIT_BASELINE, `${JSON.stringify(result, null, 2)}\n`);
      console.log("baseline written:", AUDIT_BASELINE);
    }
  }
}
