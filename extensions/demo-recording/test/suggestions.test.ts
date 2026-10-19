/**
 * The next-action band is a guide to a page: hidden once you are ON that page, never when it is a stop (Blocked) or a status (Director working);
 * the header's "Suggestions · N" lists what waits for you, whether or not the band shows. Nothing is stored (D-R2-8).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { bandHiddenAt, suggestions } from "../src/panel/public/frame-state.js";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const needs = {
  tone: "needs",
  label: "Needs you",
  text: "Storyboard v2 is waiting for review",
  action: { label: "Continue", tab: "storyboard" },
  more: [
    { tab: "voice", text: "Voice over v2 is waiting for review" },
    { tab: "annotations", text: "Annotations v2 is waiting for review" },
  ],
};

test("the band hides only when you are at the page it points to", () => {
  assert.equal(bandHiddenAt(needs, "storyboard"), true);
  assert.equal(
    bandHiddenAt(needs, "voice"),
    false,
    "another page that also waits is not the band's target",
  );
  assert.equal(bandHiddenAt(needs, "render"), false);
  assert.equal(bandHiddenAt(null, "storyboard"), false);
});

test("a stop and a status are never hidden", () => {
  const blocked = {
    tone: "blocked",
    label: "Blocked",
    text: "The recording is blocked",
    action: { label: "Show", tab: "recording" },
    more: [],
  };
  const working = {
    tone: "working",
    label: "Director working",
    text: "Writing the voice-over",
    action: null,
    more: [{ tab: "storyboard", text: "Storyboard v2 is waiting for review" }],
    moreWord: "wait for you",
  };
  const idle = {
    tone: "idle",
    label: "Running",
    text: "Render is running",
    action: null,
    more: [],
  };
  const done = {
    tone: "done",
    label: "Done",
    text: "Everything is approved",
    action: { label: "Open Render", tab: "render" },
    more: [],
  };
  for (const b of [blocked, working, idle, done])
    assert.equal(bandHiddenAt(b, "recording") || bandHiddenAt(b, "render"), false, b.tone);
});

test("the suggestions: the current one first, the others after, the one on this page marked, a stop marked, a status's waiting items listed, nothing when done", () => {
  assert.deepEqual(
    suggestions(needs, "voice").map((s) => [s.tab, s.first ?? false, s.here]),
    [
      ["storyboard", true, false],
      ["voice", false, true],
      ["annotations", false, false],
    ],
  );
  assert.deepEqual(
    suggestions(needs, "storyboard").map((s) => s.here),
    [true, false, false],
    "the same list at the target: the band is hidden, the list is not",
  );
  const blocked = {
    tone: "blocked",
    text: "The recording is blocked",
    action: { label: "Show", tab: "recording" },
    more: [],
  };
  assert.deepEqual(
    suggestions(blocked, "voice").map((s) => [s.tab, s.blocked ?? false]),
    [["recording", true]],
  );
  const working = {
    tone: "working",
    text: "Writing",
    action: null,
    more: [{ tab: "storyboard", text: "S" }],
  };
  assert.deepEqual(
    suggestions(working, "voice").map((s) => s.tab),
    ["storyboard"],
  );
  assert.deepEqual(
    suggestions(
      { tone: "done", text: "ok", action: { label: "Open Render", tab: "render" }, more: [] },
      "voice",
    ),
    [],
  );
  assert.deepEqual(suggestions(null, "voice"), []);
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
  "in the browser: the band collapses at its target without a jump of the pins, 'Suggestions · N' stays and lists it, Escape and a click elsewhere close it",
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
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const hwrapOk = () =>
        page.waitForFunction(
          "getComputedStyle(document.documentElement).getPropertyValue('--hwrap-h') === document.querySelector('.ds-hwrap').getBoundingClientRect().height + 'px'",
        );
      const bandHeight = () =>
        page.evaluate(
          "document.querySelector('.ds-next-wrap').getBoundingClientRect().height",
        ) as Promise<number>;
      // on another page: the band shows
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".ds-next");
      await hwrapOk();
      assert.ok((await bandHeight()) > 40, "the band shows on a page it does not point to");
      assert.match(
        await page.locator(".ds-next").innerText(),
        /Storyboard v2 is waiting for review/,
      );
      const withBand = (await page.evaluate(
        "document.querySelector('.ds-hwrap').getBoundingClientRect().height",
      )) as number;
      // at its target: it collapses, the header block follows (the pins use it), and the entry stays with the same count
      await page.goto(`${panel.url}#/storyboard`);
      await page.waitForFunction(
        "document.querySelector('.ds-next-wrap')?.dataset.hidden === 'true'",
      );
      await page.waitForFunction(
        "document.querySelector('.ds-next-wrap').getBoundingClientRect().height < 1",
      );
      await hwrapOk();
      const withoutBand = (await page.evaluate(
        "document.querySelector('.ds-hwrap').getBoundingClientRect().height",
      )) as number;
      assert.ok(
        withBand - withoutBand > 40,
        `the header block shrank from ${withBand} to ${withoutBand}`,
      );
      assert.equal(
        await page.evaluate("document.querySelector('.ds-next-clip').inert"),
        true,
        "the hidden band is out of the keyboard's reach",
      );
      const entry = page.locator(".ds-suggest > summary");
      assert.match((await entry.innerText()).replace(/\s+/g, " "), /Suggestions · 2$/);
      // the list holds the suggestion you are on, marked, and the other one; a click goes there
      await entry.click();
      const list = page.locator(".ds-suggest ul");
      await list.waitFor();
      assert.match(
        await list.locator("li[data-here=true]").innerText(),
        /Storyboard v2 is waiting for review[\s\S]*you are here/,
      );
      assert.match(await list.innerText(), /Voice over v2 is waiting for review/);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".ds-suggest ul").isVisible(), false, "Escape closes it");
      await entry.click();
      await page.mouse.click(700, 500);
      assert.equal(
        await page.locator(".ds-suggest ul").isVisible(),
        false,
        "a click elsewhere closes it",
      );
      await entry.click();
      await page.locator(".ds-suggest ul a", { hasText: "Voice over v2" }).click();
      await page.waitForFunction("location.hash.startsWith('#/voice')");
      assert.equal(
        await page.locator(".ds-suggest ul").isVisible(),
        false,
        "choosing one closes it",
      );
      // back on a page it does not point to: the band is back
      await page.waitForFunction(
        "document.querySelector('.ds-next-wrap')?.dataset.hidden === undefined",
      );
      await page.waitForFunction(
        "document.querySelector('.ds-next-wrap').getBoundingClientRect().height > 40",
      );
      assert.match(
        (await page.locator(".ds-suggest > summary").innerText()).replace(/\s+/g, " "),
        /Suggestions · 2$/,
      );
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
