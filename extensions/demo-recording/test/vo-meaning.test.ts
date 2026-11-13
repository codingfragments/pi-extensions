/**
 * Item 23 PR 1 (R3-24): the voice-over says what it means. The "Meaning" voice direction, narration up to 2× the footage (the warning and the confidence follow),
 * the template's word budget, and the skill's rules and examples.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import {
  STYLES,
  directionText,
  formatDirection,
  parseDirection,
  validateDirection,
} from "../src/panel/voice-routes.ts";
import { voTemplate } from "../src/tools/vo.ts";
import { MAX_SPEECH_RATIO, parseVo, validateVo } from "../src/vo/script.ts";

const take = (usableMs: number): TakeAnalysis =>
  ({
    take: "take-001",
    takeDir: "/x",
    storyboardVersion: 1,
    durationMs: usableMs + 2000,
    viewport: { width: 1600, height: 900, dpr: 2 },
    scenes: [
      {
        id: "01-dash",
        title: "Dash",
        start: 0,
        end: usableMs,
        marks: [{ mark: "m1", t: 500, type: "wait-satisfied" }],
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

const script = (words: number) =>
  `---\ntake: take-001\n---\n## 01-dash — Dash\n[@m1] ${Array.from({ length: words }, (_, i) => `word${i}`).join(" ")}.\n`;

test("the 'Meaning' direction: accepted, said to the Director, kept in the brief's form", () => {
  assert.deepEqual([...STYLES], ["meaning"]);
  const d = validateDirection({ style: "meaning" });
  assert.deepEqual(d, { style: "meaning" });
  assert.throws(() => validateDirection({ style: "poetic" }), /"style" must be one of meaning/);
  const text = directionText({ style: "meaning", stance: "evaluator" });
  assert.match(
    text,
    /^stance: evaluator; style: meaning over description: say what each scene MEANS for this viewer/,
  );
  assert.match(text, /one proof number per scene; the position first, plain words/);
  assert.match(text, /"Meaning over reading the screen" and "Voice and register"/);
  const brief = formatDirection({ stance: "evaluator", style: "meaning" });
  assert.equal(brief, "stance: evaluator · style: meaning");
  assert.deepEqual(parseDirection(brief), { stance: "evaluator", style: "meaning" });
});

test("narration may run up to 2× the footage: no warning below, a warning above that says what to do", () => {
  assert.equal(MAX_SPEECH_RATIO, 2);
  // 10 s of footage; ~2.58 words a second: 45 words ≈ 17 s (×1.7), 60 words ≈ 23 s (×2.3)
  const warnings = (words: number) =>
    validateVo(parseVo(script(words)), take(10_000), "/nowhere")
      .issues.filter((i) => /of footage/.test(i.message))
      .map((i) => i.message);
  assert.deepEqual(warnings(45), [], "1.7× is fine: the edit holds frames to explain");
  const over = warnings(60);
  assert.equal(over.length, 1);
  assert.match(
    over[0] ?? "",
    /\(×2\.\d+, more than ×2\) — too much for the scene: say less, or ask for a longer scene \(its time:\)/,
  );
});

test("the template gives the words that fit and the most to explain, and says to explain", () => {
  const t = voTemplate(take(10_000));
  assert.match(
    t,
    /~10\.0s usable footage → ~24 words fit the footage, up to ~48 to explain \(the edit holds frames\)\. Say what it means, not what it shows\./,
  );
});

test("the skill: the meaning rules, the register rules, the examples, 2× narration; the old screen-reading advice is gone", () => {
  const skill = fs.readFileSync(
    path.join(import.meta.dirname, "..", "skills", "demo-voiceover", "SKILL.md"),
    "utf8",
  );
  for (const must of [
    /## Meaning over reading the screen/,
    /One proof number per scene/,
    /A limit is a consequence, not a fact/,
    /Knowledge from outside the screen.*source.*confidence mark/s,
    /## Voice and register/,
    /Position first/,
    /"We" is the viewer's company/,
    /the "not X but Y" cadence/,
    /em dashes or en dashes/,
    /### Before and after/,
    /768 events from only 9 users, so it is frequent\s+but narrow|768 events from only 9 users, so it is frequent but narrow/,
    /Narration may run up to 2× a scene's usable footage/,
    /\*\*poc:\*\* a verdict, the risks and the honest limits/,
  ])
    assert.match(skill, must);
  assert.doesNotMatch(skill, /keep it within\s+~1\.3×/);
  assert.doesNotMatch(skill, /Dense:\*\* ~155 words per minute, zero filler/);
});
