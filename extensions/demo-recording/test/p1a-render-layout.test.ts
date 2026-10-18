/**
 * The Render screen's preview: about two fifths of the width, pinned just below the header while the quality check's findings scroll,
 * released when they end; a draft (no quality check) keeps its single wide player; the variants table sits below, full width.
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

const MANY = Array.from({ length: 40 }, (_, i) => ({
  id: `drift-${i + 1}`,
  check: "drift",
  level: "warning",
  high: i % 3 === 0,
  scene: "01-dash",
  atMs: 1000 + i * 100,
  message: `the narration for @m${i + 1} starts ${300 + i} ms after its moment (finding number ${i + 1})`,
  identity: { anchor: `m${i + 1}` },
}));

type Box = { top: number; bottom: number; left: number; width: number; height: number };

test(
  "Render: the preview is about two fifths wide, stays pinned while 40 findings scroll, and scrolls away after the last one",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
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
        items: MANY,
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
      for (const [width, wide] of [
        [1400, true],
        [900, false],
      ] as const) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        await page.goto(`${panel.url}#/render/v1`);
        await page.locator(".qa-item").nth(39).waitFor();
        const box = async (sel: string): Promise<Box> =>
          (await page.evaluate(
            `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; })()`,
          )) as Box;
        const head = (await page.evaluate(
          "document.querySelector('.ds-hwrap').getBoundingClientRect().height",
        )) as number;
        // the header's height is published for what sticks below it, and follows the band as it appears
        await page.waitForFunction(
          "getComputedStyle(document.documentElement).getPropertyValue('--hwrap-h') === document.querySelector('.ds-hwrap').getBoundingClientRect().height + 'px'",
        );
        const pin = wide ? ".render-player-pin" : ".render-player-col";
        const video = `${pin} video`;
        // the width
        const v0 = await box(video);
        if (wide) {
          assert.ok(
            v0.width / width >= 0.3 && v0.width / width <= 0.42,
            `the video is ${Math.round((v0.width / width) * 100)}% of the width`,
          );
        } else {
          assert.ok(v0.height <= 800 * 0.34 + 2, `compact in one column: ${v0.height}px high`);
        }
        // the QA list is taller than the window, so the page scrolls
        const scrollY = async () => (await page.evaluate("scrollY")) as number;
        const qaBottom = async () => (await box(".qa-section")).bottom + (await scrollY());
        const total = (await page.evaluate("document.documentElement.scrollHeight")) as number;
        assert.ok(total > 800 * 2, `a long page (${total}px)`);
        // scrolling through the findings: the player never rises above its pin line, and once it reaches it, it stays there
        for (const y of [400, 900, 1400]) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          const r = await box(pin);
          assert.ok(
            r.top >= head + 8 - 3,
            `at scroll ${y} the player (top ${r.top}) is never under the header (${head})`,
          );
          const stillInList = (await qaBottom()) - y > r.height + head + 40;
          if (y >= 900 && stillInList)
            assert.ok(
              Math.abs(r.top - (head + 8)) <= 3,
              `at scroll ${y} the player's top is ${r.top} (pin line ${head + 8})`,
            );
        }
        // the whole player (switch, scene chips, video, caption) is visible while pinned
        await page.evaluate("window.scrollTo(0, 900)");
        const pinned = await box(pin);
        assert.ok(
          pinned.bottom <= 800 && pinned.top >= head,
          `fully visible: ${pinned.top}..${pinned.bottom}`,
        );
        assert.ok(
          (await page.locator(`${pin} .flavor-switch`).isVisible()) &&
            (await page.locator(`${pin} video`).isVisible()),
        );
        // past the end of the findings it scrolls off with them
        await page.evaluate(
          "document.documentElement.scrollTo(0, document.documentElement.scrollHeight)",
        );
        const end = await box(pin);
        const grid = await box(".render-detail-grid");
        assert.ok(
          end.bottom <= grid.bottom + 1,
          `the player ends with the findings' grid (${end.bottom} vs ${grid.bottom})`,
        );
        // the variants table is below the grid, full width, and not pinned
        const variants = await box(".flavor-table");
        assert.ok(
          variants.top >= grid.bottom - 2,
          "the variants table is below the player and the findings",
        );
        assert.ok(
          variants.width > (await box(pin)).width * (wide ? 1.8 : 0.95),
          `the variants table is wider than the player (${variants.width})`,
        );
        if (process.env.P1A_SHOTS && wide) {
          await page.evaluate("window.scrollTo(0, 700)");
          await page.screenshot({ path: `${process.env.P1A_SHOTS}-layout-${width}.png` });
        }
        await page.close();
      }
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);

test(
  "Render: a draft (no quality check) keeps its single wide player, not pinned",
  { skip: !browserType && "needs Playwright Chromium", timeout: 60_000 },
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
      const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
      const drafts = fs
        .readdirSync(path.join(seed.dir, "render"))
        .filter((f) => /^v\d+\.json$/.test(f))
        .map((f) => JSON.parse(fs.readFileSync(path.join(seed.dir, "render", f), "utf8")))
        .filter((r) => r.kind === "draft" && r.status === "done");
      assert.ok(drafts.length, "the seed has a finished draft");
      await page.goto(`${panel.url}#/render/v${drafts[0].version}`);
      await page.locator(".render-detail-grid.solo .render-player-pin").waitFor();
      assert.equal(
        await page.evaluate(
          "getComputedStyle(document.querySelector('.render-player-pin')).position",
        ),
        "static",
      );
      assert.equal(await page.locator(".qa-section").count(), 0);
      assert.ok(
        ((await page.evaluate(
          "document.querySelector('.render-player-pin video').getBoundingClientRect().width",
        )) as number) > 600,
        "as wide as before",
      );
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
