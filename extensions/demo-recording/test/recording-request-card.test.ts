/**
 * Item 13b (R3-4, D146): the "Request a new take" box is a card at the BOTTOM of the Recording tab, like the storyboard's review card: a notes box, the open-notes
 * count, the button and the cost hint. The guidance about approving takes sits with the take rows.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";
import { seedReviewTakes } from "./helpers/review-take.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

test(
  "the request card is the last thing on the Recording tab; the guidance is above the takes; the card works",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    seedReviewTakes(seed);
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
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const posts: Record<string, unknown>[] = [];
      await page.route("**/api/rerecord", async (r) => {
        posts.push(JSON.parse(r.request().postData() ?? "{}"));
        await r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      const dlg = answerDialogs(page);
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector("[data-request-take]");
      const y = async (sel: string) =>
        (await page.evaluate(
          `document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top + scrollY`,
        )) as number;
      // order on the page: the guidance, the takes, the review workspace, then the request card, last
      const guide = await y(".ds-take-guide");
      const row = await y(".ds-take-row, [data-act=review-take]");
      const work = await y(".ds-rv");
      const card = await y("[data-request-take]");
      assert.ok(guide < row, "the guidance comes before the take rows");
      assert.ok(work < card, "the request card is below the review workspace");
      assert.equal(
        await page.evaluate(
          `document.querySelector('[data-request-take]').nextElementSibling === null || !document.querySelector('[data-request-take]').nextElementSibling.matches('section.card')`,
        ),
        true,
        "nothing else of the tab comes after it",
      );
      assert.equal(await page.locator(".review-head").count(), 0, "nothing at the top any more");
      assert.match(
        await page.locator(".ds-take-guide").innerText(),
        /Approve every take that is good enough to build on[\s\S]*Use for next steps/,
      );
      // the card: a notes box (several lines), the count, the primary button, the cost hint
      const box = page.locator(
        "[data-request-take] textarea[aria-label='notes for the next take']",
      );
      assert.equal(await box.count(), 1);
      assert.match(
        await page.locator("[data-request-take]").innerText(),
        /No open notes on the takes/,
      );
      assert.equal(await page.locator("[data-request-take] .cost-hint").count(), 1);
      const colours = (await page.evaluate(
        `(() => { const b = document.querySelector('[data-request-take] button.ds-btn--primary'); return [getComputedStyle(b).backgroundColor, getComputedStyle(document.body).backgroundColor]; })()`,
      )) as string[];
      assert.notEqual(
        colours[0],
        colours[1],
        `the request button keeps its primary colour (${colours[0]})`,
      );
      // it sends the note once
      await box.fill("tighten the search scene");
      await page.getByRole("button", { name: "Request a new take" }).click();
      for (let i = 0; i < 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(posts[0]?.note, "tighten the search scene");
      dlg.stop();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
