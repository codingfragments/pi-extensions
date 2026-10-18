/**
 * P1c PR 19 (Q6): timing hints. `[@mark +300ms]` in the script says the narration after the mark starts 300 ms after its event (negative:
 * before). It is never spoken, never synthesised, never part of the cache key, and the sync edit honours it, so changing it costs no audio.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { resolveConfig } from "../src/config.ts";
import { type SceneInput, solveScene } from "../src/edit/sync.ts";
import { hintIn, hintWords, withHint } from "../src/panel/public/hints.js";
import { Runtime } from "../src/runtime.ts";
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
import { readVo, voVersions } from "../src/vo/store.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

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

// --- the nudge controls ------------------------------------------------------------------------

test("hints.js: read and write a hint in the narration text", async () => {
  const t = "Hello. [@m1] EMEA. [@m2 -200ms] Done.";
  assert.deepEqual([hintIn(t, "m1"), hintIn(t, "m2"), hintIn(t, "zz")], [0, -200, null]);
  assert.equal(withHint(t, "m1", 300), "Hello. [@m1 +300ms] EMEA. [@m2 -200ms] Done.");
  assert.equal(withHint(t, "m2", 0), "Hello. [@m1] EMEA. [@m2] Done.");
  assert.equal(
    withHint(withHint(t, "m1", 300), "m1", 400),
    "Hello. [@m1 +400ms] EMEA. [@m2 -200ms] Done.",
  );
  assert.equal(
    withHint(t, "m1", 99999),
    "Hello. [@m1 +3000ms] EMEA. [@m2 -200ms] Done.",
    "clamped",
  );
  assert.equal(withHint(t, "zz", 100), t, "a mark that is not there changes nothing");
  assert.equal(hintIn("a [@m1 +0.5s] b", "m1"), 500);
  assert.deepEqual(
    [hintWords(0), hintWords(300), hintWords(-150)],
    ["starts on the moment", "starts 300 ms after the moment", "starts 150 ms before the moment"],
  );
  // what the panel writes, the engine reads back
  assert.deepEqual(
    splitSegments(withHint(t, "m1", 300)).map((s) => s.hintMs),
    [undefined, 300, -200],
  );
});

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

test(
  "in the browser: nudge the narration at an anchor, save a version, the engine reads the hint; the voice is the same",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(
      () => ({
        ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
        root: seed.root,
        panelPort: 0,
      }),
      { sendUserMessage: () => {}, sendMessage: () => {} },
    );
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
      await page.goto(`${panel.url}#/voice/v1`);
      await page.click(".ds-item[data-key='01-dash']");
      const m1 = page.locator(".ds-anchor[data-mark=m1] .ds-nudge");
      await m1.waitFor();
      assert.match(await m1.innerText(), /Narration starts on the moment/);
      assert.equal(await m1.locator("[data-act=nudge-reset]").count(), 0, "nothing to reset yet");
      for (let i = 0; i < 3; i++) await m1.locator("[data-act=nudge-later]").click();
      assert.match(await m1.innerText(), /Narration starts 300 ms after the moment/);
      assert.match(await page.locator("textarea[id^=narration-]").inputValue(), /\[@m1 \+300ms\]/);
      await page.getByText("Edited in draft").first().waitFor();
      for (let i = 0; i < 5; i++) await m1.locator("[data-act=nudge-earlier]").click();
      assert.match(await m1.innerText(), /Narration starts 200 ms before the moment/);
      assert.match(await page.locator("textarea[id^=narration-]").inputValue(), /\[@m1 -200ms\]/);
      await m1.locator("[data-act=nudge-reset]").click();
      assert.doesNotMatch(
        await page.locator("textarea[id^=narration-]").inputValue(),
        /\[@m1 [+-]/,
      );
      // a nudge on the second anchor, then save as a version
      await page.locator(".ds-anchor[data-mark=m2] [data-act=nudge-later]").click();
      await page.locator(".ds-anchor[data-mark=m2] [data-act=nudge-later]").click();
      if (process.env.P1A_SHOTS)
        await page
          .locator(".ds-anchors")
          .screenshot({ path: `${process.env.P1A_SHOTS}-nudge.png` });
      const before = voVersions(seed.dir);
      await page.getByRole("button", { name: /Save new version/ }).click();
      await page.waitForFunction(
        `document.body.innerText.includes("v${(before.at(-1) ?? 1) + 1}")`,
      );
      const after = voVersions(seed.dir);
      assert.equal(after.length, before.length + 1);
      const saved = readVo(seed.dir, after.at(-1) as number);
      assert.deepEqual(
        saved?.validated.issues.filter((i) => i.level === "error"),
        [],
      );
      assert.deepEqual(hintsOf(saved?.validated.script as never), { "01-dash": { m2: 200 } });
      // the words are the same as the version it was made from, so the same audio
      const spoken = (v: ReturnType<typeof readVo>) =>
        v?.validated.script.sections.map((s) => s.segments.map((g) => g.text).join(" ")).join("|");
      assert.equal(spoken(saved), spoken(readVo(seed.dir, 1)));
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
