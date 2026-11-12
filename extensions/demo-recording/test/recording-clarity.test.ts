/**
 * Recording tab clarity (R3-16, item 21): one vocabulary for what happened to a take, the shown take marked in its row and named above the workspace (and in the address),
 * and a take that never finished says so, without approve buttons.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { runState } from "../src/panel/stage-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

test("one word for what happened to a take", () => {
  assert.equal(runState("ok", false), "complete");
  assert.equal(runState(undefined, false), "complete", "a take from before statuses is complete");
  assert.equal(runState("failed", false), "failed");
  assert.equal(runState("cancelled", true), "cancelled");
  assert.equal(runState("recording", true), "recording", "the newest, while a recording job runs");
  assert.equal(runState("recording", false), "interrupted", "nothing records it any more");
  assert.equal(
    runState("captured", false),
    "interrupted",
    "captured but never encoded: it stopped",
  );
  assert.equal(runState("captured", true), "recording");
});

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

function addTake(dir: string, id: string, meta: Record<string, unknown>) {
  const t = path.join(dir, "takes", id);
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(
    path.join(t, "take.json"),
    JSON.stringify({
      take: id,
      storyboardVersion: 1,
      startedAt: "2026-10-21T20:00:00.000Z",
      ...meta,
    }),
  );
}

test(
  "in the browser: badges in one vocabulary, Show marks the row, names it above the workspace and in the address; an interrupted take says so and has no approve buttons",
  { skip: !browserType && "needs Playwright Chromium", timeout: 150_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    // take-001 (complete, from the seed); take-002 never finished; take-003 failed
    addTake(seed.dir, "take-002", { status: "recording" });
    addTake(seed.dir, "take-003", {
      status: "failed",
      error: "boom",
      failure: {
        kind: "retries",
        scene: "01-dash",
        step: 0,
        attempts: 3,
        stalls: 0,
        message: "scene 01-dash, step 0 (hover): nothing there",
      },
    });
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector("#take-2");
      const row = (n: number) => page.locator(`#take-${n}`);
      // the run state, one word each
      assert.match(await row(1).locator(".ds-badge[data-run-state]").innerText(), /^✓\s*Complete$/);
      assert.match(await row(2).locator(".ds-badge[data-run-state]").innerText(), /Interrupted/);
      assert.match(await row(3).locator(".ds-badge[data-run-state]").innerText(), /Failed/);
      // an unfinished take: no approve buttons, no approval badge, no misleading "recorded before S5 part 6"
      for (const n of [2, 3]) {
        assert.equal(
          await row(n).locator("[data-intent]").count(),
          0,
          `take-00${n} has no approve buttons`,
        );
        const text = await row(n).innerText();
        assert.doesNotMatch(text, /Draft version|Approved|layout snapshots/);
        assert.match(text, /it cannot be approved: it did not complete/);
      }
      assert.ok((await row(1).locator("[data-intent]").count()) > 0, "the complete take has them");
      // "Show" puts the take in the address; its row is marked and the line above the workspace names it
      await row(2).locator("[data-act=review-take]").click();
      await page.waitForFunction("location.hash === '#/recording/v2'");
      await page.waitForSelector("[data-interrupted-take=take-002]");
      assert.equal(await row(2).getAttribute("data-selected"), "true");
      assert.equal(await row(1).getAttribute("data-selected"), null);
      assert.match(await row(2).locator("[data-shown]").innerText(), /Shown below/);
      assert.equal(await row(2).locator("[data-act=review-take]").innerText(), "Shown below");
      assert.match(
        await page.locator("[data-shown-line]").innerText(),
        /^Shown below: take-002 · interrupted · it cannot be approved · the production line has (no recording yet|take-\d+)$/,
      );
      assert.match(
        await page.locator("[data-interrupted-take=take-002]").innerText(),
        /never finished: nothing records it any more[\s\S]*No video was kept\. It cannot be approved\./,
      );
      assert.match(
        await page.locator(".stage-summary").innerText(),
        /Viewing take-002/,
        "the header names the same take",
      );
      // the failed one shows its card; the complete one its workspace and its standing
      await row(3).locator("[data-act=review-take]").click();
      await page.waitForSelector("[data-failed-take=take-003]");
      await row(1).locator("[data-act=review-take]").click();
      await page.waitForFunction("location.hash === '#/recording/v1'");
      assert.match(
        await page.locator("[data-shown-line]").innerText(),
        /^Shown below: take-001 · complete · /,
      );
      assert.equal(await page.locator("[data-interrupted-take], [data-failed-take]").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);

test("the API: a take that the running job records is 'recording', the same take with no job is 'interrupted'", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  addTake(seed.dir, "take-002", { status: "recording" });
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
    root: seed.root,
    panelPort: 0,
  }));
  try {
    rt.setActiveProject(seed.slug);
    const get = async () => {
      const panel = await rt.ensurePanel();
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/recordings?token=${panel.token}`);
      return ((await res.json()) as { takes: { id: string; state: string }[] }).takes;
    };
    assert.equal((await get()).find((t) => t.id === "take-002")?.state, "interrupted");
    (rt.jobs as unknown as { running: (k: string) => unknown }).running = (k) =>
      k === "record" ? { id: "j" } : undefined;
    assert.equal((await get()).find((t) => t.id === "take-002")?.state, "recording");
    assert.equal(
      (await get()).find((t) => t.id === "take-001")?.state,
      "complete",
      "only the newest is the one being recorded",
    );
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
