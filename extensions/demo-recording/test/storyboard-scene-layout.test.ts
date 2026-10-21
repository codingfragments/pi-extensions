/**
 * Item 13d (R3-1, D146): on the Storyboard the scene's picture is on the LEFT and all the text on the RIGHT, side by side while the workspace is wide enough for
 * the list plus both (64rem), stacked (picture first) below that, and a scene without a picture uses the full width for the text. Nothing is sticky.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import { appDir } from "../src/workdir/layout.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

// a 1 x 1 JPEG: the layout does not depend on the picture's own size (the column is a grid track, the image is capped at its width)
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

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
  "the scene's picture left and the text right when wide, stacked when narrow, text only without a picture",
  { skip: !browserType && "needs Playwright Chromium", timeout: 150_000 },
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
    const shots = path.join(
      appDir(seed.root, rt.activeProject()?.app.slug as string),
      "discovery",
      "sess",
      "screens",
    );
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, "s007.jpg"), JPEG);
    writeStoryboard(
      seed.dir,
      "version: 3\napp: keycraft\nstart_url: /\nscenes:\n  - id: with-pic\n    title: With a picture\n    screen: 20260612-101233/s007\n    takeaway: The headline number\n    steps:\n      - { do: pause, ms: 100 }\n  - id: no-pic\n    title: Without a picture\n    steps:\n      - { do: pause, ms: 100 }\n",
    );
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const box = (page: import("playwright").Page, sel: string) =>
        page.evaluate(
          `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })()`,
        ) as Promise<{
          left: number;
          right: number;
          top: number;
          bottom: number;
          width: number;
        } | null>;
      for (const [width, side] of [
        [1400, true],
        [1000, false],
      ] as const) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`${panel.url}#/storyboard/v3`);
        await page.waitForSelector(".ds-sb-scene");
        const pic = await box(page, ".ds-sb-pic");
        const text = await box(page, ".ds-sb-text");
        assert.ok(pic && text, `${width}: both parts exist`);
        if (side) {
          assert.ok(
            (pic?.right ?? 0) <= (text?.left ?? 0) + 1,
            `${width}: the picture is left of the text`,
          );
          assert.ok(
            Math.abs((pic?.top ?? 0) - (text?.top ?? 0)) < 4,
            `${width}: side by side, same top`,
          );
          assert.ok(
            (text?.width ?? 0) > (pic?.width ?? 0),
            `${width}: the text gets the larger share`,
          );
        } else {
          assert.ok(
            (pic?.bottom ?? 0) <= (text?.top ?? 0) + 1,
            `${width}: stacked, the picture first`,
          );
        }
        // everything that is text is in the right-hand part: the title, the takeaway, the steps, the review buttons and the notes box
        for (const sel of [
          "h2",
          ".takeaway",
          ".steps",
          ".ds-review [data-status]",
          "textarea[aria-label='Notes for this scene']",
        ])
          assert.ok(
            (await page.locator(`.ds-sb-text ${sel}`).count()) >= 1,
            `${width}: ${sel} is in the text part`,
          );
        assert.equal(await page.locator(".ds-sb-pic img").count(), 1);
        assert.equal(
          await page.evaluate("!!document.querySelector('.ds-sb-pic').closest('.ds-sb-text')"),
          false,
        );
        // nothing sticky, nothing scrolling on its own (D145)
        assert.equal(
          await page.evaluate(
            `[...document.querySelectorAll('.ds-sb-scene, .ds-sb-scene *')].filter((e) => getComputedStyle(e).position === 'sticky').length`,
          ),
          0,
        );
        // a scene without a picture: one column, the text, and a line that says so
        await page.locator(".ds-split-list .ds-item", { hasText: "Without a picture" }).click();
        await page.waitForSelector(".ds-sb-scene[data-pic=no]");
        assert.equal(await page.locator(".ds-sb-pic").count(), 0);
        assert.match(
          await page.locator(".ds-sb-text").innerText(),
          /No screenshot for this scene\./,
        );
        const only = await box(page, ".ds-sb-text");
        const scene = await box(page, ".ds-sb-scene");
        assert.ok(
          Math.abs((only?.width ?? 0) - ((scene?.width ?? 0) - 2 * 16)) < 40,
          `${width}: the text uses the full width (${only?.width} of ${scene?.width})`,
        );
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
