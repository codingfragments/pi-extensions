/**
 * Item 8b (F19): Previous / Next flank the annotation preview, with "4 of 21", disabled at the ends. The selection follows, they
 * walk the annotations as filtered and grouped, `[` and `]` do the same from the keyboard (never in a text field).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
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
const skip = !browserType && "needs Playwright Chromium";

test(
  "Previous and Next: a position label, the ends disabled, the selection follows, the filter is respected, [ and ] step but not in a text field",
  { skip, timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page: Page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/api/annotation-preview", (r) =>
        r.fulfill({
          status: 400,
          contentType: "application/json",
          body: '{"error":"previews are stubbed in this test"}',
        }),
      );
      await page.goto(`${panel.url}#/annotations`);
      await page.waitForSelector(".ds-split-list .ds-item");
      const keys = (await page.evaluate(
        "[...document.querySelectorAll('.ds-split-list .ds-item')].map((e) => e.dataset.key)",
      )) as string[];
      const n = keys.length;
      assert.ok(n >= 4, `the seeded take has ${n} annotations`);
      const label = () => page.locator("[data-position]").innerText();
      const current = () =>
        page.evaluate(
          "document.querySelector('.ds-split-list .ds-item[aria-current=true]')?.dataset.key",
        );
      const prev = page.locator("[data-act=prev-annotation]");
      const next = page.locator("[data-act=next-annotation]");
      // the first one: nothing before it
      assert.match(await label(), new RegExp(`^1 of ${n}`));
      assert.equal(await prev.isDisabled(), true);
      assert.equal(await next.isDisabled(), false);
      // the buttons flank the preview, on either side
      const box = async (sel: string) =>
        (await page.locator(sel).boundingBox()) as { x: number; width: number };
      const pv = await box(".ds-stepper > .ds-shot");
      assert.ok(
        (await box("[data-act=prev-annotation]")).x +
          (await box("[data-act=prev-annotation]")).width <=
          pv.x + 1,
      );
      assert.ok((await box("[data-act=next-annotation]")).x >= pv.x + pv.width - 1);
      // Next: the label, the list and the address follow
      await next.click();
      await page.waitForFunction(
        `document.querySelector('[data-position]').textContent.startsWith('2 of ${n}')`,
      );
      assert.equal(await current(), keys[1]);
      assert.match(await page.evaluate("location.hash"), new RegExp(`item=${keys[1]}`));
      // the keys, with focus in the list
      await page.focus(`.ds-item[data-key='${keys[1]}']`);
      await page.keyboard.press("]");
      await page.waitForFunction(
        `document.querySelector('[data-position]').textContent.startsWith('3 of ${n}')`,
      );
      await page.keyboard.press("[");
      await page.waitForFunction(
        `document.querySelector('[data-position]').textContent.startsWith('2 of ${n}')`,
      );
      // to the end: Next is disabled, ] stays
      for (let i = 2; i < n; i++) await next.click();
      await page.waitForFunction(
        `document.querySelector('[data-position]').textContent.startsWith('${n} of ${n}')`,
      );
      assert.equal(await next.isDisabled(), true);
      assert.equal(await prev.isDisabled(), false);
      assert.equal(await current(), keys[n - 1]);
      await page.focus(`.ds-item[data-key='${keys[n - 1]}']`);
      await page.keyboard.press("]");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await current(), keys[n - 1], "] at the last one stays");
      // [ and ] are text in a text field: a callout's text box
      await page.click(".ds-item[data-key='co-kpi']");
      await page.waitForSelector("#ann-text-co-kpi");
      await new Promise((r) => setTimeout(r, 400));
      const before = await label();
      await page.focus("#ann-text-co-kpi");
      await page.keyboard.press("End");
      await page.keyboard.type("[]", { delay: 50 });
      assert.match(await page.inputValue("#ann-text-co-kpi"), /\[\]$/, "typed as text");
      assert.equal(await label(), before, "the selection did not move");
      await page.fill("#ann-text-co-kpi", "Headline churn");
      // the filter: Next walks only what is shown, and the label says how many exist
      await page.click(".ds-chip:has-text('Callout')");
      await page.waitForFunction(
        "document.querySelectorAll('.ds-split-list .ds-item').length === 1",
      );
      assert.match(await label(), new RegExp(`^1 of 1 shown \\(${n} in all\\)`));
      assert.equal(await prev.isDisabled(), true);
      assert.equal(await next.isDisabled(), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
