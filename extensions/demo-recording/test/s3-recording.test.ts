/**
 * S3 integration on the fixture (real Chromium + ffmpeg): observers, improvise
 * (with a fake model), hesitation fallback, resume after an error and after a
 * browser crash (deep_link and replay paths), cancellation, progress.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { ffprobe, hasBinary } from "../src/media/ffmpeg.ts";
import { readEvents } from "../src/recorder/events.ts";
import type { Improviser } from "../src/recorder/improvise.ts";
import type { ProgressSnapshot } from "../src/recorder/progress.ts";
import { type RecordOptions, recordTake } from "../src/recorder/runner.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-s3-"));
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

const fakeImproviser = (text: string, delayMs = 50): Improviser & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    generate: async (req) => {
      calls.push(req.digest);
      await new Promise((r) => setTimeout(r, delayMs));
      return { text, model: "fake/model", ms: delayMs, tried: ["fake/model"] };
    },
  };
};

test(
  "observers: slow search logs an idle range; flaky dashboard logs an error toast",
  { skip, timeout: 120_000 },
  async () => {
    const take = await recordTake(
      opts(`start_url: /search
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: goto, url: "/?flaky=1&slow=1" }
      - { do: wait, for: { role: alert }, timeout: 6s, mark: toast }
  - id: 02-search
    title: Slow search
    steps:
      - { do: click, target: { role: link, name: Search } }
      - { do: type, target: { role: searchbox, name: Search }, text: emea }
      - { do: press, key: Enter }
      - { do: wait, for: { css: .hits }, timeout: 10s, mark: results }
`),
    );
    const alert = take.events.find((e) => e.type === "alert");
    assert.ok(alert, "toast observed");
    assert.match(String(alert.data?.text), /Couldn't load segment/);
    assert.equal(alert.data?.level, "error");
    assert.equal(alert.scene, "01-dash");

    const start = take.events.find((e) => e.type === "idle-start" && e.scene === "02-search");
    const end = take.events.find((e) => e.type === "idle-end" && start && e.t > start.t);
    assert.ok(start && end, "spinner produced an idle range");
    assert.ok(
      end.t - start.t > 3000 && end.t - start.t < 5500,
      `idle range ${end.t - start.t} ms ≈ 4 s spinner`,
    );
    const results = take.events.find((e) => e.mark === "results");
    assert.ok(results && Math.abs(results.t - end.t) < 500, "idle ends when results appear");
    assert.ok(
      take.events.some((e) => e.type === "route" && String(e.data?.url).includes("/search")),
    );
  },
);

test(
  "improvise: input invented while the cursor travels, typed humanly, submitted, logged",
  { skip, timeout: 120_000 },
  async () => {
    const improviser = fakeImproviser("Why is EMEA churning?", 300);
    const progress: ProgressSnapshot[] = [];
    const take = await recordTake(
      opts(
        `start_url: /chat
scenes:
  - id: 01-ask
    title: Ask
    steps:
      - do: improvise
        kind: type
        target: { role: textbox, name: Ask a question }
        prompt: a question about EMEA
        max_chars: 60
        mark: question
      - { do: wait, for: { text: Litware Bank }, timeout: 15s, mark: answer }
`,
        { improviser, improviseContext: "audience: CFOs", onProgress: (p) => progress.push(p) },
      ),
    );
    assert.equal(improviser.calls.length, 1);
    assert.match(
      improviser.calls[0] ?? "",
      /textbox "Ask a question"/,
      "live aria digest passed to the model",
    );
    const types = take.events.map((e) => e.type);
    assert.ok(
      types.indexOf("improvise-start") < types.indexOf("click"),
      "generation starts before the cursor arrives",
    );
    const typed = take.events.find((e) => e.type === "type-start");
    assert.equal(typed?.mark, "question");
    assert.deepEqual(
      [typed?.data?.text, typed?.data?.source, typed?.data?.improvised],
      ["Why is EMEA churning?", "model", true],
    );
    const ready = take.events.find((e) => e.type === "improvise-ready");
    assert.equal(ready?.data?.model, "fake/model");
    const tEnd = take.events.find((e) => e.type === "type-end");
    const tStart = typed?.t ?? 0;
    assert.ok(
      tEnd && tEnd.t - tStart > "Why is EMEA churning?".length * 40,
      "typed at human speed",
    );
    assert.ok(
      take.events.some((e) => e.mark === "answer"),
      "chat actually answered the submitted question",
    );

    // Progress: phases end in done at 100 %.
    assert.equal(progress.at(-1)?.phase, "done");
    assert.equal(progress.at(-1)?.fraction, 1);
    assert.ok(
      progress.some((p) => p.phase === "recording" && p.step.label === "improvising input"),
    );
  },
);

test(
  "improvise: slow model → hesitation, then fallback text; no fallback → scene fails",
  { skip, timeout: 120_000 },
  async () => {
    const yaml = (fallback: string) => `start_url: /chat
scenes:
  - id: 01-ask
    title: Ask
    steps:
      - do: improvise
        kind: type
        target: { role: textbox, name: Ask a question }
        prompt: anything
        max_chars: 60
        submit: false
${fallback}`;
    const slow = fakeImproviser("too late", 5000);
    const take = await recordTake(
      opts(yaml("        fallback: Which region churns most?\n"), {
        improviser: slow,
        hesitateMs: 800,
      }),
    );
    const failed = take.events.find((e) => e.type === "improvise-failed");
    assert.match(String(failed?.data?.reason), /no input within 800 ms/);
    const typed = take.events.find((e) => e.type === "type-start");
    assert.deepEqual(
      [typed?.data?.text, typed?.data?.source],
      ["Which region churns most?", "fallback"],
    );

    await assert.rejects(
      recordTake(
        opts(yaml(""), {
          improviser: fakeImproviser("x", 5000),
          hesitateMs: 300,
          maxRetriesPerScene: 0,
        }),
      ),
      /improvise: no input within 300 ms \(add a fallback/,
    );
  },
);

const RESUME_SB = `start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: hover, target: { css: '[data-kpi="arr"]' }, mark: arr, dwell: 300 }
  - id: 02-search
    title: Search
    DEEP
    steps:
      - { do: click, target: { role: link, name: Search } }
      - { do: type, target: { role: searchbox, name: Search }, text: emea, mark: typed }
      - { do: press, key: Enter }
      - { do: wait, for: { css: .hits }, timeout: 10s, mark: results }
  - id: 03-item
    title: Item
    steps:
      - { do: click, target: { role: link, name: Litware Bank }, mark: open-item }
      - { do: wait, for: { role: heading, name: Litware Bank }, timeout: 10s, mark: item-visible }
`;

async function assertStitched(take: Awaited<ReturnType<typeof recordTake>>, failedScene: string) {
  assert.equal(take.segments.length, 2, "one resume → two segments");
  const [s1, s2] = take.segments;
  assert.equal(s2?.resumedAfter?.scene, failedScene);
  assert.equal(s1?.end, s2?.start, "segments are contiguous on the take timeline");
  assert.deepEqual(
    take.scenes.map((s) => s.id),
    ["01-dash", "02-search", "03-item"],
    "every scene present once",
  );
  const events = readEvents(path.join(take.takeDir, "events.jsonl"));
  assert.equal(
    events.filter((e) => e.type === "scene-start" && e.scene === failedScene).length,
    1,
    "failed attempt cut out",
  );
  assert.equal(events.filter((e) => e.type === "stitch").length, 1);
  for (let i = 1; i < events.length; i++)
    assert.ok((events[i]?.t ?? 0) >= (events[i - 1]?.t ?? 0), "monotonic after stitching");
  assert.deepEqual(
    events.filter((e) => e.mark).map((e) => e.mark),
    ["arr", "typed", "results", "open-item", "item-visible"],
  );
  const attempts = fs
    .readFileSync(path.join(take.takeDir, "attempts.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(attempts.length, 1);
  const frames = fs
    .readFileSync(path.join(take.takeDir, "frames.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(frames.some((f) => f.segment === 1) && frames.some((f) => f.segment === 2));
  for (const f of frames)
    assert.ok(fs.existsSync(path.join(take.takeDir, "frames", f.file)), "kept frames exist");
  assert.ok(take.rawVideo);
  const probe = await ffprobe(take.rawVideo);
  assert.ok(
    Math.abs(probe.duration - take.durationMs / 1000) < 0.1,
    `master ${probe.duration}s ≈ take ${take.durationMs / 1000}s`,
  );
}

test(
  "resume: an error in scene 3 restores state by replaying scenes 1–2 off-camera and stitches",
  { skip, timeout: 180_000 },
  async () => {
    const progress: ProgressSnapshot[] = [];
    const take = await recordTake(
      opts(RESUME_SB.replace("    DEEP\n", ""), {
        faultInjection: { scene: "03-item", step: 0, kind: "error" },
        onProgress: (p) => progress.push(p),
      }),
    );
    await assertStitched(take, "03-item");
    assert.ok(progress.some((p) => p.phase === "recovering"));
    assert.ok(
      progress.some((p) => p.scenes[2]?.attempt === 2),
      "restarted segment visible in progress",
    );
  },
);

test(
  "resume: a browser crash in scene 2 reopens the browser and restores via deep_link",
  { skip, timeout: 180_000 },
  async () => {
    const take = await recordTake(
      opts(RESUME_SB.replace("    DEEP\n", "    deep_link: /\n"), {
        faultInjection: { scene: "02-search", step: 1, kind: "crash" },
      }),
    );
    await assertStitched(take, "02-search");
    const meta = JSON.parse(fs.readFileSync(path.join(take.takeDir, "take.json"), "utf8"));
    assert.equal(meta.status, "ok");
    assert.equal(meta.segments[1].resumedAfter.attempt, 1);
  },
);

test("retries are bounded; cancellation stops the take", { skip, timeout: 180_000 }, async () => {
  await assert.rejects(
    recordTake(
      opts(RESUME_SB.replace("    DEEP\n", "    deep_link: /\n"), {
        maxRetriesPerScene: 1,
        faultInjection: { scene: "02-search", step: 0, attempts: [1, 2] },
      }),
    ),
    /injected fault \(after 2 attempts\)/,
  );
  const controller = new AbortController();
  const o = opts(RESUME_SB.replace("    DEEP\n", ""), { signal: controller.signal });
  setTimeout(() => controller.abort(), 2500);
  await assert.rejects(recordTake(o), /cancelled/);
  const meta = JSON.parse(
    fs.readFileSync(path.join(o.projectDir, "takes", "take-001", "take.json"), "utf8"),
  );
  assert.equal(meta.status, "cancelled");
});
