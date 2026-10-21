/**
 * A recording must not be lost to a frozen browser: every step has a deadline; a step that does not finish is diagnosed (everything about the step and the browser is
 * written next to the take), the browser is killed and replaced, and the scene is shot again without using up a retry. An interrupt and a failed scene are written down
 * too. Real Chromium + ffmpeg on the fixture.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { readEvents } from "../src/recorder/events.ts";
import { type ProgressSnapshot, formatProgress } from "../src/recorder/progress.ts";
import { type RecordOptions, recordTake, stepDeadlineMs } from "../src/recorder/runner.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import {
  clearTakeRequest,
  readTakeRequest,
  writeTakeRequest,
} from "../src/workdir/take-request.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

let fixture: FixtureHandle;
let root: string;
let n = 0;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-wdr-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function opts(yaml: string, extra: Partial<RecordOptions> = {}): RecordOptions {
  const projectDir = path.join(root, `p${++n}`);
  fs.mkdirSync(projectDir);
  return {
    projectDir,
    storyboard: parseStoryboard(yaml, { version: 1 }),
    storyboardVersion: 1,
    baseUrl: fixture.url,
    viewport: { width: 1280, height: 720, dpr: 1 },
    fps: 30,
    seed: 7,
    ...extra,
  };
}

const SB = `start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: hover, target: { css: '[data-kpi="arr"]' }, mark: arr, dwell: 300 }
  - id: 02-search
    title: Search
    deep_link: /
    steps:
      - { do: click, target: { role: link, name: Search } }
      - { do: type, target: { role: searchbox, name: Search }, text: emea, mark: typed }
      - { do: press, key: Enter }
`;

test("a step's allowance: three times its estimate plus the slack, an explicit wait's timeout plus 15 s, never less than the minimum; 0 turns it off", () => {
  const sb = parseStoryboard(
    `start_url: /
scenes:
  - id: a
    title: A
    steps:
      - { do: pause, ms: 10s }
      - { do: wait, for: { css: .x }, timeout: 120s }
      - { do: press, key: Enter }
`,
    { version: 1 },
  );
  const [pause, wait, press] = sb.scenes[0]?.steps ?? [];
  assert.equal(stepDeadlineMs(pause as never, 60_000), 60_000, "3 × 10 s + 30 s = 60 s");
  assert.equal(stepDeadlineMs(wait as never, 60_000), 135_000, "its own timeout plus 15 s");
  assert.equal(stepDeadlineMs(press as never, 60_000), 60_000, "the minimum");
  assert.equal(stepDeadlineMs(press as never, 60_000, 0), 60_000);
  assert.equal(stepDeadlineMs(press as never, 5_000, 0), 5_000, "tests shorten it");
  assert.equal(stepDeadlineMs(press as never, 0), 0, "off");
});

test("the progress line says when a step has run far past what it should take", () => {
  const snap = {
    scene: { index: 2, total: 3, id: "02-search", title: "Search" },
    step: { index: 1, total: 4, label: "clicking" },
    fraction: 0.4,
    scenes: [],
    elapsedMs: 100_000,
    etaMs: 30_000,
    attempt: 1,
    phase: "recording",
  } as ProgressSnapshot;
  assert.doesNotMatch(formatProgress(snap), /stuck/);
  assert.match(
    formatProgress({ ...snap, slow: { runMs: 95_000, expectedMs: 2_000 } }),
    /step 1\/4 · clicking · ⚠ this step has run 95 s \(expected 2 s\): the browser may be stuck/,
  );
});

test("the take request remembers the window you asked for until the take starts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-tr-"));
  try {
    assert.equal(readTakeRequest(dir), undefined);
    writeTakeRequest(dir, { storyboard: 3, headed: true });
    assert.equal(readTakeRequest(dir, 3)?.headed, true);
    assert.equal(readTakeRequest(dir, 4), undefined, "only for the storyboard it was asked for");
    clearTakeRequest(dir);
    assert.equal(readTakeRequest(dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a frozen browser: the step is diagnosed, the browser replaced, the scene shot again without using a retry, and everything about it is written next to the take",
  { skip, timeout: 240_000 },
  async () => {
    const diag: { kind: string; verdict: string; dir: string }[] = [];
    const progress: ProgressSnapshot[] = [];
    const take = await recordTake(
      opts(SB, {
        maxRetriesPerScene: 0, // a stall must not use a retry: with none left the take still completes
        stepDeadlineMinMs: 4000,
        stepDeadlineSlackMs: 0,
        faultInjection: { scene: "02-search", step: 1, kind: "freeze" },
        onDiagnosis: (d) => diag.push(d),
        onProgress: (p) => progress.push(p),
        keepFrames: true,
      }),
    );
    // the take is whole: two segments, every scene once
    assert.equal(take.segments.length, 2);
    assert.deepEqual(
      take.scenes.map((s) => s.id),
      ["01-dash", "02-search"],
    );
    const meta = JSON.parse(fs.readFileSync(path.join(take.takeDir, "take.json"), "utf8"));
    assert.equal(meta.status, "ok");
    assert.equal(meta.stalls, 1);
    assert.match(
      meta.segments[1].resumedAfter.error,
      /scene 02-search, step 2 \(type\) did not finish in \d+ s: the browser is frozen \(nothing answers/,
    );
    assert.deepEqual(meta.diagnostics, ["diagnostics/stalled-1"]);
    // told while it happened
    assert.equal(diag.length, 1);
    assert.equal(diag[0]?.kind, "stalled");
    assert.match(diag[0]?.verdict ?? "", /nothing answers: the browser process itself is stuck/);
    assert.ok(progress.some((p) => p.phase === "recovering"));
    // everything about the step and the browser
    const dir = path.join(take.takeDir, "diagnostics", "stalled-1");
    const files = fs.readdirSync(dir);
    for (const f of ["README.txt", "context.json", "events-tail.jsonl", "probes.json", "ps.txt"])
      assert.ok(files.includes(f), `${f} in ${files.join(", ")}`);
    const ctx = JSON.parse(fs.readFileSync(path.join(dir, "context.json"), "utf8"));
    assert.equal(ctx.kind, "stalled");
    assert.equal(ctx.scene.id, "02-search");
    assert.equal(ctx.step.index, 1);
    assert.equal(ctx.step.definition.do, "type");
    assert.ok(
      ctx.step.allowedMs >= 4000,
      `allowed ${ctx.step.allowedMs} ms: three times its estimate`,
    );
    assert.ok(ctx.step.ranMs >= ctx.step.allowedMs - 500, `the step had run ${ctx.step.ranMs} ms`);
    assert.equal(ctx.settings.maxRetries, 0);
    assert.ok(ctx.machine.totalMemMB > 0);
    assert.ok(ctx.takeTimeMs > 0);
    const probes = JSON.parse(fs.readFileSync(path.join(dir, "probes.json"), "utf8"));
    assert.match(probes.verdict, /nothing answers/);
    assert.ok(
      probes.probes.filter((p: { timedOut?: boolean }) => p.timedOut).length >= 4,
      "the probes that waited for the browser timed out",
    );
    assert.match(
      fs.readFileSync(path.join(dir, "README.txt"), "utf8"),
      /STALLED in take-001, scene 02-search \(2\/2\) “Search”, step 2\/3 \(type\)/,
    );
    assert.ok(
      readEvents(
        path.join(dir, "events-tail.jsonl").replace("events-tail.jsonl", "events-tail.jsonl"),
      ).length > 0,
      "the last events",
    );
    assert.ok(fs.existsSync(path.join(dir, "last-frame.jpg")), "the last frame the capture got");
    // the retry counter was not touched: the log says stalled
    const stitch = readEvents(path.join(take.takeDir, "events.jsonl")).find(
      (e) => e.type === "stitch",
    );
    assert.equal((stitch?.data as { stalled?: boolean }).stalled, true);
  },
);

test(
  "more frozen browsers than a take survives: it fails, saying so, with every diagnosis kept",
  { skip, timeout: 240_000 },
  async () => {
    const o = opts(SB, {
      stepDeadlineMinMs: 3000,
      stepDeadlineSlackMs: 0,
      maxStalls: 1,
      faultInjection: { scene: "02-search", step: 0, kind: "freeze", attempts: [1, 2] },
    });
    await assert.rejects(
      recordTake(o),
      /the browser froze 2 times: more than the 1 a take survives/,
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(o.projectDir, "takes", "take-001", "take.json"), "utf8"),
    );
    assert.equal(meta.status, "failed");
    assert.deepEqual(meta.diagnostics, ["diagnostics/stalled-1", "diagnostics/stalled-2"]);
  },
);

test(
  "an interrupt while a step runs is written down: where it was and what the browser said, and it stops at once",
  { skip, timeout: 120_000 },
  async () => {
    const o = opts(
      `start_url: /
scenes:
  - id: 01-wait
    title: Waiting
    steps:
      - { do: pause, ms: 60s }
`,
      { stepDeadlineMinMs: 120_000 },
    );
    const controller = new AbortController();
    o.signal = controller.signal;
    setTimeout(() => controller.abort(), 3000);
    const t = Date.now();
    await assert.rejects(recordTake(o), /cancelled/);
    assert.ok(
      Date.now() - t < 20_000,
      `stopped at once, not after the 60 s step (${Date.now() - t} ms)`,
    );
    const dir = path.join(o.projectDir, "takes", "take-001");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8"));
    assert.equal(meta.status, "cancelled");
    assert.deepEqual(meta.diagnostics, ["diagnostics/interrupted-1"]);
    const ctx = JSON.parse(
      fs.readFileSync(path.join(dir, "diagnostics", "interrupted-1", "context.json"), "utf8"),
    );
    assert.equal(ctx.kind, "interrupted");
    assert.equal(ctx.step.definition.do, "pause");
    assert.match(ctx.verdict, /everything answers: the browser is fine/);
    assert.ok(
      fs.existsSync(path.join(dir, "diagnostics", "interrupted-1", "page.jpg")),
      "the page as it was",
    );
  },
);

test(
  "a scene that fails for any other reason is written down too: the step, the error and what the page looked like",
  { skip, timeout: 240_000 },
  async () => {
    const take = await recordTake(
      opts(SB, {
        faultInjection: { scene: "02-search", step: 0, kind: "error" },
        keepFrames: true,
      }),
    );
    const meta = JSON.parse(fs.readFileSync(path.join(take.takeDir, "take.json"), "utf8"));
    assert.deepEqual(meta.diagnostics, ["diagnostics/failed-1"]);
    const dir = path.join(take.takeDir, "diagnostics", "failed-1");
    const ctx = JSON.parse(fs.readFileSync(path.join(dir, "context.json"), "utf8"));
    assert.equal(ctx.kind, "failed");
    assert.equal(ctx.scene.id, "02-search");
    assert.match(ctx.error, /injected fault/);
    assert.ok(fs.existsSync(path.join(dir, "page.jpg")));
    assert.equal(meta.stalls, 0);
  },
);

test("the Recording tab's window switch: the request says it, the Director is told to pass it on, and the take picks it up even if it does not", async () => {
  const { resolveConfig } = await import("../src/config.ts");
  const { Runtime } = await import("../src/runtime.ts");
  const { seedPanelProject } = await import("./helpers/panel-seed.ts");
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const told: string[] = [];
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => told.push(t);
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const post = async (body: unknown) =>
    (
      await fetch(`http://127.0.0.1:${panel.port}/api/rerecord`, {
        method: "POST",
        headers: { authorization: `Bearer ${panel.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status;
  try {
    assert.equal(await post({ note: "watch it", headed: true }), 200);
    assert.match(
      told.at(-1) ?? "",
      /in a VISIBLE browser window \(they want to watch it\)\. Record it with demo_rec_record storyboard=\d+ headed=true/,
    );
    assert.equal(
      readTakeRequest(seed.dir)?.headed,
      true,
      "remembered for the call that records the take",
    );
    assert.equal(await post({ note: "hidden is fine" }), 200);
    assert.doesNotMatch(told.at(-1) ?? "", /VISIBLE|headed=true/);
    assert.equal(
      readTakeRequest(seed.dir),
      undefined,
      "a later request without the switch clears it",
    );
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
