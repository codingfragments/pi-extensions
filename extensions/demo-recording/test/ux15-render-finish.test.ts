/**
 * UX15: the two Render things the UX0 mock had and the first build left out: a Full video / Scenes switch above the
 * player (instead of a disclosure per variant), and a Download menu in the decision bar that follows what is playing.
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
  "Render: Full video / Scenes switch above the player, and a Download menu in the bar that follows what is playing",
  { skip, timeout: 120_000 },
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
      await browser.newContext({ viewport: { width: 1400, height: 1100 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    await page.route("**/api/render-zip", async (r) => {
      posts.push({ path: "render-zip", body: r.request().postDataJSON() });
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"zip":"render/v2/neutral.zip"}',
      });
    });
    await page.route("**/api/render-open", async (r) => {
      posts.push({ path: "render-open", body: r.request().postDataJSON() });
      await r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const videoSrc = () =>
      page.evaluate(
        "document.querySelector('.flavor-player video')?.getAttribute('src') ?? ''",
      ) as Promise<string>;
    try {
      await page.goto(`${panel.url}#/render/v2`);
      await page.waitForSelector(".flavor-switch");
      // the switch: full video by default; the scenes are one click away; no disclosure rows in the table any more
      assert.equal(await page.getAttribute("[data-mode=full]", "aria-pressed"), "true");
      assert.equal(await page.getAttribute("[data-mode=scenes]", "aria-pressed"), "false");
      assert.match(await page.innerText("[data-mode=scenes]"), /Scenes · 1/);
      assert.match(await videoSrc(), /full\.mp4/);
      assert.equal(await page.locator(".fv-toggle").count(), 0);
      assert.equal(await page.locator(".flavor-scenes").count(), 0);
      await page.click("[data-mode=scenes]");
      await page.waitForSelector(".flavor-scenes [data-scene]");
      assert.match(await videoSrc(), /01-dash\.mp4/);
      assert.equal(await page.getAttribute("[data-mode=scenes]", "aria-pressed"), "true");
      assert.equal(await page.locator(".flavor-scenes [aria-pressed=true]").count(), 1);
      // the Download menu: opens upward from the bar, lists what is playing, follows the switch
      await page.click("[data-act=download]");
      const menu = page.locator(".render-download > ul");
      await menu.waitFor();
      const box = (await menu.boundingBox()) as { y: number; height: number };
      const sum = (await page.locator("[data-act=download]").boundingBox()) as { y: number };
      assert.ok(box.y + box.height <= sum.y + 2, "opens upward, not under the bar");
      const links = (await page.evaluate(
        "[...document.querySelectorAll('.render-download > ul a')].map((e) => [e.textContent.trim(), e.getAttribute('href'), e.getAttribute('download')])",
      )) as string[][];
      assert.ok(
        links.some(
          ([t, h, d]) =>
            /Video/.test(t as string) && /01-dash\.mp4/.test(h as string) && d === "01-dash.mp4",
        ),
        JSON.stringify(links),
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.locator(".render-download").getAttribute("open"),
        null,
        "Escape closes it",
      );
      await page.click("[data-mode=full]");
      await page.click("[data-act=download]");
      const full = (await menu.locator("a").allInnerTexts()).join(" | ");
      assert.match(full, /Video \(mp4\)[\s\S]*full\.mp4/);
      assert.match(full, /Transcript \(vtt\)[\s\S]*full\.vtt/);
      assert.match(full, /Poster[\s\S]*poster\.jpg/);
      // the zip and the folder go through the same routes as the table's buttons
      await page.click("[data-act=download-zip]");
      for (let i = 0; i < 100 && !posts.some((p) => p.path === "render-zip"); i++)
        await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(posts.find((p) => p.path === "render-zip")?.body, {
        version: 2,
        variant: "neutral",
      });
      await page.click("[data-act=download]");
      await page.click("[data-act=open-folder]");
      for (let i = 0; i < 100 && !posts.some((p) => p.path === "render-open"); i++)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(posts.find((p) => p.path === "render-open")?.body.version, 2);
      // a run without files has no Download
      await page.goto(`${panel.url}#/render/v3`);
      await page.waitForSelector(".ds-inspector[data-version='3']");
      assert.equal(await page.locator("[data-act=download]").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
