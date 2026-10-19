/**
 * The list + inspector screens (Voice over, Storyboard, Annotations; the Brands editor shares the layout): the list is 22rem wide, a row's text wraps
 * and never runs into the detail, and the detail column stays pinned just below the header while a long list scrolls, until the list ends
 * (D-R2-6, R2-5, R2-9). Measured with 40 rows of long text at 1400 and 900 px; below the narrow threshold the list is a select and nothing is pinned.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
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

const LONG =
  "a-very-long-name-for-this-row-that-has-to-wrap-inside-the-list-and-never-run-into-the-detail-column-on-the-right";
const N = 40;
const pad = (i: number) => String(i + 1).padStart(2, "0");

/** The seeded project with a 40-row list on each screen. */
function inflate(dir: string) {
  writeStoryboard(
    dir,
    `version: 3\napp: keycraft\nstart_url: /\nscenes:\n${Array.from({ length: N }, (_, i) => `  - id: s${pad(i)}\n    title: "${i + 1} ${LONG}"\n    steps:\n      - { do: pause, ms: 100 }\n`).join("")}`,
  );
  fs.writeFileSync(
    path.join(dir, "vo", "script.v9.md"),
    `---\ntake: take-001\n---\n${Array.from({ length: N }, (_, i) => `## s${pad(i)}-${LONG}\nSome narration for row ${i + 1}.\n`).join("\n")}`,
  );
  // the seeded annotation file, its first item repeated with long text (the shape the panel accepts)
  const seeded = JSON.parse(fs.readFileSync(path.join(dir, "annotations", "v1.json"), "utf8"));
  fs.writeFileSync(
    path.join(dir, "annotations", "v9.json"),
    JSON.stringify({
      ...seeded,
      version: 9,
      items: Array.from({ length: N }, (_, i) => ({
        ...seeded.items[0],
        id: `c${pad(i)}`,
        type: "callout",
        text: `${i + 1} the churn chart and the EMEA outlier, worth a look`.slice(0, 60), // the longest a callout may be
        reason: LONG,
      })),
    }),
  );
}

type Box = { top: number; bottom: number; right: number; width: number };
const SCREENS = [
  {
    name: "voice",
    hash: "#/voice/v9",
    row: ".ds-split-list .ds-item",
    inspector: ".ds-detail-pin",
  },
  {
    name: "storyboard",
    hash: "#/storyboard/v3",
    row: ".ds-split-list .ds-item",
    inspector: ".ds-detail-pin",
  },
  {
    name: "annotations",
    hash: "#/annotations/v9",
    row: ".ds-split-list .ds-item",
    inspector: ".ds-detail-pin",
  },
] as const;

test(
  "list screens: 22rem list, wrapping text that never reaches the detail, the detail pinned while 40 rows scroll and released after the last",
  { skip: !browserType && "needs Playwright Chromium", timeout: 240_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    inflate(seed.dir);
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
      for (const width of [1400, 900]) {
        for (const s of SCREENS) {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          const where = `${s.name} at ${width}`;
          await page.goto(`${panel.url}${s.hash}`);
          await page
            .locator(s.row)
            .nth(N - 1)
            .waitFor();
          await page.waitForFunction(
            "getComputedStyle(document.documentElement).getPropertyValue('--hwrap-h') === document.querySelector('.ds-hwrap').getBoundingClientRect().height + 'px'",
          );
          const box = async (sel: string): Promise<Box> =>
            (await page.evaluate(
              `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, width: r.width }; })()`,
            )) as Box;
          const head = (await page.evaluate(
            "document.querySelector('.ds-hwrap').getBoundingClientRect().height",
          )) as number;

          // the list is 22rem (352 px)
          const list = await box(".ds-split-list");
          assert.ok(
            Math.abs(list.width - 352) <= 2,
            `${where}: the list is ${list.width}px wide, not 22rem`,
          );
          // nothing in the list reaches past its right edge, and long text wrapped (more than one line) but is cut at three
          const out = (await page.evaluate(`(() => {
            const L = document.querySelector('.ds-split-list').getBoundingClientRect();
            const over = [...document.querySelectorAll('.ds-split-list *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > L.right + 1; }).map((e) => e.className);
            const titles = [...document.querySelectorAll('.ds-split-list .ds-item-title')].map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
            return { over: over.slice(0, 5), maxLines: Math.max(...titles), minLines: Math.min(...titles) };
          })()`)) as { over: string[]; maxLines: number; minLines: number };
          assert.deepEqual(out.over, [], `${where}: nothing runs past the list`);
          assert.ok(
            out.maxLines >= 2 && out.maxLines <= 3,
            `${where}: long titles wrap to 2 or 3 lines (${out.maxLines})`,
          );

          // pinned while the list scrolls
          const pin = s.inspector;
          const natural = await box(pin);
          assert.ok(natural.top >= head, `${where}: the detail starts below the header`);
          let pinnedAt = 0;
          const splitTop =
            ((await box(".ds-split")).top as number) + ((await page.evaluate("scrollY")) as number);
          for (const y of [splitTop + 100, splitTop + 900, splitTop + 1900]) {
            await page.evaluate(`window.scrollTo(0, ${y})`);
            const r = await box(pin);
            const listBottom = (await box(".ds-split-list")).bottom;
            assert.ok(
              r.top >= head + 8 - 3,
              `${where} at scroll ${y}: the detail (top ${r.top}) is never under the header (${head})`,
            );
            if (listBottom > r.bottom + 60) {
              assert.ok(
                Math.abs(r.top - (head + 8)) <= 3,
                `${where} at scroll ${y}: pinned at ${r.top}, the pin line is ${head + 8}`,
              );
              pinnedAt++;
            }
            // it never grows past the window: header, the detail, and room for the strip (and the action bar where there is one)
            assert.ok(
              r.bottom <= 800 - 40,
              `${where} at scroll ${y}: the detail reaches ${r.bottom}, below the strip`,
            );
          }
          assert.ok(
            pinnedAt >= 2,
            `${where}: the detail was pinned at ${pinnedAt} of the scroll positions`,
          );
          // released at the end of the list
          await page.evaluate(
            "document.documentElement.scrollTo(0, document.documentElement.scrollHeight)",
          );
          const end = await box(pin);
          const split = await box(".ds-split");
          assert.ok(
            end.bottom <= split.bottom + 1,
            `${where}: the detail ends with the list (${end.bottom} vs ${split.bottom})`,
          );
          if (process.env.P3_SHOTS && s.name === "annotations" && width === 1400) {
            await page.evaluate("window.scrollTo(0, 900)");
            await page.screenshot({ path: `${process.env.P3_SHOTS}-${s.name}-${width}.png` });
          }
          await page.close();
        }
      }
      // narrow: the list is a select, and nothing is pinned
      const narrow = await browser.newPage({ viewport: { width: 700, height: 800 } });
      await narrow.goto(`${panel.url}#/voice/v9`);
      await narrow.waitForSelector(".ds-split-bar select");
      assert.equal(await narrow.locator(".ds-split-list").isVisible(), false);
      assert.equal(
        await narrow.evaluate(
          "getComputedStyle(document.querySelector('.ds-detail-pin')).position",
        ),
        "static",
        "below the narrow threshold the detail is the page, not pinned",
      );
      await narrow.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
