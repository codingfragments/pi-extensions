/**
 * UX7 in the browser (D123): the Render screen as a list of runs and one inspector of sections in decision
 * order, New render as a summary line with a primary button and Change…, one unsaved-changes option per
 * annotation draft, and the gates where the action happens. Runs on the seeded project: finals v1 (QA
 * blocked), v2 (QA passed, approved) and v3 (files deleted), draft renders v4–v7. Starting a render and
 * deleting files are intercepted (the engine jobs are covered by the render tests).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { readAnnotations, writeAnnotations } from "../src/annotations/file.ts";
import { resolveConfig } from "../src/config.ts";
import { editAnnotationDraft } from "../src/drafts/annotations.ts";
import { Runtime } from "../src/runtime.ts";
import { readState, unacceptStage } from "../src/workdir/state.ts";
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

async function setup(width = 1400) {
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
  const page = await browser.newPage({ viewport: { width, height: 1200 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/render", async (r) => {
    posts.push({ path: "render", body: JSON.parse(r.request().postData() ?? "{}") });
    await r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/render-delete", async (r) => {
    posts.push({ path: "render-delete", body: JSON.parse(r.request().postData() ?? "{}") });
    await r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const dlg = answerDialogs(page);
  const open = async (p: Page, hash = "#/render") => {
    await p.goto(`${panel.url}${hash}`);
    await p.waitForSelector(".ds-split-list .ds-item");
  };
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, page, open, dlg, posts, errors, close };
}
const keys = (p: Page) =>
  p.evaluate(
    "[...document.querySelectorAll('.ds-split-list .ds-item')].map((e) => e.dataset.key)",
  ) as Promise<string[]>;

test(
  "runs list: approved first, then newest; kind filters; selecting a run is viewing it, and writes nothing",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, seed, errors, close } = await setup();
    try {
      const before = fs.readFileSync(path.join(seed.dir, "state.json"), "utf8");
      await open(page);
      const all = await keys(page);
      assert.equal(all[0], "2", "the approved deliverable comes first");
      assert.ok(all.includes("1") && all.includes("3"));
      assert.match(
        await page.locator(".ds-item[data-key='2']").innerText(),
        /Final v2[\s\S]*QA passed[\s\S]*Approved/,
      );
      assert.match(
        await page.locator(".ds-item[data-key='1']").innerText(),
        /QA blocked: \d+ blocking/,
      );
      assert.match(await page.locator(".ds-item[data-key='3']").innerText(), /files deleted/);
      // filters
      await page.click("[data-kind=finals]");
      assert.deepEqual((await keys(page)).sort(), ["1", "2", "3"]);
      await page.click("[data-kind=drafts]");
      assert.ok((await keys(page)).every((k) => Number(k) >= 4));
      await page.click("[data-kind=all]");
      // a click shows that run in the inspector and puts it in the address, without changing anything
      await page.click(".ds-item[data-key='1']");
      await page.waitForSelector(".ds-inspector[data-version='1']");
      assert.equal(await page.evaluate("location.hash"), "#/render/v1");
      assert.match(await page.locator(".stage-summary").innerText(), /Viewing\s*v1/);
      await page.reload();
      await page.waitForSelector(".ds-inspector[data-version='1']");
      assert.equal(
        fs.readFileSync(path.join(seed.dir, "state.json"), "utf8"),
        before,
        "looking changes nothing",
      );
      // narrow: the list folds into a select
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.waitForSelector(".ds-split-bar select");
      assert.equal(await page.locator(".ds-split-list").isVisible(), false);
      await page.selectOption(".ds-split-bar select", "2");
      await page.waitForSelector(".ds-inspector[data-version='2']");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "the inspector is sections in decision order: QA first for a final, then variants; the gate is stated, not hidden",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page, "#/render/v1");
      const titles = await page
        .locator(".ds-inspector .ds-section > summary strong")
        .allInnerTexts();
      assert.equal(titles[0], "Quality check", "QA comes first for a final");
      assert.match(
        await page.locator(".ds-inspector .ds-section").first().innerText(),
        /QA blocked/,
      );
      assert.equal(
        await page.locator(".ds-inspector .ds-section").first().getAttribute("open"),
        "",
      );
      const approve = page.getByRole("button", { name: "Approve final v1" });
      assert.equal(await approve.getAttribute("aria-disabled"), "true");
      assert.match(
        await page.locator(".ds-inspector .ds-why").first().innerText(),
        /blocking item/i,
      );
      await page.click(".ds-item[data-key='2']");
      await page.waitForSelector(".ds-inspector[data-version='2']");
      assert.match(await page.locator(".ds-inspector").innerText(), /Approved · deliverable/);
      assert.match(
        await page.locator(".ds-inspector .ds-section").first().innerText(),
        /QA passed/,
      );
      // a draft render has no QA section; its variants come first
      const drafts = (await keys(page)).filter((k) => Number(k) >= 4);
      await page.click(`.ds-item[data-key='${drafts[0]}']`);
      await page.waitForSelector(`.ds-inspector[data-version='${drafts[0]}']`);
      assert.equal(
        (await page.locator(".ds-inspector .ds-section > summary strong").allInnerTexts()).includes(
          "Quality check",
        ),
        false,
      );
      // a run without files says so, and offers no delete
      await page.click(".ds-item[data-key='3']");
      await page.waitForSelector(".ds-inspector[data-version='3']");
      assert.match(await page.locator(".ds-inspector").innerText(), /Files deleted/);
      assert.equal(await page.locator("[data-act=delete-files]").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "New render: a summary line and one button; Change… opens the form; one option per annotation draft; a blocked final says why",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, seed, posts, errors, close } = await setup();
    try {
      // two annotation versions, each with an unsaved draft
      const v1 = readAnnotations(seed.dir, 1) as NonNullable<ReturnType<typeof readAnnotations>>;
      const { version: _v, ...rest } = v1;
      writeAnnotations(seed.dir, { ...rest, by: "test" });
      editAnnotationDraft(
        seed.dir,
        1,
        { op: "toggle", id: "ch-dash" },
        { expected: null, author: "t" },
      );
      editAnnotationDraft(
        seed.dir,
        2,
        { op: "toggle", id: "sp-row" },
        { expected: null, author: "t" },
      );
      await open(page);
      assert.equal(
        await page.evaluate("document.querySelector('.render-change').open"),
        false,
        "the form is closed",
      );
      assert.match(
        await page.locator("[data-summary]").innerText(),
        /^Draft · annotations v1 · neutral · all types$/,
      );
      // Render now uses the defaults
      await page.click("[data-act=render-now]");
      await page.waitForFunction("true");
      for (let i = 0; i < 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(posts[0]?.body.kind, "draft");
      assert.equal(posts[0]?.body.annotations, 1);
      assert.equal(posts[0]?.body.fromDraft, undefined);
      // Change…: one option per draft
      await page.click(".render-change > summary");
      const options = await page.locator(".render-form select option").allInnerTexts();
      assert.ok(
        options.some((o) => /unsaved changes on v1 \(1\)/.test(o)),
        options.join(" | "),
      );
      assert.ok(options.some((o) => /unsaved changes on v2 \(1\)/.test(o)));
      await page.selectOption(".render-form select", "draft:2");
      assert.match(await page.locator("[data-summary]").innerText(), /unsaved changes on v2/);
      posts.length = 0;
      await page.click("[data-act=render-now]");
      for (let i = 0; i < 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual([posts[0]?.body.fromDraft, posts[0]?.body.annotations], [true, 2]);
      // a final: no unsaved options
      await page.click("input[name=kind]:near(:text('Final'))");
      const finalOptions = await page.locator(".render-form select option").allInnerTexts();
      assert.equal(
        finalOptions.some((o) => /unsaved changes/.test(o)),
        false,
      );
      await page.waitForFunction(
        "/^Final · annotations v1/.test(document.querySelector('[data-summary]')?.innerText ?? '')",
      );
      assert.equal(
        await page.locator("[data-act=render-now]").getAttribute("aria-disabled"),
        null,
        "v1 is approved: a final is possible",
      );
      // withdraw the approval: the final is blocked, and the reason stands beside the disabled button
      unacceptStage(seed.dir, "annotations", 1);
      await page.reload();
      await page.waitForSelector("[data-act=render-now]");
      await page.click(".render-change > summary");
      await page.click("input[name=kind]:near(:text('Final'))");
      await page.waitForSelector("#why-render");
      assert.ok((await page.locator("#why-render").innerText()).length > 5);
      assert.equal(
        await page.locator("[data-act=render-now]").getAttribute("aria-disabled"),
        "true",
      );
      posts.length = 0;
      await page.click("[data-act=render-now]", { force: true });
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(posts, [], "a blocked final does nothing");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "deleting an approved deliverable asks twice; nothing is deleted before both are confirmed",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, dlg, posts, seed, errors, close } = await setup();
    try {
      await open(page, "#/render/v2");
      await page.waitForSelector(".ds-inspector[data-version='2']");
      dlg.answer.accept = true;
      await page.click("[data-act=delete-files]");
      for (let i = 0; i < 100 && dlg.seen.length < 2; i++)
        await new Promise((r) => setTimeout(r, 50));
      assert.match(dlg.seen[0] ?? "", /Delete the files of final render v2\?/);
      assert.match(dlg.seen[1] ?? "", /Delete the approved deliverable\?[\s\S]*APPROVED/);
      for (let i = 0; i < 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(
        [posts[0]?.path, posts[0]?.body.version, posts[0]?.body.confirmAccepted],
        ["render-delete", 2, true],
      );
      assert.equal(
        readState(seed.dir)?.accepted.render?.["2"] !== undefined,
        true,
        "the approval is not touched by the dialog",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
