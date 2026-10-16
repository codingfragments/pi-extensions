/**
 * UX13 (WCAG 2.2 target size, 2.5.8): no interactive control is smaller than 24 x 24 px. The audit baseline is at
 * zero (`scripts/panel-audit.ts` measures 14 screens x 2 themes x 2 widths), and these pages are measured live too.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const baseline = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "panel-audit-baseline.json"), "utf8"),
) as { pages: Record<string, { smallTargets: number }> };

test("the audit baseline has no small targets on any of the audited pages", () => {
  const bad = Object.entries(baseline.pages).filter(([, p]) => p.smallTargets > 0);
  assert.deepEqual(
    bad.map(([k, p]) => `${k}: ${p.smallTargets}`),
    [],
  );
  assert.ok(Object.keys(baseline.pages).length >= 60);
});

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();
const skip = !browserType && "needs Playwright Chromium";

// the same rule as the audit: inline links in text are exempt; a checkbox counts through its label
const SMALL = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    if (el.tagName === 'A' && st.display === 'inline') continue;
    if (el.type === 'checkbox' || el.type === 'radio') {
      const label = el.closest('label');
      if (label) { const b = label.getBoundingClientRect(); if (b.width >= 24 && b.height >= 24) continue; }
    }
    if (r.width < 24 || r.height < 24) out.push(el.tagName + '.' + el.className + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return out;
})()`;

test(
  "live: Voice, Render, the brief, Annotations and Config have no control under 24 px",
  { skip, timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    process.env.DEMO_REC_CONFIG = cfg;
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      for (const [hash, ready] of [
        ["#/voice", "textarea[id^=narration]"],
        ["#/render/v2", ".ds-inspector[data-version='2']"],
        ["#/project?group=brief&field=goal", ".fact-groups"],
        ["#/annotations", ".ds-split-list .ds-item"],
        ["#/config", ".ds-srow"],
      ] as const) {
        await page.goto(`${panel.url}${hash}`);
        await page.waitForSelector(ready);
        await page.waitForTimeout(300);
        assert.deepEqual(await page.evaluate(SMALL), [], hash);
      }
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
