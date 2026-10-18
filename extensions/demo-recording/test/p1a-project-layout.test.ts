/**
 * The Project page's summary (the brief in human terms) with LONG values: a persona or a goal of several sentences
 * must wrap inside its cell. Before this, the global `dl { grid-template-columns: max-content 1fr }` made the
 * first column as wide as the longest text, the summary overflowed the page and the rows were thousands of
 * pixels tall (found on the first real run's brief).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

const LONG =
  "Technical evaluators: engineers and product managers who know e-commerce and modern web UIs, have never seen the product, and will judge build quality and whether the AI chat actually works, not just whether it looks good in a demo.";

test(
  "the project summary wraps long values inside its cells at 1400 and 900 px",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    const post = rt.routeTables().post["project-facts"] as (b: Record<string, unknown>) => unknown;
    await post({ patch: { persona: LONG, goal: `${LONG} ${LONG}` }, confirm: true });
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      for (const width of [1400, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        await page.goto(`${panel.url}#/project`);
        await page.waitForSelector(".ds-factlist .ds-fact");
        const m = (await page.evaluate(`(() => {
        const list = document.querySelector(".ds-factlist");
        const l = list.getBoundingClientRect();
        const facts = [...list.querySelectorAll(".ds-fact")].map((e) => e.getBoundingClientRect());
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          list: { w: l.width, h: l.height },
          inside: facts.every((r) => r.x >= l.x - 1 && r.x + r.width <= l.x + l.width + 1),
          tallest: Math.max(...facts.map((r) => r.height)),
          columns: new Set(facts.map((r) => Math.round(r.x))).size,
        };
      })()`)) as {
          page: number;
          list: { w: number; h: number };
          inside: boolean;
          tallest: number;
          columns: number;
        };
        assert.equal(m.page, 0, `${width}: the page does not scroll sideways`);
        assert.ok(m.inside, `${width}: every row is inside the summary`);
        assert.ok(m.tallest < 260, `${width}: no row taller than a few lines (was ${m.tallest}px)`);
        assert.ok(m.list.h < 700, `${width}: the summary stays compact (was ${m.list.h}px)`);
        assert.equal(
          m.columns,
          width >= 1200 ? 2 : 1,
          `${width}: two columns when wide, one when narrow`,
        );
        if (process.env.P1A_SHOTS)
          await page.screenshot({ path: `${process.env.P1A_SHOTS}-project-${width}.png` });
        await page.close();
      }
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
