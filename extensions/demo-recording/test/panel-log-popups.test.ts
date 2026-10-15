/**
 * Panel log popups (bugfix sprint): the Live panel's Log header opens the full
 * log in a popup at 80 % of the window (filterable), a click on any log line
 * opens that event whole (time, type, project, message, data), Esc closes only
 * the top-most popup, a click outside closes it. Popups render on <body>, so
 * the Live panel's CSS container can't trap them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";

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
  "log popups: full log at 80 %, filter, a line opens whole, Esc closes the top popup",
  { skip: !browserType && "needs Playwright Chromium", timeout: 60_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-logpop-"));
    ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    rt.setActiveProject("p");
    const panel = await rt.ensurePanel();
    for (let i = 0; i < 30; i++)
      rt.bus.publish(
        "render.progress",
        { done: i, total: 30, label: `step ${i}`, message: `🎞 step ${i}` },
        "p",
      );
    rt.bus.publish(
      "render.finished",
      {
        version: 7,
        kind: "final",
        message: "final render v7 ready",
        detail: { nested: [1, 2, 3] },
      },
      "p",
    );
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
      await page.goto(panel.url);
      await page.waitForSelector(".ds-strip");
      await page.locator(".ds-strip button[aria-controls=activity]").click(); // the drawer holds the log
      await page.waitForSelector("aside#activity .log li");
      // the header opens the full log at 80 % of the window
      await page.locator(".log-head").click();
      const big = page.locator(".modal.large");
      await big.waitFor();
      const box = await big.boundingBox();
      assert.ok(
        box && Math.abs(box.width - 1200) <= 2 && Math.abs(box.height - 800) <= 2,
        `80 % × 80 %: ${box?.width}×${box?.height}`,
      );
      // the 30 progress ticks of the job are one line (its newest state) …
      assert.equal(await big.locator(".log li .ticks").count(), 1, "one collapsed progress line");
      assert.equal(await big.locator(".log li .ticks").innerText(), "×30");
      assert.match(
        await big.locator(".log li", { has: page.locator(".ticks") }).innerText(),
        /step 29/,
      );
      assert.equal(
        await page.locator("aside#activity .log li .ticks").innerText(),
        "×30",
        "the side log too",
      );
      // … until "show all progress" shows every tick
      await big.getByLabel("show all progress").check();
      await page.waitForFunction(`document.querySelectorAll(".modal.large .log li").length >= 31`);
      assert.ok(
        (await big.locator(".log li").count()) >= 31,
        "every event, not only the side panel's tail",
      );
      assert.equal(await big.locator(".log li .ticks").count(), 0);
      // filter
      await page.getByRole("searchbox", { name: "filter the log" }).fill("v7 ready");
      await page.waitForFunction(`document.querySelectorAll(".modal.large .log li").length === 1`);
      assert.match(
        await big.locator(".modal-head h2").innerText(),
        /Log · 1 line\(s\) · \d+ event\(s\)/,
      );
      // a line opens on top, with the whole event
      await big.locator(".log li").first().click();
      const one = page.locator(".modal.medium");
      await one.waitFor();
      assert.equal(await one.locator(".modal-head h2").innerText(), "render.finished");
      const json = await one.locator(".log-json").innerText();
      assert.match(
        json,
        /"nested": \[\s*1,\s*2,\s*3\s*\]/,
        "the full data, not the one-line summary",
      );
      assert.match(await one.locator(".log-detail").innerText(), /Message\s+final render v7 ready/);
      // Esc closes only the top popup, then the next
      await page.keyboard.press("Escape");
      await page.waitForFunction(`!document.querySelector(".modal.medium")`);
      assert.equal(await page.locator(".modal.large").count(), 1, "the full log stays open");
      await page.keyboard.press("Escape");
      await page.waitForFunction(`!document.querySelector(".modal-backdrop")`);
      // a line in the side panel directly; a click outside closes
      await page.locator("aside#activity .log li").last().click();
      await page.locator(".modal.medium").waitFor();
      await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
      await page.waitForFunction(`!document.querySelector(".modal-backdrop")`);
    } finally {
      await browser.close();
      await panel.close();
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
