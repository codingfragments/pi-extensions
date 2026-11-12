/**
 * The length budget (item 22, R3-25, D-R3-25-1 to -15): one target, a window from the tolerances, limits that override one side, old ranges, conflicts, a length named
 * in chat, the holds, the measured voice, a take against the budget and the question it asks.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { holdAt, holdPoints, planScene } from "../src/budget/holds.ts";
import {
  againstBudget,
  budgetWords,
  clock,
  lengthBudget,
  lengthDirection,
  lengthVerdict,
  needsTarget,
  parseLength,
} from "../src/budget/length.ts";
import { takeLength } from "../src/budget/take.ts";
import { rateOf } from "../src/budget/voice-rate.ts";
import { resolveConfig } from "../src/config.ts";
import { answerFor, askAboutLength } from "../src/question-flow.ts";
import { pendingQuestions } from "../src/questions.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { lengthNoteFor } from "../src/tools/project.ts";
import { effectiveFacts, parseTargetLength } from "../src/workdir/brief.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

test("lengths: one number, a range, minutes and seconds", () => {
  assert.deepEqual(parseLength("10 min"), { kind: "single", sec: 600 });
  assert.deepEqual(parseLength("90 s"), { kind: "single", sec: 90 });
  assert.deepEqual(parseLength("2:30"), { kind: "single", sec: 150 });
  assert.deepEqual(parseLength("12.5 min"), { kind: "single", sec: 750 });
  assert.deepEqual(parseLength("about 15 minutes"), { kind: "single", sec: 900 });
  assert.deepEqual(parseLength("3–5 min"), { kind: "range", lo: 180, hi: 300 });
  assert.equal(parseLength("soon"), undefined);
  assert.equal(parseLength("0 min"), undefined);
});

test("one target, the window from the tolerances (default −15 % / +10 %), configurable", () => {
  const b = lengthBudget({ length: "10 min" });
  assert.deepEqual([b?.targetSec, b?.floorSec, b?.ceilingSec], [600, 510, 660]);
  assert.deepEqual(b?.source, { target: "brief", floor: "tolerance", ceiling: "tolerance" });
  assert.equal(budgetWords(b as NonNullable<typeof b>), "10:00 (8:30 to 11:00)");
  const loose = lengthBudget({ length: "10 min" }, { tolerance: { underPct: 20, overPct: 25 } });
  assert.deepEqual([loose?.floorSec, loose?.ceilingSec], [480, 750]);
  assert.deepEqual(parseTargetLength("10 min"), [510, 660]);
});

test("limits override one side each; an old range reads as its middle with its own edges; the depth default the same", () => {
  const f = lengthBudget({ length: "10 min", noShorterThan: "9 min" });
  assert.deepEqual(
    [f?.floorSec, f?.ceilingSec, f?.source.floor, f?.source.ceiling],
    [540, 660, "limit", "tolerance"],
  );
  const c = lengthBudget({ length: "10 min", noLongerThan: "12 min" });
  assert.deepEqual([c?.floorSec, c?.ceilingSec, c?.source.ceiling], [510, 720, "limit"]);
  const r = lengthBudget({ length: "3–5 min" });
  assert.deepEqual(
    [r?.targetSec, r?.floorSec, r?.ceilingSec, r?.source.target],
    [240, 180, 300, "range"],
  );
  const d = lengthBudget({}, { depthDefault: [180, 300] });
  assert.deepEqual(
    [d?.targetSec, d?.floorSec, d?.ceilingSec, d?.source.target],
    [240, 180, 300, "depth"],
  );
  assert.equal(lengthBudget({}), undefined);
});

test("contradictions are named, never guessed; a limit without a target needs a target", () => {
  assert.match(
    lengthBudget({ length: "10 min", noShorterThan: "12 min", noLongerThan: "11 min" })?.conflict ??
      "",
    /the floor \(12:00\) is above the ceiling \(11:00\)/,
  );
  assert.match(
    lengthBudget({ length: "10 min", noShorterThan: "10:30" })?.conflict ?? "",
    /the target \(10:00\) is outside its own limits/,
  );
  assert.equal(lengthBudget({ length: "10 min" })?.conflict, undefined);
  assert.equal(needsTarget({ noLongerThan: "12 min" }), true);
  assert.equal(needsTarget({ length: "10 min", noLongerThan: "12 min" }), false);
  assert.equal(needsTarget({}), false);
  const e = effectiveFacts("# b\n\n- **No longer than:** 12 min\n");
  assert.equal(e.needsTarget, true);
  assert.equal(e.budget, undefined, "no target: no budget");
  const full = effectiveFacts(
    "# b\n\n- **Target length:** 10 min\n- **No shorter than:** 9 min\n",
    { underPct: 15, overPct: 10 },
  );
  assert.deepEqual(full.length, [540, 660], "the window is [floor, ceiling]");
});

test("the verdict and the words", () => {
  const b = lengthBudget({ length: "10 min" }) as NonNullable<ReturnType<typeof lengthBudget>>;
  assert.equal(lengthVerdict(509, b), "short");
  assert.equal(lengthVerdict(510, b), "fits");
  assert.equal(lengthVerdict(660, b), "fits");
  assert.equal(lengthVerdict(661, b), "long");
  assert.equal(
    againstBudget(370, b),
    "projected 6:10 for a target of 10:00 (8:30 to 11:00): 2:20 short of the floor",
  );
  assert.equal(
    againstBudget(700, b, "final"),
    "final 11:40 for a target of 10:00 (8:30 to 11:00): 0:40 over the ceiling",
  );
  assert.equal(
    againstBudget(600, b),
    "projected 10:00 for a target of 10:00 (8:30 to 11:00): fits",
  );
  assert.equal(clock(3725), "1:02:05");
});

test("a length named in chat: what it says, and what the Director must do with it", () => {
  assert.deepEqual(lengthDirection("it's fine if we need to go to a 15 min budget"), {
    target: 900,
  });
  assert.deepEqual(lengthDirection("no shorter than 9 min please"), { floor: 540 });
  assert.deepEqual(lengthDirection("not longer than 12 minutes"), { ceiling: 720 });
  assert.deepEqual(lengthDirection("aim for 10 min, at most 12 min"), {
    ceiling: 720,
    target: 600,
  });
  assert.deepEqual(lengthDirection("at least 90 s"), { floor: 90 });
  assert.equal(lengthDirection("show the search and the dashboard"), undefined);
  assert.equal(lengthDirection("scene 3 needs 2 more steps"), undefined);
  const both = lengthNoteFor({ target: 600, ceiling: 720 });
  assert.match(
    both,
    /write it into the brief NOW \(demo_rec_project write_brief: Target length: 10:00 min, No longer than: 12:00 min; one number for the target, never a range\)/,
  );
  assert.doesNotMatch(both, /ask the user what to aim for/);
  assert.match(
    lengthNoteFor({ ceiling: 720 }),
    /It gives only a limit: ask the user what to aim for \(one number\) with demo_rec_ask, and stop\./,
  );
});

test("holds: the step's own hold, or the gap spread over the points left; 6 s each, a third of the scene at most", () => {
  assert.deepEqual(
    holdAt({ explicitMs: 3000, elapsedMs: 10_000, remainingMs: 0, heldMs: 0, pointsLeft: 1 }),
    { ms: 3000, wantedMs: 3000, capped: false },
  );
  assert.deepEqual(
    holdAt({ explicitMs: 9000, elapsedMs: 0, remainingMs: 0, heldMs: 0, pointsLeft: 1 }).ms,
    6000,
    "an explicit hold is capped too",
  );
  // 30 s scene, 22 s in, 4 s still to come: 4 s gap over 2 points → 2 s here
  assert.deepEqual(
    holdAt({ timeMs: 30_000, elapsedMs: 22_000, remainingMs: 4000, heldMs: 0, pointsLeft: 2 }),
    { ms: 2000, wantedMs: 2000, capped: false },
  );
  // the last point takes the rest, up to 6 s
  assert.deepEqual(
    holdAt({ timeMs: 60_000, elapsedMs: 40_000, remainingMs: 0, heldMs: 0, pointsLeft: 1 }),
    { ms: 6000, wantedMs: 20_000, capped: true },
  );
  // a third of the scene: 12 s scene may hold 4 s in all
  assert.equal(
    holdAt({ timeMs: 12_000, elapsedMs: 4000, remainingMs: 0, heldMs: 3000, pointsLeft: 1 }).ms,
    1000,
  );
  assert.equal(
    holdAt({ timeMs: 10_000, elapsedMs: 12_000, remainingMs: 0, heldMs: 0, pointsLeft: 1 }).ms,
    0,
    "a scene that is already long holds nothing",
  );
  const sb = parseStoryboard(
    "start_url: /\nscenes:\n  - id: a\n    title: A\n    time: 20s\n    steps:\n      - { do: pause, ms: 5s }\n      - { do: pause, ms: 5s, hold: 1s }\n      - { do: pause, ms: 5s }\n",
    { version: 1 },
  );
  assert.deepEqual(holdPoints(sb.scenes[0] as never), [1], "the steps with hold, not the end");
  assert.deepEqual(planScene(sb.scenes[0] as never, [5000, 5000, 5000]), {
    stepsMs: 15_000,
    heldMs: 5000,
    plannedMs: 20_000,
    shortMs: 0,
  });
  const untimed = parseStoryboard(
    "start_url: /\nscenes:\n  - id: a\n    title: A\n    steps:\n      - { do: pause, ms: 5s }\n",
    { version: 1 },
  );
  assert.deepEqual(
    holdPoints(untimed.scenes[0] as never),
    [],
    "no time and no hold: no hold point",
  );
});

test("the storyboard: scene time and step hold are parsed and checked", () => {
  const sb = parseStoryboard(
    'start_url: /\nscenes:\n  - id: a\n    title: A\n    time: "1:15"\n    steps:\n      - { do: pause, ms: 1s, hold: 4s }\n  - id: b\n    title: B\n    time: 2min\n    steps:\n      - { do: pause, ms: 1s }\n',
    { version: 1 },
  );
  assert.equal(sb.scenes[0]?.time, 75_000);
  assert.equal(sb.scenes[0]?.steps[0]?.hold, 4000);
  assert.equal(sb.scenes[1]?.time, 120_000);
  assert.throws(
    () =>
      parseStoryboard(
        "start_url: /\nscenes:\n  - id: a\n    title: A\n    steps:\n      - { do: pause, ms: 1s, hold: 8s }\n",
        { version: 1 },
      ),
    /hold: a hold is at most 6 s/,
  );
  assert.throws(
    () =>
      parseStoryboard(
        "start_url: /\nscenes:\n  - id: a\n    title: A\n    time: 0.5s\n    steps:\n      - { do: pause, ms: 1s }\n",
        { version: 1 },
      ),
    /time: must be between/,
  );
});

test("the voice's measured speed: the aligned words over the audio, once there is enough of it", () => {
  const m = (secs: number, words: number) =>
    ({
      engine: "x",
      voice: { id: "v", name: "v" },
      sections: {
        a: { durationSec: secs, alignment: { words: Array.from({ length: words }, () => ({})) } },
      },
    }) as never;
  assert.equal(rateOf([m(10, 30)]), undefined, "10 s is not enough");
  assert.deepEqual(rateOf([m(30, 75)]), { wordsPerSecond: 2.5, seconds: 30 });
  assert.equal(rateOf([m(30, 20)]), undefined, "40 wpm is a broken measurement");
});

test("a take against the budget: raw less its loading plus the title card; thin scenes named", () => {
  const b = lengthBudget({ length: "10 min" }) as NonNullable<ReturnType<typeof lengthBudget>>;
  const events = [
    { t: 1000, type: "idle-start" },
    { t: 31_000, type: "idle-end" },
  ] as never;
  const l = takeLength({
    rawMs: 400_000,
    events,
    titleMs: 3300,
    budget: b,
    sceneTimes: { a: { shortMs: 5000 }, b: { shortMs: 200 } },
  });
  assert.equal(l.cutMs, 30_000);
  assert.equal(l.finalMs, 373_300);
  assert.equal(l.verdict, "short");
  assert.match(l.words ?? "", /^projected final 6:13 for a target of 10:00/);
  assert.deepEqual(
    l.thinScenes,
    [{ id: "a", shortMs: 5000 }],
    "under a second short does not count",
  );
  assert.equal(
    takeLength({ rawMs: 10_000, events: [], titleMs: 0 }).verdict,
    undefined,
    "no budget, no verdict",
  );
});

test("a take that misses: one question per take; extend starts the Director on a draft, record points at the tab, accept is a quiet note", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const told: string[] = [];
  const notes: string[] = [];
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }), root: seed.root, panelPort: 0 }),
    {
      sendUserMessage: () => {},
      sendMessage: (m: { content: string }) => notes.push(m.content),
    } as never,
  );
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => told.push(t);
  rt.setActiveProject(seed.slug);
  try {
    const l = {
      finalMs: 370_000,
      words: "projected final 6:10 for a target of 10:00 (8:30 to 11:00): 2:20 short of the floor",
      verdict: "short",
      budget: { targetSec: 600 },
    };
    const q = askAboutLength(rt, "take-007", l);
    assert.ok(q);
    assert.equal(askAboutLength(rt, "take-007", l), undefined, "once per take");
    assert.equal(
      askAboutLength(rt, "take-008", { ...l, verdict: "fits" }),
      undefined,
      "a take that fits is not asked about",
    );
    assert.deepEqual(
      q?.options.map((o) => o.word),
      ["accept", "extend", "record"],
    );
    assert.match(q?.what ?? "", /^take-007 misses the length budget: projected final 6:10/);
    answerFor(rt, q?.id as string, "extend", "panel");
    assert.match(
      told.at(-1) ?? "",
      /storyboard EXTENDED to meet the length budget: take-007 is projected at 6:10 for a target of 10:00/,
    );
    assert.match(told.at(-1) ?? "", /depth first/);
    assert.match(told.at(-1) ?? "", /Do NOT record and do NOT approve anything/);
    const q2 = askAboutLength(rt, "take-009", l);
    const before = told.length;
    answerFor(rt, q2?.id as string, "accept", "chat");
    assert.equal(told.length, before, "accepting starts no turn");
    assert.match(notes.join("\n"), /The user ACCEPTS take-009 at its length/);
    assert.equal(pendingQuestions(seed.dir).length, 0);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("config: length.toleranceUnderPct and toleranceOverPct default 15 and 10, 0 to 50, named in errors", () => {
  const read = (json: unknown) =>
    resolveConfig({
      env: { DEMO_REC_CONFIG: "/x.json" },
      home: "/h",
      readFile: () => JSON.stringify(json),
    });
  assert.deepEqual(resolveConfig({ env: {}, home: "/h", readFile: () => undefined }).length, {
    toleranceUnderPct: 15,
    toleranceOverPct: 10,
  });
  assert.deepEqual(read({ length: { toleranceUnderPct: 20, toleranceOverPct: 5 } }).length, {
    toleranceUnderPct: 20,
    toleranceOverPct: 5,
  });
  assert.throws(
    () => read({ length: { toleranceOverPct: 60 } }),
    /"length\.toleranceOverPct" must be a number of percent from 0 to 50/,
  );
  assert.throws(() => read({ length: { toleranceUnderPct: "x" } }), /length\.toleranceUnderPct/);
});

test("the projection uses the project's own dead time once it has an analyzed take", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cut-share-"));
  try {
    const t = path.join(dir, "takes", "take-001", "analysis");
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(
      path.join(t, "analysis.json"),
      JSON.stringify({ durationMs: 100_000, scenes: [{ idle: [{ start: 0, end: 20_000 }] }] }),
    );
    return import("../src/budget/project.ts").then(({ measuredCutShare }) => {
      assert.equal(measuredCutShare(dir), 0.2);
      assert.equal(measuredCutShare(path.join(dir, "nope")), undefined);
    });
  } finally {
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 50);
  }
});
