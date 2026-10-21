/**
 * The storyboard tab says how long the storyboard takes to record, against the length the brief asks for.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { storyboardTiming, timingVerdict } from "../src/storyboard/timing.ts";
import { setBriefFacts } from "../src/workdir/brief.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const SB = `start_url: /
scenes:
  - id: 01-a
    title: A
    steps:
      - { do: pause, ms: 10s }
      - { do: wait, for: { css: .x }, timeout: 10s }
  - id: 02-b
    title: B
    steps:
      - { do: pause, ms: 20s }
`;

test("the projection: the scenes' steps by the recorder's own estimates plus the lead-in and the tail, open waits named", () => {
  const sb = parseStoryboard(SB, { version: 1 });
  const t = storyboardTiming(sb);
  assert.deepEqual(
    t.scenes.map((s) => [s.id, s.steps]),
    [
      ["01-a", 2],
      ["02-b", 1],
    ],
  );
  assert.equal(t.scenes[1]?.ms, 20_000, "a pause is its length");
  assert.equal(t.scenes[0]?.ms, 10_000 + 1500 + 600, "a pause, a wait at 1.5 s and its dwell");
  assert.equal(t.totalMs, 10_000 + 2100 + 20_000 + 700 + 900);
  assert.equal(t.openWaits, 1);
  assert.equal(t.verdict, "no-target");
  assert.equal(t.target, undefined);
});

test("against a target: short under 70 % of its low end, long over 115 % of its high end, else it fits; the last take is carried along", () => {
  assert.equal(timingVerdict(100_000, { lo: 600, hi: 720 }), "short");
  assert.equal(timingVerdict(420_000, { lo: 600, hi: 720 }), "fits", "exactly 70 %");
  assert.equal(timingVerdict(800_000, { lo: 600, hi: 720 }), "fits");
  assert.equal(timingVerdict(830_000, { lo: 600, hi: 720 }), "long");
  assert.equal(timingVerdict(1, undefined), "no-target");
  const sb = parseStoryboard(SB, { version: 1 });
  const t = storyboardTiming(
    sb,
    { lo: 600, hi: 720, fromDepth: false },
    { id: "take-002", ms: 41_000 },
  );
  assert.equal(t.verdict, "short");
  assert.equal(t.percentOfTarget, 6, "33.7 s of a 10 minute low end");
  assert.deepEqual(t.lastTake, { id: "take-002", ms: 41_000 });
});

async function chromiumOk() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const chromium = await chromiumOk();

test(
  "the route and the tab: the payload carries the timing, the page shows it with the target from the brief, and each scene its own time",
  { skip: !chromium && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const briefFile = path.join(seed.dir, "brief.md");
    fs.writeFileSync(
      briefFile,
      setBriefFacts(
        fs.existsSync(briefFile)
          ? fs.readFileSync(briefFile, "utf8")
          : "# brief\n\n- **Depth:** poc\n",
        { length: "10-12 min" },
      ),
    );
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (chromium as NonNullable<typeof chromium>).launch();
    try {
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/storyboard`, {
        headers: { authorization: `Bearer ${panel.token}` },
      });
      const data = (await res.json()) as {
        timing: {
          totalMs: number;
          verdict: string;
          target: { lo: number; hi: number };
          scenes: unknown[];
        };
      };
      assert.ok(data.timing.totalMs > 1000);
      assert.deepEqual([data.timing.target.lo, data.timing.target.hi], [600, 720]);
      assert.equal(data.timing.verdict, "short", "a three-scene seed against ten minutes");
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/storyboard`);
      await page.waitForSelector("[data-timing]");
      const text = await page.locator("[data-timing]").innerText();
      assert.match(text, /^Projected recording \d+ s?/);
      assert.match(text, /target 10 min–12 min \(from the brief\): well under the target/);
      assert.equal(await page.locator("[data-timing]").getAttribute("data-verdict"), "short");
      assert.ok(
        (await page.locator("[data-scene-time]").count()) >= 1,
        "the selected scene shows its own time",
      );
      assert.match(await page.locator(".ds-list").first().innerText(), /· ~\d+ s? ·/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
