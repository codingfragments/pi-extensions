import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConcatScript, cfrSchedule, computeStats } from "../src/browser/capture/screencast.ts";
import { aimPoint, moveDuration } from "../src/browser/cursor/motion.ts";
import { muxArgs, planMux } from "../src/edit/naive.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { parseDuration } from "../src/util/duration.ts";
import { createRng } from "../src/util/rng.ts";

// ---------- CFR mapping (the timing backbone: video time == take time) ----------

const f = (file: string, ts: number) => ({ file, ts });

test("cfrSchedule: frame k shows the latest source frame with ts ≤ t0 + k/fps", () => {
  // t0 = 1000; source frames at +5, +40, +41 (burst), +200; end at +300 → 9 frames @30fps
  const runs = cfrSchedule(
    [f("a", 1005), f("b", 1040), f("c", 1041), f("d", 1200)],
    1000,
    1300,
    30,
  );
  // k·33.3ms: 0→a(before any: first) 33→a 66→c 100→c 133→c 166→c 200→d 233→d 266→d
  assert.deepEqual(runs, [
    { file: "a", count: 2 },
    { file: "c", count: 4 },
    { file: "d", count: 3 },
  ]);
  assert.equal(
    runs.reduce((n, r) => n + r.count, 0),
    9,
    "floor((end-t0)·fps)",
  );
});

test("cfrSchedule: total length is exact for long static stretches", () => {
  const runs = cfrSchedule([f("only", 1003)], 1000, 1000 + 11_816, 30);
  assert.deepEqual(runs, [{ file: "only", count: 354 }]);
});

test("buildConcatScript: durations are exact multiples of 1/fps; last file repeated", () => {
  const script = buildConcatScript(
    [
      { file: "a.jpg", count: 3 },
      { file: "it's.jpg", count: 1 },
    ],
    30,
  );
  assert.equal(
    script,
    "ffconcat version 1.0\nfile 'a.jpg'\nduration 0.100000\nfile 'it'\\''s.jpg'\nduration 0.033333\nfile 'it'\\''s.jpg'\n",
  );
});

test("computeStats: gaps, fps, sizes", () => {
  const frames = [0, 16, 33, 50, 1050].map((d, i) => ({
    index: i + 1,
    file: `${i}`,
    ts: 1000 + d,
    bytes: 2048,
  }));
  const s = computeStats(frames, 1000, 2000, [3, 9], { width: 3200, height: 1800 });
  assert.equal(s.frames, 5);
  assert.equal(s.avgFps, 5);
  assert.equal(s.maxGapMs, 1000);
  assert.equal(s.avgFrameKB, 2);
  assert.deepEqual(s.clockSkewMs, { min: 3, max: 9 });
  assert.equal(s.width, 3200);
});

// ---------- storyboard subset ----------

const VALID = `
version: 1
start_url: /
scenes:
  - id: 01-search
    title: Search
    narration: hello
    steps:
      - { do: click, target: { role: link, name: Search } }
      - { do: type, target: { role: searchbox, name: Search }, text: churn, mark: type-start }
      - { do: press, key: Enter }
      - { do: wait, for: { css: table }, timeout: 10s, mark: results-visible }
      - { do: hover, target: { text: EMEA }, dwell: 1.2s }
      - { do: wait, for: { ms: 500 } }
      - { do: pause, ms: 300 }
`;

test("parseStoryboard: valid subset with durations and marks", () => {
  const sb = parseStoryboard(VALID);
  assert.equal(sb.scenes[0]?.steps.length, 7);
  const [click, type, , wait, hover, waitMs] = sb.scenes[0]?.steps ?? [];
  assert.deepEqual(click, { do: "click", target: { role: "link", name: "Search" } });
  assert.equal(type?.mark, "type-start");
  assert.deepEqual(wait, {
    do: "wait",
    for: { css: "table" },
    timeout: 10000,
    mark: "results-visible",
  });
  assert.equal(hover?.dwell, 1200);
  assert.deepEqual(waitMs, { do: "wait", for: { ms: 500 }, timeout: 15000 });
});

test("parseStoryboard: precise error paths", () => {
  const bad = (yaml: string, re: RegExp) => assert.throws(() => parseStoryboard(yaml), re);
  bad("version: 1\nstart_url: /\nscenes: []", /scenes: must be a non-empty list/);
  bad(
    "start_url: /\nscenes: [{id: a, title: t, steps: [{do: pause, ms: 1}]}]",
    /version: must be a positive integer/,
  );
  bad(
    "version: 1\nstart_url: /\nscenes: [{id: A B, title: t, steps: [{do: pause, ms: 1}]}]",
    /scenes\[0\]\.id: must be kebab-case/,
  );
  bad(
    "version: 1\nstart_url: /\nscenes: [{id: a, title: t, steps: [{do: fly}]}]",
    /scenes\[0\]\.steps\[0\]\.do: must be one of/,
  );
  bad(
    "version: 1\nstart_url: /\nscenes: [{id: a, title: t, steps: [{do: click, target: {}}]}]",
    /target needs one of/,
  );
  bad(
    "version: 1\nstart_url: /\nscenes: [{id: a, title: t, steps: [{do: pause, ms: soon}]}]",
    /scenes\[0\]\.steps\[0\]\.ms: expected a duration/,
  );
  bad(
    "version: 1\nstart_url: /\nscenes:\n  - {id: a, title: t, steps: [{do: pause, ms: 1, mark: x}]}\n  - {id: b, title: t, steps: [{do: pause, ms: 1, mark: x}]}",
    /duplicate mark "x"/,
  );
  bad(
    "version: 1\nstart_url: /\nscenes: [{id: a, title: t, steps: [{do: pause, ms: 1}]}, {id: a, title: u, steps: [{do: pause, ms: 1}]}]",
    /duplicate scene id/,
  );
  bad("version: [", /invalid YAML/);
});

test("parseDuration", () => {
  assert.equal(parseDuration(250), 250);
  assert.equal(parseDuration("1.5s"), 1500);
  assert.equal(parseDuration("800ms"), 800);
  assert.equal(parseDuration("42"), 42);
  assert.throws(() => parseDuration("-1s"));
  assert.throws(() => parseDuration("fast"));
});

// ---------- naive mux ----------

test("planMux pads the shorter stream; muxArgs reflects the plan", () => {
  const longerAudio = planMux(10, 12.5);
  assert.deepEqual(longerAudio, {
    videoDuration: 10,
    audioDuration: 12.5,
    total: 12.5,
    padVideo: 2.5,
    padAudio: 0,
  });
  const args = muxArgs("v.mp4", "a.wav", "o.mp4", longerAudio, { width: 1920, height: 1080 });
  const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
  assert.match(graph, /scale=1920:1080:flags=lanczos/);
  assert.match(graph, /tpad=stop_mode=clone:stop_duration=2\.5/);
  assert.match(graph, /\[1:a\]anull/);
  assert.equal(args[args.indexOf("-t") + 1], "12.500");

  const longerVideo = planMux(12, 9);
  assert.equal(longerVideo.padAudio, 3);
  const g2 = muxArgs("v", "a", "o", longerVideo, { width: 1920, height: 1080 })[5] ?? "";
  assert.match(g2, /apad=pad_dur=3/);
  assert.doesNotMatch(g2, /tpad/);
});

// ---------- rng + motion ----------

test("rng is deterministic per seed", () => {
  const a = createRng(7);
  const b = createRng(7);
  const seqA = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(
    seqA,
    Array.from({ length: 5 }, () => b.next()),
  );
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(seqA, Array.from({ length: 5 }, createRng(8).next));
  const r = createRng(1);
  for (let i = 0; i < 100; i++) {
    const n = r.int(3, 5);
    assert.ok(n >= 3 && n <= 5 && Number.isInteger(n));
  }
});

test("motion: Fitts-like duration grows with distance, shrinks with width; aim stays inside", () => {
  assert.ok(moveDuration(800, 40) > moveDuration(100, 40));
  assert.ok(moveDuration(400, 20) > moveDuration(400, 200));
  assert.ok(moveDuration(100000, 1) <= 1400);
  const rng = createRng(3);
  const box = { x: 100, y: 50, w: 200, h: 40 };
  for (let i = 0; i < 200; i++) {
    const p = aimPoint(box, rng);
    assert.ok(p.x >= 150 && p.x <= 250, `x ${p.x} within the central half`);
    assert.ok(p.y >= 62 && p.y <= 78, `y ${p.y} within the central band`);
  }
});
