/**
 * The recorder holds to meet a scene's time (item 22): within the caps, logged, and written to take.json; a measured take carries its length. Real Chromium + ffmpeg.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { measureTake } from "../src/budget/take.ts";
import { resolveConfig } from "../src/config.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { recordTake } from "../src/recorder/runner.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";

async function chromiumOk() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
}
const skip =
  (!(await chromiumOk()) || !hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

let fixture: FixtureHandle;
let root: string;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "len-rec-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  "a scene with a time holds at its end up to the caps; a step's own hold is held; take.json says what each scene made",
  { skip, timeout: 240_000 },
  async () => {
    const projectDir = path.join(root, "p");
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, "brief.md"), "# b\n\n- **Target length:** 10 min\n");
    const sb = parseStoryboard(
      `start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    time: 9s
    steps:
      - { do: hover, target: { css: '[data-kpi="arr"]' }, dwell: 200 }
  - id: 02-hold
    title: Hold
    steps:
      - { do: hover, target: { css: '[data-kpi="arr"]' }, dwell: 200, hold: 2s }
`,
      { version: 1 },
    );
    const take = await recordTake({
      projectDir,
      storyboard: sb,
      storyboardVersion: 1,
      baseUrl: fixture.url,
      viewport: { width: 1280, height: 720, dpr: 1 },
      fps: 30,
      seed: 7,
    });
    const holds = take.events.filter((e) => e.type === "hold");
    assert.equal(holds.length, 2);
    const [h1, h2] = holds;
    assert.equal(h1?.scene, "01-dash");
    assert.equal(h1?.data?.ms, 3000, "a 9 s scene may hold a third of its time: 3 s");
    assert.equal(h1?.data?.capped, true, "it wanted more");
    assert.equal(h2?.scene, "02-hold");
    assert.equal(h2?.data?.ms, 2000, "the step's own hold");
    const meta = JSON.parse(fs.readFileSync(path.join(take.takeDir, "take.json"), "utf8"));
    const t1 = meta.sceneTimes["01-dash"];
    assert.equal(t1.timeMs, 9000);
    assert.equal(t1.heldMs, 3000);
    assert.ok(t1.madeMs >= 3000 && t1.madeMs < 9000, `made ${t1.madeMs}`);
    assert.ok(t1.shortMs > 0, "still short: too thin for 9 s");
    assert.equal(meta.sceneTimes["02-hold"].heldMs, 2000);
    // the scene spans really got longer by the holds
    const span = take.scenes.find((s) => s.id === "01-dash");
    assert.ok(span && span.end - span.start >= 3000);
    // measured against the brief's budget, written into take.json
    const l = measureTake(
      projectDir,
      { ...resolveConfig({ env: {}, home: "/h", readFile: () => undefined }), root },
      take,
    );
    assert.equal(l.verdict, "short");
    assert.equal(l.budget?.targetSec, 600);
    assert.deepEqual(
      l.thinScenes?.map((s) => s.id),
      ["01-dash"],
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(take.takeDir, "take.json"), "utf8")).length.verdict,
      "short",
    );
  },
);
