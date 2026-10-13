/**
 * S4 take analysis: pure range logic + an integration run on the fixture
 * (spinner = dead time, streamed answer = content, live canvas = motion).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ACTIVE_FRACTION, motionRanges } from "../src/analysis/motion.ts";
import {
  analyzeTake,
  formatAnalysis,
  motionIdle,
  observerBusy,
  observerIdle,
  observerStreaming,
  protectedRanges,
} from "../src/analysis/take.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import type { TakeEvent } from "../src/recorder/events.ts";
import { recordTake } from "../src/recorder/runner.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";

const ev = (t: number, type: string, data?: Record<string, unknown>): TakeEvent => ({
  t,
  type,
  ...(data ? { data } : {}),
});

test("motionRanges: sustained activity becomes ranges; short blips and cursor-size changes do not", () => {
  const fps = 30;
  const scores = Array.from({ length: 120 }, (_, i) => {
    if (i >= 10 && i < 50) return 0.05; // 1.33 s of big motion
    if (i >= 60 && i < 66) return 0.05; // 0.2 s blip
    if (i >= 80) return ACTIVE_FRACTION / 2; // cursor-size wiggle
    return 0;
  });
  scores[30] = 0; // a 1-frame dip inside the range is bridged
  const boxes = scores.map((s) =>
    s > 0 ? ([10, 20, 110, 70] as [number, number, number, number]) : null,
  );
  const r = motionRanges(scores, boxes, fps, { x: 5, y: 5 });
  assert.equal(r.length, 1);
  assert.equal(r[0]?.start, Math.round((11 * 1000) / fps));
  assert.equal(r[0]?.end, Math.round((51 * 1000) / fps));
  assert.deepEqual(r[0]?.box, { x: 50, y: 100, w: 505, h: 255 });
  assert.equal(r[0]?.area, 0.05);
});

test("busy ranges: no text growth = dead time; growing text = streaming content", () => {
  const events = [
    ev(1000, "idle-start"),
    ev(5000, "idle-end", { textGrowth: 0 }),
    ev(8000, "idle-start"),
    ev(10500, "idle-end", { textGrowth: 228 }),
    ev(12000, "idle-start"),
    ev(12050, "idle-end", { textGrowth: 0 }), // too short to matter
  ];
  assert.equal(observerBusy(events).length, 2);
  assert.deepEqual(observerIdle(events), [{ start: 1000, end: 5000 }]);
  assert.deepEqual(observerStreaming(events), [{ start: 8000, end: 10500, growth: 228 }]);
});

test("motionIdle: small motion between an action and its result is loading the observer missed", () => {
  const events = [ev(1000, "press"), ev(4200, "wait-satisfied"), ev(9000, "click")];
  const small = { start: 1200, end: 4100, area: 0.006, box: { x: 0, y: 0, w: 40, h: 40 } };
  const big = { start: 9100, end: 12000, area: 0.2, box: { x: 0, y: 0, w: 900, h: 400 } };
  assert.deepEqual(motionIdle(events, [small, big], []), [{ start: 1200, end: 4100 }]);
  assert.deepEqual(
    motionIdle(events, [small], [{ start: 1000, end: 4200 }]),
    [],
    "already known from the observer",
  );
});

test("protectedRanges: typing spans and clicks", () => {
  const p = protectedRanges([ev(1000, "click"), ev(1200, "type-start"), ev(2500, "type-end")]);
  assert.deepEqual(p, [
    { start: 750, end: 1350, reason: "click" },
    { start: 1200, end: 2650, reason: "typing" },
  ]);
});

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
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-s4a-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  "analyzeTake on the fixture: dead time, streaming, motion, page text and keyframes",
  { skip, timeout: 180_000 },
  async () => {
    const take = await recordTake({
      projectDir: root,
      storyboardVersion: 1,
      baseUrl: fixture.url,
      viewport: { width: 1280, height: 720, dpr: 1 },
      fps: 30,
      seed: 2,
      storyboard: parseStoryboard(
        `start_url: /search?slow=1
scenes:
  - id: 01-search
    title: Slow search
    steps:
      - { do: type, target: { role: searchbox, name: Search }, text: churn by region }
      - { do: press, key: Enter }
      - { do: wait, for: { css: table.regions }, timeout: 10s, mark: results }
  - id: 02-chat
    title: Chat
    deep_link: /chat
    steps:
      - { do: click, target: { role: link, name: Assistant } }
      - { do: type, target: { role: textbox, name: Ask a question }, text: Why is EMEA churning? }
      - { do: press, key: Enter }
      - { do: wait, for: { text: Litware Bank }, timeout: 15s, mark: answer, dwell: 2500 }
  - id: 03-live
    title: Live chart
    deep_link: /live
    steps:
      - { do: click, target: { role: link, name: Live } }
      - { do: hover, target: { role: img, name: Live traffic chart }, mark: live, dwell: 2500 }
`,
        { version: 1 },
      ),
    });
    const a = await analyzeTake(take.takeDir);
    const [search, chat, live] = a.scenes;
    assert.ok(search && chat && live);

    const dead = search.idle.reduce((n, r) => n + r.end - r.start, 0);
    assert.ok(dead > 3500 && dead < 4600, `≈4 s spinner is dead time (${dead} ms)`);
    assert.equal(search.streaming.length, 0);
    assert.match(search.marks[0]?.dom ?? "", /EMEA/, "page text at the mark has the result values");
    assert.match(search.marks[0]?.dom ?? "", /14\.2%/);

    assert.equal(chat.idle.length, 0, "the streamed answer is NOT dead time");
    assert.equal(chat.streaming.length, 1);
    assert.ok((chat.streaming[0]?.growth ?? 0) > 100);
    assert.ok(chat.protected.some((p) => p.reason === "typing"));

    const liveMotion = live.motion.reduce((n, r) => n + r.end - r.start, 0);
    assert.ok(liveMotion > 2000, `live canvas is independent motion (${liveMotion} ms)`);
    assert.ok((live.motion[0]?.box.w ?? 0) > 500, "motion box covers the chart");
    assert.equal(
      search.motion.filter((m) => m.area > 0.02 && m.end - m.start > 2000).length,
      0,
      "spinner isn't big motion",
    );

    for (const s of a.scenes) {
      assert.ok(s.keyframes.length >= 3);
      for (const k of s.keyframes) assert.ok(fs.statSync(k.file).size > 5000, `keyframe ${k.file}`);
    }
    const text = formatAnalysis(a);
    assert.match(text, /dead time .* \(observer\) — will be cut/);
    assert.match(text, /content streaming in .* kept/);
    assert.match(text, /on-screen motion .* not frozen\/sped up/);
    assert.ok(fs.existsSync(path.join(take.takeDir, "analysis", "analysis.json")));
  },
);
