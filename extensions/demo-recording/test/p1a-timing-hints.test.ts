/**
 * P1c PR 19 (Q6): timing hints. `[@mark +300ms]` in the script says the narration after the mark starts 300 ms after its event (negative:
 * before). It is never spoken, never synthesised, never part of the cache key, and the sync edit honours it, so changing it costs no audio.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { type SceneInput, solveScene } from "../src/edit/sync.ts";
import { cacheKey } from "../src/tts/synthesize.ts";
import { wordDiff } from "../src/util/worddiff.ts";
import {
  HINT_MAX_MS,
  anchorToken,
  hintsOf,
  parseVo,
  splitSegments,
  validateVo,
} from "../src/vo/script.ts";

const take = (): TakeAnalysis =>
  ({
    take: "take-001",
    takeDir: "/x",
    storyboardVersion: 1,
    durationMs: 20000,
    viewport: { width: 1600, height: 900, dpr: 2 },
    scenes: [
      {
        id: "01-dash",
        title: "d",
        start: 700,
        end: 9000,
        marks: [
          { mark: "m1", t: 2000, type: "wait-satisfied" },
          { mark: "m2", t: 5000, type: "wait-satisfied" },
        ],
        typed: [],
        alerts: [],
        idle: [],
        streaming: [],
        motion: [],
        protected: [],
        keyframes: [],
      },
    ],
    createdAt: "",
  }) as unknown as TakeAnalysis;

const script = (body: string) => `---\ntake: take-001\n---\n## 01-dash\n${body}\n`;

test("syntax: a sign, a number and ms or s; − is accepted; no hint is no hint", () => {
  const segs = splitSegments(
    "Start. [@m1 +300ms] Then this. [@m2 -0.5s] And that. [@m3 −1200 ms] Last. [@m4] Plain.",
  );
  assert.deepEqual(
    segs.map((s) => [s.anchor, s.hintMs, s.text]),
    [
      [undefined, undefined, "Start."],
      ["m1", 300, "Then this."],
      ["m2", -500, "And that."],
      ["m3", -1200, "Last."],
      ["m4", undefined, "Plain."],
    ],
  );
  assert.equal(anchorToken("m1"), "[@m1]");
  assert.equal(anchorToken("m1", 300), "[@m1 +300ms]");
  assert.equal(anchorToken("m1", -250), "[@m1 -250ms]");
  assert.equal(anchorToken("m1", 0), "[@m1 +0ms]");
});

test("a hint is never spoken and never part of what is synthesised or cached", () => {
  const plain = splitSegments("Hello there. [@m1] EMEA leads. [@m2] Done.");
  const hinted = splitSegments("Hello there. [@m1 +300ms] EMEA leads. [@m2 -200ms] Done.");
  const spoken = (s: { text: string }[]) =>
    s
      .map((x) => x.text)
      .join(" ")
      .trim();
  assert.equal(spoken(hinted), spoken(plain));
  assert.equal(
    cacheKey("eleven:v", spoken(hinted)),
    cacheKey("eleven:v", spoken(plain)),
    "the same audio: no credits",
  );
  assert.doesNotMatch(spoken(hinted), /ms|\+300|\[/);
});

test("validation: malformed anchors are errors (they would be spoken), big hints warn, huge ones are refused", () => {
  const v = (body: string) => validateVo(parseVo(script(body)), take(), "/nowhere");
  const issues = (body: string) => v(body).issues.map((i) => `${i.level}: ${i.message}`);
  assert.deepEqual(
    issues("One. [@m1 +300ms] Two. [@m2 -300ms] Three.").filter((i) => /error/.test(i)),
    [],
  );
  for (const bad of [
    "[@m1 300ms]",
    "[@m1 +300]",
    "[@m1 +300 minutes]",
    "[@M1]",
    "[@m1 + 300ms]",
    "[@m1 +ms]",
  ]) {
    const got = issues(`One. ${bad} Two.`).join("\n");
    assert.match(
      got,
      new RegExp(
        `error: "${bad.replace(/[[\]+]/g, "\\$&")}" is not an anchor: write \\[@mark\\], or a timing hint like \\[@mark \\+300ms\\]`,
      ),
      bad,
    );
  }
  assert.match(
    issues("One. [@m1 +2000ms] Two.").join("\n"),
    /warning: \[@m1\] \+2000 ms is a big shift/,
  );
  assert.match(
    issues(`One. [@m1 +${HINT_MAX_MS + 1}ms] Two.`).join("\n"),
    /error: \[@m1 \+3001ms\]: a timing hint is at most ±3000 ms \(move the anchor instead\)/,
  );
  assert.match(issues("One. [@m1 -9s] Two.").join("\n"), /error: \[@m1 -9000ms\]/);
  // an unknown mark is still reported as before, hint or not
  assert.match(issues("One. [@nope +100ms] Two.").join("\n"), /\[@nope\] is not a mark of 01-dash/);
});

test("hintsOf: by scene and mark; zero and none are left out", () => {
  const s = parseVo(script("A. [@m1 +300ms] B. [@m2 +0ms] C."));
  assert.deepEqual(hintsOf(s), { "01-dash": { m1: 300 } });
  assert.deepEqual(hintsOf(parseVo(script("A. [@m1] B."))), {});
});

test("the word diff shows a changed hint as one change, not as stray words", () => {
  const parts = wordDiff("Hello. [@m1 +300ms] EMEA leads.", "Hello. [@m1 +500ms] EMEA leads.");
  assert.deepEqual(
    parts.map((p) => [p.op, p.text]),
    [
      ["eq", "Hello."],
      ["del", "[@m1 +300ms]"],
      ["ins", "[@m1 +500ms]"],
      ["eq", "EMEA leads."],
    ],
  );
  assert.deepEqual(
    wordDiff("a [@m1] b", "a [@m1] b").map((p) => p.op),
    ["eq"],
  );
});

// --- the sync edit ------------------------------------------------------------------------------

const scene = (o: Partial<SceneInput> = {}): SceneInput => ({
  id: "s",
  start: 0,
  end: 12_000,
  protected: [],
  dead: [],
  stream: [],
  motion: [],
  events: { a: 3000, b: 7000 },
  audioMs: 9000,
  anchors: { a: 3000, b: 7000 },
  ...o,
});

test("the sync edit starts the narration after the anchor at its event plus the hint, exactly, when the video can absorb it", () => {
  const none = solveScene(scene());
  assert.deepEqual(
    none.anchors.map((a) => [a.mark, a.hint, a.drift, a.audioAt - a.out]),
    [
      ["a", 0, 0, 0],
      ["b", 0, 0, 0],
    ],
  );
  for (const h of [300, -300, 1000, -800]) {
    const e = solveScene(scene({ hints: { a: h } }));
    const a = e.anchors.find((x) => x.mark === "a");
    const b = e.anchors.find((x) => x.mark === "b");
    assert.equal(a?.hint, h);
    assert.equal(a?.audioAt, (a?.out ?? 0) + h, `@a narration starts ${h} ms after its event`);
    assert.equal(a?.drift, 0, "the hint is met: no deviation");
    assert.ok(Math.abs(b?.drift ?? 99) <= 80, `@b stays on its event (${b?.drift})`);
    // the narration never overlaps itself
    for (let i = 1; i < e.audio.length; i++) {
      const p = e.audio[i - 1] as (typeof e.audio)[number];
      assert.ok((e.audio[i] as (typeof e.audio)[number]).at >= p.at + (p.src[1] - p.src[0]) - 1);
    }
  }
});

test("a hint moves the picture's event against the narration, not the narration: the speech keeps its place; a hint on a missing anchor is ignored", () => {
  const late = solveScene(scene({ hints: { b: 600 } }));
  const b = late.anchors.find((x) => x.mark === "b");
  assert.deepEqual(
    [b?.out, b?.audioAt, b?.drift],
    [6400, 7000, 0],
    "the event comes 600 ms before its narration; the speech did not move",
  );
  assert.deepEqual(
    late.audio,
    solveScene(scene()).audio,
    "the narration pieces are the same, so the same audio",
  );
  assert.deepEqual(
    solveScene(scene({ hints: { zzz: 500 } })).anchors.map((a) => a.hint),
    [0, 0],
  );
});

test("typing and clicks are never sped up or cut to meet a hint: the hold goes in as a held frame, and the hint is still met", () => {
  const protectedAll = [{ start: 0, end: 12_000 }];
  for (const h of [-500, 500]) {
    const e = solveScene(scene({ protected: protectedAll, hints: { b: h } }));
    const b = e.anchors.find((x) => x.mark === "b");
    assert.equal(b?.drift, 0, `hint ${h} met`);
    assert.equal(b?.audioAt, (b?.out ?? 0) + h);
    for (const piece of e.pieces)
      if ("src" in piece) assert.equal(piece.speed, 1, "protected stays at 1.0×");
    assert.equal(e.stats.cutMs, 0);
  }
});

test("drift is the deviation from the intended offset, so everything that reads it (QA, the fit check, the edit report) keeps its meaning", () => {
  const e = solveScene(scene({ hints: { a: 700, b: -400 } }));
  for (const a of e.anchors) assert.equal(a.drift, a.audioAt - a.out - a.hint);
  assert.ok(
    e.anchors.every((a) => Math.abs(a.drift) <= 80),
    "hints met: no off-sync warning in the edit report",
  );
});
