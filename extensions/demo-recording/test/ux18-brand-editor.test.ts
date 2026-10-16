/**
 * UX18: the Brand editor on the Config pattern: a list of brands and one inspector, rows with a control each (changed
 * ones marked, with an Undo), groups that open and close, a preview, and a pinned bar for Reset, Save as copy and Save.
 * Everything the old editor could do is still done through the same routes and the same diff confirmation.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
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
  "Brands: list + inspector, rows with changed marks and Undo, Save as copy keeps the tweaks, defaults through the diff, a narrow select",
  { skip, timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const globalFile = path.join(seed.root, "global.json");
    fs.writeFileSync(globalFile, "{}");
    process.env.DEMO_REC_CONFIG = globalFile;
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const page = await (
      await browser.newContext({ viewport: { width: 1400, height: 1200 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const dlg = answerDialogs(page);
    // the preview renders a still with Chromium and ffmpeg: not the point of this test
    await page.route("**/api/brand-preview", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"warnings":["preview stubbed"]}',
      }),
    );
    try {
      await page.goto(`${panel.url}#/config?view=brands`);
      await page.waitForSelector(".brand-editor .ds-inspector[data-brand]");
      // the list: the built-in brand is there, marked default and built-in
      const row = page.locator(".brand-editor .ds-list .ds-item[data-key='neutral']");
      assert.match(await row.innerText(), /neutral[\s\S]*built-in[\s\S]*Default/);
      assert.equal(await row.getAttribute("aria-current"), "true");
      // the inspector: the built-in notice, the groups, a row per field, Save disabled for a built-in
      const insp = page.locator(".brand-editor .ds-inspector");
      assert.match(await insp.innerText(), /Built-in brands are read-only/);
      assert.deepEqual(
        await page.evaluate(
          "[...document.querySelectorAll('.brand-editor .ds-group')].map((e) => e.dataset.group)",
        ),
        ["Colors", "Frame", "Title card", "Logo bug"],
      );
      assert.ok((await page.locator(".brand-editor .ds-brow").count()) >= 18);
      assert.equal(
        await page.locator("[data-act=save]").isDisabled(),
        true,
        "a built-in cannot be saved over",
      );
      assert.equal(
        await page.locator("[data-act=default-global]").isDisabled(),
        true,
        "it already is the default",
      );
      assert.equal(await page.locator("[data-act=reset]").isDisabled(), true);
      // a tweak: the row, the group and the bar say so; Undo takes it back
      await page.evaluate(
        `(() => { const e = document.getElementById('brand-colors.accent'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '#ff0000'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await page.waitForSelector(".ds-brow[data-path='colors.accent'][data-changed=true]");
      assert.match(
        await page.locator("[data-group=Colors] .ds-group-head").innerText(),
        /1 changed/,
      );
      assert.match(await page.locator(".brand-actionbar").innerText(), /1 unsaved tweak\b/);
      assert.equal(await page.locator("[data-act=save]").isDisabled(), true, "still a built-in");
      await page.click(".ds-brow[data-path='colors.accent'] [data-act=undo-field]");
      await page.waitForSelector(".ds-brow[data-changed=true]", { state: "detached" });
      assert.match(await page.locator(".brand-actionbar").innerText(), /No changes/);
      // a group closes and opens
      await page.click("[data-group=Frame] .ds-group-head");
      assert.equal(await page.locator("[data-group=Frame] .ds-brow").count(), 0);
      await page.click("[data-group=Frame] .ds-group-head");
      assert.ok((await page.locator("[data-group=Frame] .ds-brow").count()) >= 5);
      // Save as copy keeps the tweaks and selects the copy
      await page.evaluate(
        `(() => { const e = document.getElementById('brand-colors.accent'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '#ff0000'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await page.waitForSelector(".ds-brow[data-changed=true]");
      dlg.answer.text = "acme-test";
      await page.click("[data-act=copy]");
      const copy = page.locator(".brand-editor .ds-list .ds-item[data-key='acme-test']");
      await copy.waitFor();
      await page.waitForFunction(
        "document.querySelector(\".brand-editor .ds-list .ds-item[data-key='acme-test']\")?.getAttribute('aria-current') === 'true'",
      );
      const file = path.join(seed.root, "brands", "acme-test", "brand.json");
      assert.equal(fs.existsSync(file), true, "the copy is on disk");
      assert.match(fs.readFileSync(file, "utf8").toLowerCase(), /#ff0000/);
      // the copy is yours: no built-in notice; make it the default through the diff
      assert.equal(
        await page
          .locator(".brand-editor .ds-inspector")
          .innerText()
          .then((t) => /Built-in brands are read-only/.test(t)),
        false,
      );
      dlg.seen.length = 0;
      await page.click("[data-act=default-global]");
      for (let i = 0; i < 100 && !JSON.parse(fs.readFileSync(globalFile, "utf8")).brand; i++)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).brand, "acme-test");
      assert.match(dlg.seen[0] ?? "", /Set the default brand \(global\)\?[\s\S]*acme-test/);
      // narrow: the list becomes a select
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.waitForSelector(".ds-split-bar select");
      assert.equal(await page.locator(".brand-editor .ds-split-list").isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      dlg.stop();
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
