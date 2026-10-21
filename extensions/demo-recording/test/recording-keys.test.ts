/**
 * Item 13c (R3-3, D146): the keys of the Recording tab work anywhere on the tab, not only while the player has the focus: `<` `>` move between findings, `[` `]`
 * between chapters, the arrows seek 10 s (Shift: 1 s), `N` adds a note; never while you type or a dialog is open.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import {
  FINE_STEP_MS,
  STEP_MS,
  clampSeek,
  findingStops,
  keyAction,
  stopFrom,
} from "../src/panel/public/recording-keys-core.js";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";
import { seedReviewTakes } from "./helpers/review-take.ts";

test("what each key means", () => {
  assert.deepEqual(keyAction("]"), { kind: "chapter", d: 1 });
  assert.deepEqual(keyAction("["), { kind: "chapter", d: -1 });
  assert.deepEqual(keyAction(">"), { kind: "finding", d: 1 });
  assert.deepEqual(keyAction("<"), { kind: "finding", d: -1 });
  assert.deepEqual(keyAction("ArrowRight"), { kind: "seekBy", ms: STEP_MS });
  assert.deepEqual(keyAction("ArrowLeft"), { kind: "seekBy", ms: -STEP_MS });
  assert.deepEqual(keyAction("ArrowRight", true), { kind: "seekBy", ms: FINE_STEP_MS });
  assert.deepEqual(keyAction("ArrowLeft", true), { kind: "seekBy", ms: -FINE_STEP_MS });
  for (const k of ["n", "N", "+"]) assert.deepEqual(keyAction(k), { kind: "note" });
  for (const k of ["ArrowUp", "ArrowDown", "Home", "a", ",", "."])
    assert.equal(keyAction(k), null, k);
  assert.equal(STEP_MS, 10_000);
  assert.equal(FINE_STEP_MS, 1_000);
});

test("the findings of a take in take order: timed ones at their time, planned ones at the start of their scene, one stop for a finding named twice", () => {
  const scenes = [
    {
      id: "s1",
      startMs: 0,
      found: [],
      planned: [{ id: "f-1", text: "Search ignores descriptions" }],
    },
    {
      id: "s2",
      startMs: 2000,
      found: [
        { id: "e-1", text: "error toast", t: 2500 },
        { id: "f-1", text: "Search ignores descriptions", t: 3100 },
      ],
      planned: [{ id: "f-2", text: "No empty state" }],
    },
    { id: "s3", startMs: 4000, found: [{ id: "e-2", text: "dead time" }], planned: [] },
  ];
  const stops = findingStops(scenes);
  assert.deepEqual(
    stops.map((s) => [s.id, s.ms, s.scene, s.timed]),
    [
      ["e-1", 2500, "s2", true],
      ["f-2", 2000, "s2", false],
      ["f-1", 3100, "s2", true],
      ["e-2", 4000, "s3", false],
    ].sort((a, b) => (a[1] as number) - (b[1] as number)),
  );
  assert.equal(
    stops.filter((s) => s.id === "f-1").length,
    1,
    "named by the plan and found: one stop, at its time",
  );
  assert.deepEqual(findingStops([]), []);
  assert.deepEqual(findingStops(undefined as never), []);
});

test("next and previous: a finding ahead is later than the playhead, one behind is earlier than it, so a second < goes on", () => {
  const stops = findingStops([
    {
      id: "s",
      startMs: 0,
      found: [
        { id: "a", text: "a", t: 1000 },
        { id: "b", text: "b", t: 3000 },
        { id: "c", text: "c", t: 5000 },
      ],
      planned: [],
    },
  ]);
  assert.equal(stopFrom(stops, 0, 1)?.id, "a");
  assert.equal(stopFrom(stops, 1000, 1)?.id, "b", "standing on a finding, > goes to the next");
  assert.equal(stopFrom(stops, 5000, 1), undefined, "after the last: none");
  assert.equal(stopFrom(stops, 5000, -1)?.id, "b", "standing on one, < goes to the one before");
  assert.equal(
    stopFrom(stops, 5300, -1)?.id,
    "b",
    "just after arriving (under 0.8 s), < goes on, not back to the same one",
  );
  assert.equal(stopFrom(stops, 6500, -1)?.id, "c");
  assert.equal(stopFrom(stops, 500, -1), undefined, "before the first: none");
});

test("seeking by a step stays inside the take", () => {
  assert.equal(clampSeek(2000, 10_000, 6000), 6000);
  assert.equal(clampSeek(2000, -10_000, 6000), 0);
  assert.equal(clampSeek(2000, 1000, 6000), 3000);
  assert.equal(clampSeek(2000, 10_000, 0), 12_000, "an unknown length does not stop it");
  assert.equal(clampSeek(2000, 10_000, Number.NaN), 12_000);
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

test(
  "in the browser: the keys work with the focus on the page, not on the player; not in a text box; not under a dialog",
  { skip: !browserType && "needs Playwright Chromium", timeout: 150_000 },
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
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector(".ds-rv-video");
      await page.waitForFunction("document.querySelector('.ds-rv-video').readyState >= 1");
      const t = async () =>
        (await page.evaluate("document.querySelector('.ds-rv-video').currentTime")) as number;
      const status = () => page.locator("[data-keystatus]").innerText();
      // the focus is on the page (the heading area), not on the player or inside the workspace
      await page.evaluate("document.activeElement?.blur(); window.scrollTo(0, 0)");
      assert.equal(await page.evaluate("document.activeElement === document.body"), true);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction("document.querySelector('.ds-rv-video').currentTime > 5.9");
      assert.match(await status(), /^Forward 10 s · /);
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction("document.querySelector('.ds-rv-video').currentTime < 0.1");
      await page.keyboard.press("Shift+ArrowRight");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 1) < 0.15",
      );
      assert.match(await status(), /^Forward 1 s · /);
      // findings of this take: the one the storyboard planned for scene 2 (at its start, 2 s) and the error toast the take found there (3 s)
      await page.keyboard.press("Shift+Period"); // >
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 2) < 0.15",
      );
      assert.match(
        await status(),
        /^Finding 1 of 2 · 0:02\.0 · 02-search: Search ignores descriptions$/,
      );
      await page.keyboard.press("Shift+Period");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 3) < 0.15",
      );
      assert.match(await status(), /^Finding 2 of 2 · 0:03\.0 · 02-search: error shown/);
      await page.keyboard.press("Shift+Period");
      assert.match(await status(), /^No further finding$/);
      await page.keyboard.press("Shift+Comma"); // <
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 2) < 0.15",
      );
      assert.match(await status(), /^Finding 1 of 2 · /);
      await page.keyboard.press("Shift+Comma");
      assert.match(await status(), /^No earlier finding$/);
      // chapters still work from the page: from 2 s (chapter 2) to chapter 3 at 4 s
      await page.keyboard.press("]");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 4) < 0.15",
      );
      // the focus on a button elsewhere on the tab (a take row) still gets the keys
      await page.focus("[data-act=review-take]");
      const before = await t();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        `document.querySelector('.ds-rv-video').currentTime > ${before} + 1.5`,
      );
      // never in a text box: typing "<" and the arrows in the notes box does nothing to the video
      const box = page.locator("textarea[aria-label='notes for the next take']");
      await box.focus();
      const at = await t();
      await box.press("Shift+Comma");
      await box.press("ArrowLeft");
      assert.equal(await box.inputValue(), "<", "the character is typed");
      assert.equal(await t(), at, "the video did not move");
      // N from the page starts a note
      await page.evaluate("document.activeElement?.blur()");
      await page.keyboard.press("n");
      await page.waitForSelector(
        "[data-act=note-save], .ds-note-box textarea, textarea[aria-label*='note' i]:not([aria-label='notes for the next take'])",
      );
      await page.keyboard.press("Escape");
      // a dialog on top: the keys wait
      await page.evaluate("document.activeElement?.blur()");
      await page.keyboard.press("Shift+Slash"); // ? opens the shortcut sheet
      await page.waitForSelector(".modal.dialog");
      const inDialog = await t();
      await page.keyboard.press("ArrowRight");
      assert.equal(await t(), inDialog, "no seeking under a dialog");
      await page.keyboard.press("Escape");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
