/**
 * The length budget, part 2 (item 22 PR 2, D-R3-25-7, -9, -14, -15): discovery sized and scope priced to the budget, the engine's checks of a draft (depth first, too
 * small), the engine's length finding, and a voice-over over the ceiling asking to raise it or cut.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { lengthBudget } from "../src/budget/length.ts";
import { savePlannedFor } from "../src/budget/project.ts";
import {
  PRICE_IT,
  budgetPlanWords,
  changesScope,
  priceAreas,
  sceneCountFor,
} from "../src/budget/scope.ts";
import { voLength } from "../src/budget/vo.ts";
import { resolveConfig } from "../src/config.ts";
import { requestMessage } from "../src/discovery/requests.ts";
import { answerFor, askAboutVoLength } from "../src/question-flow.ts";
import { pendingQuestions } from "../src/questions.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { budgetChecks, holdShare, storyboardTiming } from "../src/storyboard/timing.ts";
import { effectiveFacts } from "../src/workdir/brief.ts";
import { engineFindings } from "../src/workdir/findings.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const B10 = lengthBudget({ length: "10 min" }) as NonNullable<ReturnType<typeof lengthBudget>>;

test("how many scenes a target holds, and the price of the declared areas", () => {
  assert.deepEqual(sceneCountFor(600), { lo: 7, hi: 10 });
  assert.deepEqual(sceneCountFor(45), { lo: 1, hi: 1 });
  assert.equal(budgetPlanWords(B10), "10:00 (8:30 to 11:00): about 7 to 10 scenes of 60 to 90 s");
  assert.equal(
    priceAreas(8, B10),
    "8 areas at one scene each: about 8:00 to 12:00 against the budget of 10:00 (8:30 to 11:00): fits",
  );
  assert.match(priceAreas(3, B10), /about 3:00 to 4:30 .*: short: about 4:00 more is needed/);
  assert.match(priceAreas(14, B10), /about 14:00 to 21:00 .*: over: about 3:00 too much/);
});

test("a direction that changes scope is reminded to be priced; one that does not, is not", () => {
  assert.equal(changesScope("add the Explore path and much more on agents"), true);
  assert.equal(changesScope("skip billing, it is not ready"), true);
  assert.equal(changesScope("the dashboard title is wrong"), false);
  assert.match(PRICE_IT, /give its price first: about 60 to 90 s a scene/);
});

test("discovery is told the budget as a plan, or to ask for a target", () => {
  const r = {
    id: "dr-1",
    at: "",
    mode: "start",
    notes: "",
    areas: [],
    budget: { discoveryScreens: 10, discoveryActions: 20, discoveryMinutes: 5 },
    preset: "standard",
    status: "pending",
  } as never;
  const p = { slug: "p", name: "App", url: "https://a.test" };
  const withB = requestMessage("[x]", p, r, { sessions: 0, findings: 0 }, { budget: B10 });
  assert.match(
    withB,
    /The length budget of the final video is 10:00 \(8:30 to 11:00\): about 7 to 10 scenes of 60 to 90 s\. Size the exploration to it/,
  );
  assert.match(withB, /price every area you add or drop in minutes/);
  assert.match(
    requestMessage("[x]", p, r, { sessions: 0, findings: 0 }),
    /The brief has no target length: ask the user for one/,
  );
});

test("the engine's checks of a draft: holds carrying the take (depth first); a second short draft for the same target (too small: ask, never pad)", () => {
  const padded = parseStoryboard(
    "start_url: /\nscenes:\n  - id: a\n    title: A\n    time: 18s\n    steps:\n      - { do: pause, ms: 12s }\n",
    { version: 2 },
  );
  const t = storyboardTiming(padded, { budget: B10 });
  assert.ok(holdShare(t) > 0.2, `holds ${holdShare(t)}`);
  const checks = budgetChecks(t, { verdict: "short", targetSec: 600, version: 1 });
  assert.equal(checks.length, 2);
  assert.match(
    checks[0] ?? "",
    /holds carry \d+ % of the take \(more than 20 %\): depth first, holds last/,
  );
  assert.match(
    checks[1] ?? "",
    /still short of the budget, as v1 was: .*do NOT pad\. Ask the user \(demo_rec_ask\) with the evidence/,
  );
  assert.equal(
    budgetChecks(t, { verdict: "short", targetSec: 300, version: 1 }).length,
    1,
    "another target: not the same miss twice",
  );
  assert.equal(
    budgetChecks(t, { verdict: "fits", targetSec: 600, version: 1 }).length,
    1,
    "the first short draft is only told the projection",
  );
  const plain = storyboardTiming(
    parseStoryboard(
      "start_url: /\nscenes:\n  - id: a\n    title: A\n    steps:\n      - { do: pause, ms: 12s }\n",
      { version: 1 },
    ),
    { budget: B10 },
  );
  assert.equal(budgetChecks(plain).length, 0);
});

test("the engine keeps the length finding: the newest storyboard's projection, and the edit against the budget's own window", () => {
  const seed = seedPanelProject();
  try {
    fs.writeFileSync(path.join(seed.dir, "brief.md"), "# b\n\n- **Target length:** 10 min\n");
    savePlannedFor(seed.dir, 1, B10, { finalMs: 250_000, verdict: "fits", words: "w1" });
    savePlannedFor(seed.dir, 2, B10, {
      finalMs: 250_000,
      verdict: "short",
      words: "projected final 4:10 for a target of 10:00 (8:30 to 11:00): 4:20 short of the floor",
    });
    const found = engineFindings(seed.dir).filter((f) => f.kind === "length");
    const sb = found.find((f) => /^storyboard v2:/.test(f.text));
    assert.ok(sb, found.map((f) => f.text).join(" | "));
    assert.match(sb.text, /4:20 short of the floor/);
    assert.match(sb.suggestion ?? "", /add depth/);
    // the newest is the one that counts: a newer version that fits takes the finding away
    savePlannedFor(seed.dir, 3, B10, { finalMs: 600_000, verdict: "fits", words: "fits" });
    assert.equal(engineFindings(seed.dir).filter((f) => /^storyboard v/.test(f.text)).length, 0);
    assert.equal(effectiveFacts("- **Target length:** 10 min").length?.[0], 510);
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the voice-over's final: each scene its footage or its speech, whichever is longer, plus the other sections and the title", () => {
  const v = {
    timing: [
      { section: "01-a", speechSec: 40, usableSec: 30, ratio: 1.3 },
      { section: "02-b", speechSec: 20, usableSec: 60, ratio: 0.3 },
      { section: "03-c", speechSec: 70, usableSec: 50, ratio: 1.4 },
    ],
    resolved: [
      {
        key: "_intro",
        kind: "intro",
        body: Array.from({ length: 31 }, () => "word").join(" "),
        segments: [],
      },
      { key: "01-a", kind: "scene", body: "x", segments: [] },
    ],
  } as never;
  const l = voLength(v, lengthBudget({ length: "3 min" }) as never, {
    titleMs: 3000,
    wordsPerSecond: 2.58,
  });
  // 3 + 40 + 60 + 70 + 12 = 185 s
  assert.equal(l.finalSec, 185);
  assert.equal(l.verdict, "fits", "3 min: 2:33 to 3:18");
  assert.deepEqual(l.overruns, [
    { section: "03-c", overSec: 20 },
    { section: "01-a", overSec: 10 },
  ]);
  const over = voLength(v, lengthBudget({ length: "2 min" }) as never, {
    titleMs: 3000,
    wordsPerSecond: 2.58,
  });
  assert.equal(over.verdict, "long");
  assert.equal(over.raiseToSec, 210, "rounded up to the next half minute");
  assert.match(
    over.words,
    /^with this voice-over the final is about 3:05 for a target of 2:00 \(1:42 to 2:12\): 0:53 over the ceiling$/,
  );
});

test("a voice-over over the ceiling: one question; 'raise' writes No longer than into the brief, 'cut' asks the Director for a shorter version", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  fs.writeFileSync(path.join(seed.dir, "brief.md"), "# b\n\n- **Target length:** 10 min\n");
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
      finalSec: 700,
      words:
        "with this voice-over the final is about 11:40 for a target of 10:00 (8:30 to 11:00): 0:40 over the ceiling",
      raiseToSec: 720,
      overruns: [{ section: "03-c", overSec: 20 }],
    };
    const q = askAboutVoLength(rt, 4, l, 660);
    assert.ok(q);
    assert.equal(askAboutVoLength(rt, 4, l, 660), undefined, "once per version");
    assert.equal(q?.role, "Voice writer");
    assert.deepEqual(
      q?.options.map((o) => o.word),
      ["raise", "cut"],
    );
    assert.equal(q?.options[0]?.label, "Raise the ceiling to 12:00");
    answerFor(rt, q?.id as string, "raise", "panel");
    const brief = fs.readFileSync(path.join(seed.dir, "brief.md"), "utf8");
    assert.match(brief, /\*\*No longer than:\*\* 12:00 min/);
    assert.equal(
      effectiveFacts(brief).budget?.ceilingSec,
      720,
      "the brief's ceiling is the new one",
    );
    assert.ok(fs.readdirSync(path.join(seed.dir, "brief")).length >= 1, "a new brief version");
    assert.match(notes.join("\n"), /RAISED the length ceiling to 12:00/);
    assert.deepEqual(told, [], "raising starts no turn");
    const q2 = askAboutVoLength(rt, 5, l, 660);
    answerFor(rt, q2?.id as string, "cut", "chat");
    assert.match(
      told.at(-1) ?? "",
      /voice-over v5 CUT to the length ceiling: it makes the final about 11:40, the ceiling is 11:00/,
    );
    assert.match(
      told.at(-1) ?? "",
      /cut where the speech is longer than the footage first \(03-c\)/,
    );
    assert.match(told.at(-1) ?? "", /Do NOT synthesize or approve anything/);
    assert.equal(pendingQuestions(seed.dir).length, 0);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
