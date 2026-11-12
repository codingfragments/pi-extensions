/**
 * The storyboard tab says how long the storyboard takes to record, against the length the brief asks for.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lengthBudget } from "../src/budget/length.ts";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { storyboardTiming, timingForDirector } from "../src/storyboard/timing.ts";
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

test("the projection: the scenes' steps by the recorder's own estimates plus the lead-in and the tail; the final video is that less the dead time, plus the title card", () => {
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
  assert.equal(
    t.final.ms,
    Math.round(t.totalMs * 0.9),
    "10 % dead time by default, no title card given",
  );
  const withTitle = storyboardTiming(sb, { cutShare: 0.2, cutFrom: "takes", titleMs: 3300 });
  assert.equal(withTitle.final.ms, Math.round(t.totalMs * 0.8 + 3300));
  assert.equal(withTitle.final.cutFrom, "takes");
});

test("against the budget: the FINAL against its floor and ceiling; the words say how far off; the last take is carried along", () => {
  const sb = parseStoryboard(SB, { version: 1 });
  const budget = lengthBudget({ length: "10 min" }) as NonNullable<ReturnType<typeof lengthBudget>>;
  const t = storyboardTiming(sb, { budget, lastTake: { id: "take-002", ms: 41_000 } });
  assert.equal(t.verdict, "short");
  assert.deepEqual([t.target?.lo, t.target?.hi], [510, 660], "10 min: 8:30 to 11:00");
  assert.equal(t.percentOfTarget, 5);
  assert.match(
    t.words ?? "",
    /^projected final 0:30 for a target of 10:00 \(8:30 to 11:00\): 8:00 short of the floor$/,
  );
  assert.deepEqual(t.lastTake, { id: "take-002", ms: 41_000 });
  const note = timingForDirector(t);
  assert.match(note, /Length: projected final 0:30/);
  assert.match(note, /2 of 2 scenes have no `time:` yet/);
  assert.match(
    note,
    /Short of the budget: plan the difference BEFORE the user sees this draft, depth first/,
  );
  assert.match(note, /never pad/);
  // a budget that changed since the version was written
  const moved = storyboardTiming(sb, { budget, plannedFor: { targetSec: 240 } });
  assert.deepEqual(moved.plannedFor, { targetSec: 240 });
  assert.match(timingForDirector(moved), /planned for 4:00; the target is now 10:00/);
  assert.equal(
    storyboardTiming(sb, { budget, plannedFor: { targetSec: 600 } }).plannedFor,
    undefined,
    "same target: nothing to say",
  );
  // within, and over
  const fits = lengthBudget({ length: "30 s" }) as NonNullable<ReturnType<typeof lengthBudget>>;
  assert.equal(storyboardTiming(sb, { budget: fits }).verdict, "fits");
  const over = lengthBudget({ length: "20 s" }) as NonNullable<ReturnType<typeof lengthBudget>>;
  assert.equal(storyboardTiming(sb, { budget: over }).verdict, "long");
});

test("scene times and holds: a scene that ends early holds up to its time within the caps; a thin one is reported short", () => {
  const timed = parseStoryboard(
    `start_url: /
scenes:
  - id: 01-a
    title: A
    time: 20s
    steps:
      - { do: pause, ms: 15s }
  - id: 02-b
    title: B
    time: 30s
    steps:
      - { do: pause, ms: 5s, hold: 2s }
      - { do: pause, ms: 5s }
`,
    { version: 1 },
  );
  const t = storyboardTiming(timed);
  const [a, b] = t.scenes;
  assert.deepEqual(
    [a?.timeMs, a?.stepsMs, a?.heldMs, a?.ms, a?.shortMs],
    [20_000, 15_000, 5000, 20_000, 0],
    "15 s of steps, 5 s held at the end",
  );
  // B: 10 s of steps for 30 s; one hold point (the step with hold), at most 6 s: thin
  assert.deepEqual([b?.heldMs, b?.ms, b?.shortMs], [6000, 16_000, 14_000]);
  assert.equal(t.timesMs, 50_000);
  assert.match(
    timingForDirector(t),
    /Too thin for their time even with the holds .*02-b \(0:14 short\)/,
  );
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
        { length: "10 min" },
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
      assert.deepEqual(
        [data.timing.target.lo, data.timing.target.hi],
        [510, 660],
        "10 min, −15 % / +10 %",
      );
      assert.equal(data.timing.verdict, "short", "a three-scene seed against ten minutes");
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/storyboard`);
      await page.waitForSelector("[data-timing]");
      const text = await page.locator("[data-timing]").innerText();
      assert.match(text, /^Projected final \d+:\d\d/);
      assert.match(text, /target 10:00 \(8:30 to 11:00\) \(from the brief\): short of the budget/);
      assert.match(
        text,
        /Raw take \d+:\d\d · \d+ steps? in \d+ scenes? · less about \d+ % dead time( \(measured on this project's takes\))?, plus the 0:03 title card/,
      );
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
