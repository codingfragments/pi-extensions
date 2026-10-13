/**
 * Sync solver properties (the most important tests of S4):
 *  - anchored narration starts within ±80 ms of its event in output time
 *  - typing/clicks are never cut, sped up or frozen
 *  - dead time is consumed before any speed change
 *  - motion/stream intervals are never frozen and stay within their speed caps
 *  - narration never overlaps itself; total duration within ±5 % of narration + tail
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS,
  type Piece,
  type SceneEdit,
  type SceneInput,
  classify,
  solveScene,
  solveSpan,
} from "../src/edit/sync.ts";

const clip = (pieces: Piece[]) =>
  pieces.filter((p): p is Extract<Piece, { src: unknown }> => "src" in p);
const freezes = (pieces: Piece[]) =>
  pieces.filter((p): p is Extract<Piece, { freeze: unknown }> => "freeze" in p);

function assertInvariants(input: SceneInput, e: SceneEdit) {
  // protected source time is fully present at 1.0×
  for (const r of input.protected) {
    const covered = clip(e.pieces)
      .filter((p) => p.src[1] > r.start && p.src[0] < r.end)
      .reduce((n, p) => n + (Math.min(p.src[1], r.end) - Math.max(p.src[0], r.start)), 0);
    assert.ok(
      covered >= r.end - r.start - 2,
      `protected ${r.start}-${r.end} fully kept (${covered})`,
    );
    for (const p of clip(e.pieces).filter((p) => p.src[1] > r.start + 1 && p.src[0] < r.end - 1))
      assert.equal(p.speed, 1, "protected at 1.0×");
    for (const f of freezes(e.pieces))
      assert.ok(
        !(f.freeze.at > r.start + 1 && f.freeze.at < r.end - 1),
        "no freeze inside typing/clicks",
      );
  }
  for (const p of clip(e.pieces)) {
    assert.ok(p.speed <= LIMITS.speedMax[p.kind] + 1e-6, `${p.kind} speed ${p.speed} ≤ cap`);
    assert.ok(p.speed >= LIMITS.speedMin - 1e-6, `speed ${p.speed} ≥ ${LIMITS.speedMin}`);
  }
  for (const f of freezes(e.pieces)) {
    for (const r of [...input.motion, ...input.stream]) {
      assert.ok(
        !(f.freeze.at > r.start + 1 && f.freeze.at < r.end - 1) || f.freeze.at >= input.end - 40,
        "no freeze over motion/stream",
      );
    }
  }
  // source pieces are in order and non-overlapping
  const srcs = clip(e.pieces);
  for (let i = 1; i < srcs.length; i++)
    assert.ok((srcs[i]?.src[0] ?? 0) >= (srcs[i - 1]?.src[1] ?? 0) - 1, "monotonic source");
  // narration never overlaps
  for (let i = 1; i < e.audio.length; i++) {
    const prev = e.audio[i - 1] as SceneEdit["audio"][number];
    assert.ok(
      (e.audio[i]?.at ?? 0) >= prev.at + (prev.src[1] - prev.src[0]) - 1,
      "narration pieces don't overlap",
    );
  }
  // output length = sum of pieces
  const sum = e.pieces.reduce(
    (n, p) => n + ("src" in p ? (p.src[1] - p.src[0]) / p.speed : p.freeze.dur),
    0,
  );
  assert.ok(
    Math.abs(sum - e.durationMs) < 3,
    `duration ${e.durationMs} = pieces ${sum.toFixed(1)}`,
  );
}

const base = (o: Partial<SceneInput>): SceneInput => ({
  id: "s",
  start: 0,
  end: 10_000,
  protected: [],
  dead: [],
  stream: [],
  motion: [],
  events: {},
  audioMs: 8_000,
  anchors: {},
  ...o,
});

test("classify: precedence protected > dead > stream > motion > static; adjacent merge", () => {
  const iv = classify(
    { start: 0, end: 10 },
    {
      protected: [{ start: 2, end: 4 }],
      dead: [{ start: 3, end: 6 }],
      motion: [{ start: 5, end: 8 }],
    },
  );
  assert.deepEqual(
    iv.map((i) => [i.start, i.end, i.kind]),
    [
      [0, 2, "static"],
      [2, 4, "protected"],
      [4, 6, "dead"],
      [6, 8, "motion"],
      [8, 10, "static"],
    ],
  );
});

test("too much video: dead time is cut FIRST (keeping a beat), before any speed change", () => {
  const span = classify({ start: 0, end: 10_000 }, { dead: [{ start: 3000, end: 7000 }] });
  const r = solveSpan(span, 7000, 0);
  const dead = r.work.find((w) => w.iv.kind === "dead");
  assert.equal(dead?.keep.end, 4000, "3 s of the 4 s spinner cut");
  assert.ok(
    r.work.every((w) => w.speed === 1),
    "no speed change needed",
  );
  assert.equal(Math.round(r.residual), 0);
  const r2 = solveSpan(span, 5000, 0);
  assert.equal(
    r2.work.find((w) => w.iv.kind === "dead")?.keep.end,
    3000 + LIMITS.deadBeatMs,
    "beat kept",
  );
  assert.ok(
    r2.work.filter((w) => w.iv.kind === "static").every((w) => w.speed > 1),
    "then static speeds up",
  );
});

test("anchored narration lands within ±80 ms of its event across typical scenes", () => {
  const scenes: SceneInput[] = [
    // search: type 1–3.5 s, results at 7.6 s after a 4 s spinner; narration shorter than footage
    base({
      end: 11_000,
      protected: [
        { start: 1000, end: 3650 },
        { start: 3800, end: 4400 },
      ],
      dead: [{ start: 4500, end: 7600 }],
      events: { "type-start": 1000, results: 7600 },
      audioMs: 7600,
      anchors: { "type-start": 900, results: 4800 },
    }),
    // dashboard: two hovers, narration LONGER than footage → slow + freeze
    base({ end: 4000, events: { a: 1300, b: 3000 }, audioMs: 8100, anchors: { a: 2500, b: 5200 } }),
    // chat: typing, streaming answer, narration about the same length
    base({
      end: 12_000,
      protected: [{ start: 1500, end: 4200 }],
      stream: [{ start: 5600, end: 9500 }],
      events: { question: 1500, answer: 7800 },
      audioMs: 9000,
      anchors: { question: 1200, answer: 5600 },
    }),
  ];
  for (const s of scenes) {
    const e = solveScene(s);
    assertInvariants(s, e);
    for (const a of e.anchors)
      assert.ok(Math.abs(a.drift) <= 80, `${s.events && a.mark}: drift ${a.drift} ms`);
    const expected = s.audioMs + LIMITS.tailMs;
    assert.ok(
      Math.abs(e.durationMs - expected) / expected <= 0.05,
      `duration ${e.durationMs} vs narration ${expected}`,
    );
  }
});

test("motion is never frozen or sped beyond 1.15×; when video can't shrink, the narrator pauses and the anchor stays in sync", () => {
  // 6 s in-app video, only 2.5 s of narration before the anchor
  const s = base({
    end: 7000,
    motion: [{ start: 500, end: 6500 }],
    events: { end: 6600 },
    audioMs: 3000,
    anchors: { end: 2500 },
  });
  const e = solveScene(s);
  assertInvariants(s, e);
  assert.ok(
    clip(e.pieces)
      .filter((p) => p.kind === "motion")
      .every((p) => p.speed <= 1.15 + 1e-6),
  );
  assert.ok(Math.abs(e.anchors[0]?.drift ?? 99) <= 80, "anchor still lands on its event");
  assert.ok(e.stats.silenceMs > 2500, `narration pause reported (${e.stats.silenceMs} ms)`);
  assert.ok(e.durationMs > s.audioMs + LIMITS.tailMs, "the scene runs longer than its narration");
});

test("narration longer than footage: static slowed (≥ 0.85×) then a settled static frame frozen", () => {
  const s = base({ end: 3000, events: { a: 1000 }, audioMs: 6000, anchors: { a: 1000 } });
  const e = solveScene(s);
  assertInvariants(s, e);
  const f = freezes(e.pieces);
  assert.ok(f.length >= 1);
  assert.ok(
    (f[0]?.freeze.at ?? 0) >= 1000 + LIMITS.settleMs - 1,
    "freeze after the event has settled",
  );
  assert.ok(e.stats.slowedMs > 0);
  assert.ok(Math.abs(e.anchors[0]?.drift ?? 99) <= 80);
});

test("typing longer than its narration is never sped up: video at 1.0×, narration waits for the event", () => {
  const s = base({
    end: 6000,
    protected: [{ start: 500, end: 5500 }],
    events: { done: 5500 },
    audioMs: 2500,
    anchors: { done: 1500 },
  });
  const e = solveScene(s);
  assertInvariants(s, e);
  assert.ok(Math.abs(e.anchors[0]?.drift ?? 99) <= 80);
  assert.ok(e.stats.silenceMs > 3000);
});

test("all-typing span with longer narration: the frame BEFORE the typing starts is held", () => {
  const s = base({
    end: 3000,
    protected: [{ start: 0, end: 2500 }],
    events: { a: 1000 },
    audioMs: 6000,
    anchors: { a: 4000 },
  });
  const e = solveScene(s);
  assertInvariants(s, e);
  assert.equal(freezes(e.pieces)[0]?.freeze.at, 0, "held at the span start, before typing");
  assert.ok(Math.abs(e.anchors[0]?.drift ?? 99) <= 80);
});

test("narration running past an event inside independent motion: late anchor reported, never overlapping", () => {
  const s = base({
    end: 3000,
    motion: [{ start: 0, end: 2500 }],
    events: { a: 1000 },
    audioMs: 6000,
    anchors: { a: 4000 },
  });
  const e = solveScene(s);
  assertInvariants(s, e);
  assert.ok((e.anchors[0]?.drift ?? 0) > 2500, `late anchor reported (${e.anchors[0]?.drift} ms)`);
  assert.equal(e.stats.residualMs, e.anchors[0]?.drift);
});

test("no anchors: whole scene fitted to the narration; anchors missing from the take are ignored", () => {
  const s = base({ end: 9000, events: {}, audioMs: 7000, anchors: { ghost: 2000 } });
  const e = solveScene(s);
  assertInvariants(s, e);
  assert.deepEqual(e.anchors, []);
  assert.equal(e.audio.length, 1);
  assert.ok(Math.abs(e.durationMs - (7000 + LIMITS.tailMs)) <= 3);
});
