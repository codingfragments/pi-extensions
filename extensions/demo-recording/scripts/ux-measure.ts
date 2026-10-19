/**
 * Control counts and page heights per screen (UX9c, docs/UX.md §9): how many controls a person can see and
 * tab to when a screen opens, and how far it scrolls. Run on the seeded project, at 1500 px (the width of the
 * pre-pass measurements in the spec) and at 900 px, in both themes. Counts only what is visible, enabled and
 * not behind an inert page; "focusable" are the elements a keyboard reaches.
 *
 *   node extensions/demo-recording/scripts/ux-measure.ts [--json /tmp/measure.json]
 */

import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

export const SCREENS: [name: string, hash: string][] = [
  ["Project", "#/project"],
  ["Project · Brief", "#/project?group=brief"],
  ["Storyboard", "#/storyboard"],
  ["Recording", "#/recording"],
  ["Voice over", "#/voice"],
  ["Annotations", "#/annotations"],
  ["Render", "#/render"],
  ["Config", "#/config"],
  ["Config · Brands", "#/config?view=brands"],
  ["Map", "#/map"],
];

/** Visible, enabled controls and the ones a keyboard reaches, as a string for page.evaluate. */
export const COUNT = `(() => {
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [tabindex]';
  const vis = (e) => {
    if (e.closest('[inert]')) return false;
    // the inside of a closed <details> is not shown (Chromium still gives it a box)
    if (e.tagName !== 'SUMMARY' && e.closest('details:not([open])')) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const all = [...document.querySelectorAll(sel)].filter(vis);
  const enabled = all.filter((e) => !e.disabled && e.getAttribute('aria-disabled') !== 'true');
  const tab = enabled.filter((e) => e.tabIndex >= 0);
  // the frame (header, band, strip) is on every screen: counted apart, so a screen's own controls show
  const frame = (e) => !!e.closest('header, .ds-next, .ds-strip, footer, nav.steps');
  return {
    visible: all.length,
    controls: enabled.filter((e) => !frame(e)).length,
    frame: enabled.filter(frame).length,
    focusable: tab.filter((e) => !frame(e)).length,
    height: document.documentElement.scrollHeight,
    viewport: innerHeight,
  };
})()`;

export async function measure(opts: { widths?: number[]; themes?: string[] } = {}) {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const globalFile = path.join(seed.root, "measure-config.json");
  fs.writeFileSync(globalFile, "{}");
  process.env.DEMO_REC_CONFIG = globalFile;
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const pw = await import("playwright");
  const browser = await pw.chromium.launch();
  const rows: Record<string, unknown>[] = [];
  try {
    for (const theme of opts.themes ?? ["macchiato"]) {
      for (const width of opts.widths ?? [1500, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        await page.addInitScript(`localStorage.setItem("demo-rec-theme", "${theme}")`);
        for (const [name, hash] of SCREENS) {
          await page.goto(`${panel.url}${hash}`);
          await page.waitForSelector(".ds-header, header.top");
          await page.waitForTimeout(700);
          rows.push({ screen: name, width, theme, ...((await page.evaluate(COUNT)) as object) });
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = (await measure()) as {
    screen: string;
    width: number;
    controls: number;
    focusable: number;
    frame: number;
    height: number;
  }[];
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt >= 0)
    fs.writeFileSync(process.argv[jsonAt + 1] as string, JSON.stringify(rows, null, 1));
  console.log("screen".padEnd(18), "width", "controls", "tab stops", "frame", "page height");
  for (const r of rows)
    console.log(
      r.screen.padEnd(18),
      String(r.width).padStart(5),
      String(r.controls).padStart(8),
      String(r.focusable).padStart(9),
      String(r.frame).padStart(5),
      String(r.height).padStart(9),
    );
  process.exit(0);
}
