/**
 * Re-run QA is not a render. It checks a finished video (ffmpeg detect filters and a local Whisper pass) and renders nothing, but it runs in
 * the render job slot, so it used to read as "Render" in the status bar, and its Activity row stayed "running" for ever because it ends with
 * `render.qa`, not `render.finished`. It now says "Quality check", and it ends.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { jobTitle, nextBand } from "../src/panel/public/frame-state.js";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

test("a job is called by its label when it has one, else by its kind", () => {
  assert.equal(jobTitle({ kind: "render", label: "Quality check" }), "Quality check");
  assert.equal(jobTitle({ kind: "render", label: null }), "Render");
  assert.equal(jobTitle({ kind: "tts" }), "Voice");
  assert.equal(jobTitle({ kind: "mystery" }), "mystery");
});

test("the next-action band says Quality check is running, not Render", () => {
  const jobs = [
    {
      id: "j1",
      kind: "render",
      label: "Quality check",
      status: "running",
      startedAt: 1,
      finishedAt: null,
      error: null,
    },
  ];
  const band = nextBand({
    stages: { project: "k", next: null, stages: [] } as never,
    states: {},
    jobs,
    rows: [],
  } as never);
  assert.match(band?.text ?? "", /Quality check is running/);
  assert.doesNotMatch(band?.text ?? "", /Render/);
});

test("the jobs route carries the label", async () => {
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  try {
    const job = rt.jobs.start("render", seed.slug, async () => "x");
    job.label = "Quality check";
    await job.done;
    const plain = rt.jobs.start("render", seed.slug, async () => "x");
    await plain.done;
    const reply = (await (rt.routeTables().get.jobs as () => unknown)()) as {
      jobs: { id: string; label: string | null }[];
    };
    assert.deepEqual(reply.jobs.map((j) => j.label).sort(), ["Quality check", null]);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
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

test(
  "the Activity row: a quality check is named so, shows no percentage, and ends when the check ends; a render is still a render",
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
      const page = await browser.newPage();
      await page.goto(panel.url);
      const rows = (events: unknown[]) =>
        page.evaluate(
          `import("/live.js").then((m) => m.activityRows(${JSON.stringify(events)}).map((r) => ({ title: r.title, state: r.state, fraction: r.fraction, detail: r.detail })))`,
        ) as Promise<{ title: string; state: string; fraction: number | null; detail: string }[]>;
      const ev = (seq: number, type: string, data: object) => ({
        seq,
        type,
        data,
        at: "",
        project: "k",
      });
      const qaProgress = ev(1, "render.progress", {
        done: 0,
        total: 1,
        label: "QA",
        message: "🔎 Checking render v8: nothing is rendered",
      });
      // while it runs
      assert.deepEqual(await rows([qaProgress]), [
        {
          title: "Quality check",
          state: "running",
          fraction: null,
          detail: "🔎 Checking render v8: nothing is rendered",
        },
      ]);
      // when it ends (render.qa, not render.finished) the row is done, not running for ever
      const done = await rows([
        qaProgress,
        ev(2, "render.qa", {
          version: 8,
          status: "warnings",
          message: "QA of render v8: warnings",
        }),
      ]);
      assert.deepEqual(
        done.map((r) => [r.title, r.state]),
        [["Quality check", "done"]],
      );
      const broken = await rows([
        qaProgress,
        ev(2, "render.qa", { version: 8, status: "error", message: "QA of render v8 failed" }),
      ]);
      assert.deepEqual(
        broken.map((r) => [r.title, r.state]),
        [["Quality check", "failed"]],
      );
      // a real render is unchanged
      const render = await rows([
        ev(1, "render.progress", {
          done: 1,
          total: 4,
          label: "scenes",
          message: "rendering scenes 1/4",
        }),
      ]);
      assert.deepEqual(
        render.map((r) => [r.title, r.state, r.fraction]),
        [["Render", "running", 0.25]],
      );
      const finished = await rows([
        ev(1, "render.progress", { done: 1, total: 4, message: "m" }),
        ev(2, "render.finished", { status: "done", message: "render v9 done" }),
      ]);
      assert.deepEqual(
        finished.map((r) => [r.title, r.state]),
        [["Render", "done"]],
      );
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
