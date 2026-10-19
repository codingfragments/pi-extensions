/**
 * UX5c in the browser (D100): the Storyboard screen as a scene list and one inspector. Selection in the
 * address, the scene's intent, steps and review, the review kept apart from approval, risk ordering, the
 * carried-over note, an older version read-only, and the narrow select. Runs on the seeded project
 * (storyboard v1 approved, v2 the latest; scenes 01-dash, 02-search, 03-compare).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { getReview, readState } from "../src/workdir/state.ts";
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

async function setup(width = 1400) {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
    root: seed.root,
    panelPort: 0,
  }));
  const turns: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const open = async (p: Page, hash = "#/storyboard") => {
    await p.goto(`${panel.url}${hash}`);
    await p.waitForSelector(".ds-split-list .ds-item");
  };
  const review = () =>
    getReview(readState(seed.dir) as NonNullable<ReturnType<typeof readState>>, 2);
  const close = async () => {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, page, open, review, turns, errors, close };
}
const keys = (p: Page) =>
  p.evaluate(
    "[...document.querySelectorAll('.ds-split-list .ds-item')].map((e) => e.dataset.key)",
  ) as Promise<string[]>;

test(
  "list and inspector: scenes as rows, the selection in the address, steps and intent in the inspector",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page);
      assert.deepEqual(await keys(page), ["01-dash", "02-search", "03-compare"]);
      assert.equal(
        await page.locator(".ds-item[aria-current=true]").getAttribute("data-key"),
        "01-dash",
      );
      assert.match(await page.locator(".ds-inspector h2").innerText(), /1\. /);
      await page.click(".ds-item[data-key='02-search']");
      await page.waitForSelector(".ds-inspector h2:has-text('2. ')");
      assert.match(await page.evaluate("location.hash"), /^#\/storyboard\?scene=02-search$/);
      // the steps are listed with their marks
      const steps = await page.locator(".ds-inspector ol.steps li").allInnerTexts();
      assert.ok(steps.length >= 2, "the steps of the scene");
      assert.match(steps.join("\n"), /type “churn”/);
      assert.match(steps.join("\n"), /@typed/);
      assert.match(
        await page.locator(".ds-inspector summary").innerText(),
        /\d steps? that will be recorded/,
      );
      // a reload keeps the scene; the diff against v1 marks what changed
      await page.reload();
      await page.waitForSelector(".ds-inspector h2:has-text('2. ')");
      assert.match(await page.locator(".ds-split-list").innerText(), /New|Changed/);
      // narrow: the list folds into a select
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.waitForSelector(".ds-split-bar select");
      assert.equal(await page.locator(".ds-split-list").isVisible(), false);
      await page.selectOption(".ds-split-bar select", "03-compare");
      await page.waitForSelector(".ds-inspector h2:has-text('3. ')");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "review is its own act: mark a scene, add a note, send it; approval stays in the stage summary",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, review, turns, seed, errors, close } = await setup();
    try {
      const posts: string[] = [];
      page.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
      await open(page);
      assert.match(await page.locator(".ds-item[data-key='01-dash']").innerText(), /not reviewed/);
      await page.click("[data-status=changes]");
      await page.waitForFunction(
        "/Needs changes/.test(document.querySelector(\".ds-item[data-key='01-dash']\")?.innerText ?? '')",
      );
      // the chosen decision is the state with a Revoke; the other two stay available
      assert.equal(await page.locator("[data-state=changes]").count(), 1);
      assert.equal(await page.locator("[data-status=changes]").count(), 0);
      assert.equal(await page.locator("[data-status=approved], [data-status=rerun]").count(), 2);
      assert.equal(review().scenes["01-dash"]?.status, "changes");
      await page.fill("textarea[aria-label='Notes for this scene']", "Show the EMEA row first.");
      await page.locator("textarea[aria-label='Notes for this scene']").blur();
      await page.waitForFunction("true");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(review().scenes["01-dash"]?.note, "Show the EMEA row first.");
      // Revoke clears it
      await page.click("[data-act=revoke]");
      await page.waitForFunction(
        "/not reviewed/.test(document.querySelector(\".ds-item[data-key='01-dash']\")?.innerText ?? '')",
      );
      assert.equal(review().scenes["01-dash"], undefined);
      // marking tells the Director nothing; sending the review does
      assert.deepEqual(turns, []);
      await page.click("[data-status=rerun]");
      await page.waitForFunction(
        "/Re-run/.test(document.querySelector(\".ds-item[data-key='01-dash']\")?.innerText ?? '')",
      );
      await page.getByRole("button", { name: "Send review to agent" }).click();
      await page.waitForSelector(".flash:has-text('review sent')");
      assert.equal(turns.length, 1);
      assert.match(turns[0] ?? "", /01-dash/);
      // nothing here approved the version or moved the line
      const state = readState(seed.dir) as NonNullable<ReturnType<typeof readState>>;
      assert.equal(state.accepted.storyboard?.["2"], undefined, "reviewing does not approve");
      assert.equal(state.line.storyboard, 1);
      // the free plans of the stage summary are reads; no approve, select or action was sent
      for (const forbidden of ["/api/version-act", "/api/approve", "/api/select", "/api/unaccept"])
        assert.equal(posts.includes(forbidden), false, forbidden);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "an older version is read-only and says so; a version that does not exist is explained",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page, "#/storyboard/v1");
      assert.equal(
        await page.locator("[data-status=approved]").count(),
        0,
        "no review buttons on an older version",
      );
      assert.match(
        await page.locator(".ds-inspector").innerText(),
        /older version: the review is read-only/,
      );
      assert.equal(await page.locator(".review-foot").count(), 0);
      await page.goto(`${page.url().split("#")[0]}#/storyboard/v9`);
      await page.waitForSelector(".stage-summary");
      assert.match(await page.locator(".stage-summary").innerText(), /v9 does not exist/);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "a review decision is a visible state in both themes and both widths: highlighted, revocable, switchable, in the header and the row, kept by a reload",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, review, errors, close } = await setup();
    try {
      await open(page);
      const look = () =>
        page.evaluate(`(() => {
          const el = document.querySelector('.ds-review-chosen');
          const btn = document.querySelector('.ds-review button[data-status]');
          if (!el || !btn) return null;
          const a = getComputedStyle(el), b = getComputedStyle(btn);
          return { chosen: a.backgroundColor + '|' + a.borderTopColor, plain: b.backgroundColor + '|' + b.borderTopColor };
        })()`) as Promise<{ chosen: string; plain: string } | null>;
      // before: three actions, no state, no badge
      assert.equal(await page.locator(".ds-review button[data-status]").count(), 3);
      assert.equal(await page.locator(".ds-review-chosen, [data-review-badge]").count(), 0);
      assert.match(
        await page.locator(".ds-review-help").innerText(),
        /Re-run: the Director redoes it from the app/,
      );
      for (const status of ["approved", "changes", "rerun"] as const) {
        await page.click(`[data-status=${status}]`);
        await page.waitForSelector(`[data-state=${status}]`);
        assert.equal(review().scenes["01-dash"]?.status, status);
        // the same word in the chosen state, the header badge and the list row
        const word = { approved: "Reviewed", changes: "Needs changes", rerun: "Re-run requested" }[
          status
        ];
        assert.match(await page.locator(`[data-state=${status}]`).innerText(), new RegExp(word));
        assert.match(
          await page.locator(`[data-review-badge=${status}]`).innerText(),
          new RegExp(word),
        );
        assert.match(
          await page.locator(".ds-item[data-key='01-dash']").innerText(),
          new RegExp(`· ${word}`),
        );
        // the other two are still there to switch, and nothing is pressed-looking without being the state
        assert.equal(await page.locator(".ds-review button[data-status]").count(), 2);
      }
      // the look differs from a plain action, in both themes, at both widths (a measured style difference, not a hope)
      for (const theme of ["macchiato", "latte"]) {
        await page.evaluate(`localStorage.setItem("demo-rec-theme", "${theme}")`);
        await page.reload();
        await page.waitForSelector("[data-state=rerun]");
        for (const width of [1400, 900]) {
          await page.setViewportSize({ width, height: 1000 });
          const l = await look();
          assert.ok(
            l && l.chosen !== l.plain,
            `${theme} at ${width}: the state looks like the actions (${JSON.stringify(l)})`,
          );
        }
      }
      // a reload keeps it; Revoke clears it everywhere
      await page.reload();
      await page.waitForSelector("[data-state=rerun]");
      await page.click("[data-act=revoke]");
      await page.waitForSelector(".ds-review button[data-status=rerun]");
      assert.equal(await page.locator(".ds-review button[data-status]").count(), 3);
      assert.equal(await page.locator("[data-review-badge]").count(), 0);
      assert.equal(review().scenes["01-dash"], undefined);
      assert.match(await page.locator(".ds-item[data-key='01-dash']").innerText(), /not reviewed/);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
