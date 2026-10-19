/**
 * The Activity drawer is docked (D135, R2-12): beside the main content, which gets narrower; the header, the band and the strip keep the full width;
 * 22rem; Render keeps its two columns; below about 76rem it is an overlay again; it never opens by itself and is remembered as you left it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { qaFile } from "../src/qa/run.ts";
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

type Geo = {
  vw: number;
  header: number;
  strip: number;
  main: number;
  mainRight: number;
  drawerLeft: number;
  drawerTop: number;
  drawerBottom: number;
  stripTop: number;
  headerBottom: number;
  position: string;
  cols: number;
};
const geo = (page: import("playwright").Page) =>
  page.evaluate(`(() => {
    const b = (s) => document.querySelector(s).getBoundingClientRect();
    const d = document.querySelector('aside#activity');
    const r = d && !d.hidden ? d.getBoundingClientRect() : null;
    const g = document.querySelector('.render-detail-grid');
    return { vw: innerWidth, header: b('.ds-hwrap').width, strip: b('.ds-strip').width, main: b('main').width, mainRight: b('main').right,
      drawerLeft: r ? r.left : -1, drawerTop: r ? r.top : -1, drawerBottom: r ? r.bottom : -1, stripTop: b('.ds-strip').top, headerBottom: b('.ds-hwrap').bottom,
      position: d ? getComputedStyle(d).position : '', cols: g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0 };
  })()`) as Promise<Geo>;

test(
  "docked drawer: the main content gets narrower, header and strip keep the full width, Render keeps two columns, small windows overlay",
  { skip: !browserType && "needs Playwright Chromium", timeout: 180_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
    fs.writeFileSync(
      qaFile(seed.dir, 1),
      JSON.stringify({
        render: 1,
        stage: "render",
        version: 1,
        variant: "neutral",
        createdAt: "2026-10-18T10:00:00.000Z",
        whisper: true,
        items: [
          {
            id: "drift-1",
            check: "drift",
            level: "warning",
            scene: "01-dash",
            message: "the narration starts late",
            identity: { anchor: "m1" },
          },
        ],
      }),
    );
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
      for (const width of [1400, 1280, 1100, 900]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await ctx.newPage();
        const where = `at ${width}`;
        await page.goto(`${panel.url}#/render/v1`);
        await page.waitForSelector(".render-detail-grid");
        // closed: nothing reserved, and it did not open by itself
        const closed = await geo(page);
        assert.equal(closed.drawerLeft, -1, `${where}: closed by default`);
        assert.equal(closed.main, closed.vw, `${where}: the main content has the whole width`);
        await page.click(".ds-strip button[aria-controls=activity]");
        await page.waitForSelector("aside#activity", { state: "visible" });
        const open = await geo(page);
        assert.equal(open.header, width, `${where}: the header keeps the full width`);
        assert.equal(open.strip, width, `${where}: the strip keeps the full width`);
        if (width >= 1216) {
          assert.equal(open.position, "sticky", `${where}: docked`);
          assert.ok(
            Math.abs(closed.main - open.main - 352) <= 1,
            `${where}: the main content is 22rem narrower (${closed.main} to ${open.main})`,
          );
          assert.ok(
            open.mainRight <= open.drawerLeft + 1,
            `${where}: nothing of the main content is under the drawer`,
          );
          assert.ok(
            Math.abs(open.drawerTop - open.headerBottom) <= 1,
            `${where}: the drawer starts below the header`,
          );
          assert.ok(
            Math.abs(open.drawerBottom - open.stripTop) <= 1,
            `${where}: the drawer ends at the strip`,
          );
          if (width >= 1280)
            assert.equal(
              open.cols,
              2,
              `${where}: Render keeps its two columns while Activity is open`,
            );
        } else {
          assert.equal(
            open.position,
            "fixed",
            `${where}: below about 76rem the drawer is an overlay`,
          );
          assert.equal(open.main, closed.main, `${where}: an overlay does not narrow the page`);
        }
        await ctx.close();
      }
      // nothing the main content shows is hidden behind the docked drawer: the pinned preview and the buttons stay in the main column
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${panel.url}#/render/v1`);
      await page.click(".ds-strip button[aria-controls=activity]");
      await page.waitForSelector("aside#activity", { state: "visible" });
      const right = (await page.evaluate(
        `Math.max(...[...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().width).map((e) => e.getBoundingClientRect().right))`,
      )) as number;
      const left = (await page.evaluate(
        "document.querySelector('aside#activity').getBoundingClientRect().left",
      )) as number;
      assert.ok(
        right <= left + 1,
        `no element of the main content reaches under the drawer (${right} vs ${left})`,
      );
      if (process.env.P4_SHOTS)
        await page.screenshot({ path: `${process.env.P4_SHOTS}-drawer-1400.png` });
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);

test(
  "the drawer is remembered as you left it, never opened by the system, and an error does not open it",
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
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".ds-strip");
      assert.equal(
        await page.locator("aside#activity").isVisible(),
        false,
        "a first visit: closed",
      );
      // a failing job never opens it
      rt.bus.publish(
        "edit.finished",
        { status: "failed", message: "edit failed: something broke" },
        seed.slug,
      );
      await page.waitForTimeout(400);
      assert.equal(
        await page.locator("aside#activity").isVisible(),
        false,
        "an error does not open it",
      );
      // open it, reload: it is open, without taking the focus; close it, reload: closed
      await page.click(".ds-strip button[aria-controls=activity]");
      await page.waitForSelector("aside#activity", { state: "visible" });
      assert.equal(await page.evaluate("localStorage.getItem('demo-rec-activity')"), "open");
      await page.reload();
      await page.waitForSelector("aside#activity", { state: "visible" });
      assert.equal(
        await page.evaluate("document.activeElement?.closest('aside#activity') !== null"),
        false,
        "restored without taking the focus",
      );
      await page.click("aside#activity button[aria-label='Close activity']");
      assert.equal(await page.evaluate("localStorage.getItem('demo-rec-activity')"), "closed");
      await page.reload();
      await page.waitForSelector(".ds-strip");
      assert.equal(
        await page.locator("aside#activity").isVisible(),
        false,
        "closed after a reload when you closed it",
      );
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
