/**
 * Item 10, D4 (F3): the live preview opens in a bigger window that keeps updating. It renders the same source as the small one
 * (the newest discovery screen, or the polled live frame of a take being recorded), so it is not a snapshot of the click.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { Runtime } from "../src/runtime.ts";
import { appDir } from "../src/workdir/layout.ts";
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
const skip = (!browserType || !hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

test(
  "the enlarged preview: opens from the small one, shows the same screen, follows the next one, Escape closes and focus returns",
  { skip, timeout: 90_000 },
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
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    // two real screens of the app, as discovery stores them
    const app = appDir(seed.root, rt.requireProject().app.slug);
    const shots = path.join(app, "discovery", "d-1", "screens");
    fs.mkdirSync(shots, { recursive: true });
    for (const [name, hue] of [
      ["s001", 0],
      ["s002", 120],
    ] as const)
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=1:duration=1",
        "-vf",
        `hue=h=${hue}`,
        "-frames:v",
        "1",
        path.join(shots, `${name}.jpg`),
      ]);
    const look = (n: string, title: string) =>
      rt.bus.publish(
        "discovery.look",
        {
          screen: `d-1/${n}`,
          url: "https://k.example/",
          title,
          media: `discovery/d-1/screens/${n}.jpg`,
          message: `look ${n}`,
        },
        seed.slug,
      );
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/project`);
      await page.click("button:has-text('Activity')");
      await page.waitForSelector("#activity .ds-drawer-body");
      assert.match(
        await page.locator("#activity [aria-label=Preview]").innerText(),
        /no frame yet/,
        "nothing to show before discovery",
      );
      assert.equal(
        await page.locator("[data-act=enlarge-preview]").count(),
        0,
        "nothing to enlarge yet",
      );
      look("s001", "Home");
      await page.waitForSelector("[data-act=enlarge-preview]");
      const small = await page.evaluate(
        "document.querySelector('[data-act=enlarge-preview] img').getBoundingClientRect().width",
      );
      assert.match(await page.locator("#activity figcaption").innerText(), /d-1\/s001 · Home/);
      // open it: a window with the same screen, bigger
      await page.focus("[data-act=enlarge-preview]");
      await page.click("[data-act=enlarge-preview]");
      await page.waitForSelector("[data-live-big]");
      assert.match(
        await page
          .locator(".modal [role=dialog], .modal")
          .first()
          .getAttribute("aria-label")
          .then((x) => x ?? ""),
        /Live preview/,
      );
      const big = await page.evaluate(
        "document.querySelector('[data-live-big] img').getBoundingClientRect().width",
      );
      assert.ok(
        (big as number) > (small as number) * 1.5,
        `the big picture is ${big}px, the small one ${small}px`,
      );
      await page.waitForFunction(
        "document.querySelector('[data-live-big] img')?.complete && document.querySelector('[data-live-big] img').naturalWidth > 0",
      );
      assert.match(
        await page.locator("[data-live-big] figcaption").innerText(),
        /d-1\/s001 · Home/,
      );
      const srcBefore = await page.locator("[data-live-big] img").getAttribute("src");
      // the next screen arrives while it is open: the big picture follows, it is not a frozen snapshot
      look("s002", "Search results");
      await page.waitForFunction(
        "/s002/.test(document.querySelector('[data-live-big] img')?.getAttribute('src') ?? '')",
      );
      assert.notEqual(await page.locator("[data-live-big] img").getAttribute("src"), srcBefore);
      assert.match(
        await page.locator("[data-live-big] figcaption").innerText(),
        /d-1\/s002 · Search results/,
      );
      assert.match(
        await page.locator("#activity figcaption").innerText(),
        /s002/,
        "and so does the small one behind it",
      );
      // Escape closes it and the focus is back on the small preview
      await page.keyboard.press("Escape");
      await page.waitForSelector("[data-live-big]", { state: "detached" });
      await page.waitForFunction("document.activeElement?.dataset?.act === 'enlarge-preview'");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
