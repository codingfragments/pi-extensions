/**
 * UX19a: the map can zoom. Fit shows the whole graph in the window, + and − (buttons and keys) go closer or further,
 * Ctrl + wheel does too, Reset view goes back to 100 %. Zoom is a view setting: it never changes what the map shows
 * or the address.
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
const skip = !browserType && "needs Playwright Chromium";

test(
  "map zoom: Fit shows the whole graph, buttons and keys zoom, Ctrl+wheel zooms, Reset goes back, the address is untouched",
  { skip, timeout: 90_000 },
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
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    // a short window: the graph does not fit at 100 %
    const page = await (
      await browser.newContext({ viewport: { width: 1200, height: 640 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const level = async () => (await page.innerText("[data-zoom]")).trim();
    const fits = () =>
      page.evaluate(`(() => {
        const c = document.querySelector('.ds-map-canvas');
        const z = document.querySelector('.ds-map-zoom');
        const r = z.getBoundingClientRect();
        const cr = c.getBoundingClientRect();
        return { w: r.width <= cr.width + 1, h: r.height <= cr.height + 1, scroll: c.scrollHeight > c.clientHeight + 1 };
      })()`) as Promise<{ w: boolean; h: boolean; scroll: boolean }>;
    try {
      await page.goto(`${panel.url}#/map`);
      await page.waitForSelector(".ds-map .ds-node");
      const hash0 = await page.evaluate("location.hash");
      assert.equal(await level(), "100%");
      assert.equal(
        (await fits()).h,
        false,
        "at 100 % the graph is taller than the window (it scrolls)",
      );
      // Fit
      await page.click("[data-act=fit]");
      const afterFit = await level();
      assert.ok(Number.parseInt(afterFit) < 100 && Number.parseInt(afterFit) >= 30, afterFit);
      const f = await fits();
      assert.deepEqual([f.w, f.h], [true, true], "the whole graph is in view");
      // buttons
      await page.click("[data-act=zoom-in]");
      assert.ok(Number.parseInt(await level()) > Number.parseInt(afterFit));
      await page.click("[data-act=zoom-out]");
      await page.click("[data-act=zoom-out]");
      assert.ok(Number.parseInt(await level()) < Number.parseInt(afterFit));
      // keys (not while typing in the search)
      await page.keyboard.press("0");
      assert.equal(await level(), afterFit, "0 is Fit");
      await page.keyboard.press("+");
      const plus = await level();
      assert.ok(Number.parseInt(plus) > Number.parseInt(afterFit));
      await page.keyboard.press("-");
      assert.equal(await level(), afterFit);
      await page.focus(".ds-map input[type=search]");
      await page.keyboard.type("0+-");
      assert.equal(await level(), afterFit, "typing in the search does not zoom");
      assert.equal(await page.inputValue(".ds-map input[type=search]"), "0+-");
      await page.fill(".ds-map input[type=search]", "");
      // limits
      await page.evaluate("document.activeElement.blur()");
      for (let i = 0; i < 30; i++) await page.keyboard.press("-");
      assert.equal(await level(), "30%");
      assert.equal(await page.locator("[data-act=zoom-out]").isDisabled(), true);
      for (let i = 0; i < 30; i++) await page.keyboard.press("+");
      assert.equal(await level(), "160%");
      assert.equal(await page.locator("[data-act=zoom-in]").isDisabled(), true);
      // Ctrl + wheel zooms; a plain wheel does not
      await page.click("[data-act=fit]");
      const box = (await page.locator(".ds-map-canvas").boundingBox()) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      await page.mouse.move(box.x + 200, box.y + 200);
      const before = await level();
      await page.mouse.wheel(0, 120);
      assert.equal(await level(), before, "a plain wheel only scrolls");
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120);
      await page.keyboard.up("Control");
      assert.ok(
        Number.parseInt(await level()) > Number.parseInt(before),
        "Ctrl + wheel up zooms in",
      );
      // Reset view goes back to 100 %, and through all of it the address never changed
      await page.click("[data-act=reset]");
      assert.equal(await level(), "100%");
      assert.equal(await page.evaluate("location.hash"), hash0);
      // selecting still works zoomed (the click lands on the node it shows)
      await page.click("[data-act=fit]");
      await page.click(".ds-node[data-id='vo:1']");
      await page.waitForFunction("location.hash.includes('sel=vo')");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);

test(
  "map zoom: opening and collapsing groups while zoomed in keeps every box its real size (regression: heights were measured in zoomed pixels and grew)",
  { skip, timeout: 90_000 },
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
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const page = await (
      await browser.newContext({ viewport: { width: 1400, height: 900 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // the height each box was laid out with (its inline min-block-size), and how many boxes there are
    const heights = () =>
      page.evaluate(
        "Object.fromEntries([...document.querySelectorAll('.ds-node')].map((e) => [e.dataset.id, e.style.minBlockSize]))",
      ) as Promise<Record<string, string>>;
    const count = () => page.locator(".ds-node").count();
    // what is in the middle of the view, in the graph's own units (it must stay there when zooming)
    const middle = () =>
      page.evaluate(`(() => {
        const c = document.querySelector('.ds-map-canvas');
        const z = Number.parseInt(document.querySelector('[data-zoom]').textContent) / 100;
        return { x: (c.scrollLeft + c.clientWidth / 2) / z, y: (c.scrollTop + c.clientHeight / 2) / z };
      })()`) as Promise<{ x: number; y: number }>;
    try {
      await page.goto(`${panel.url}#/map`);
      await page.waitForSelector(".ds-map .ds-node");
      // zooming keeps the middle of the view in the middle, also for a held key
      const m0 = await middle();
      for (let i = 0; i < 5; i++) await page.keyboard.press("+");
      await page.waitForFunction(
        "Number.parseInt(document.querySelector('[data-zoom]').textContent) > 150",
      );
      await page.waitForTimeout(200);
      const m1 = await middle();
      assert.ok(
        Math.abs(m1.x - m0.x) < 4 && Math.abs(m1.y - m0.y) < 4,
        `middle ${JSON.stringify(m0)} → ${JSON.stringify(m1)}`,
      );
      await page.click("[data-act=reset]");
      const base = await heights();
      const closed = await count();
      for (const zoom of [1.2, 1.6]) {
        await page.click("[data-act=reset]");
        await page.waitForFunction(
          "document.querySelector('[data-zoom]').textContent.trim() === '100%'",
        );
        while (Number.parseInt(await page.innerText("[data-zoom]")) < zoom * 100 - 1)
          await page.keyboard.press("+");
        // open the drafts group, then collapse everything again, at this zoom
        await page.evaluate("location.hash = '#/map?open=drafts%3Arender%3Aannotations%3A1'");
        await page.waitForFunction(`document.querySelectorAll('.ds-node').length > ${closed}`);
        await page.waitForTimeout(300);
        const opened = await heights();
        for (const [id, h] of Object.entries(base))
          if (id in opened) assert.equal(opened[id], h, `${id} at ${zoom * 100}%: opened`);
        await page.click("[data-act=collapse]");
        await page.waitForFunction(`document.querySelectorAll('.ds-node').length === ${closed}`);
        await page.waitForTimeout(300);
        const collapsed = await heights();
        assert.deepEqual(collapsed, base, `at ${zoom * 100}% every box is exactly as at 100%`);
        // and the zoom is still where it was (nothing reset it)
        assert.ok(Number.parseInt(await page.innerText("[data-zoom]")) >= zoom * 100 - 1);
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
