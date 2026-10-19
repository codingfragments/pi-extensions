/**
 * Item 9a (D-R2-11, R2-3): the facts of two versions. Deterministic, free, instant: counts with their difference, what was
 * added, removed or changed in words and numbers, and the list of ids a Director's verdict may cite.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { compareStoryboardData, compareVersions } from "../src/compare/facts.ts";
import { resolveConfig } from "../src/config.ts";
import { defaultPair } from "../src/panel/public/compare-core.js";
import { Runtime } from "../src/runtime.ts";
import type { Scene, Storyboard } from "../src/storyboard/types.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

test("the seeded storyboards: counts with their difference, what was added, the evidence ids", () => {
  const { dir } = seedPanelProject();
  const c = compareVersions(dir, "storyboard", 1, 2);
  const f = (id: string) => c.facts.find((x) => x.id === id);
  assert.deepEqual([f("scenes")?.a, f("scenes")?.b, f("scenes")?.delta], [1, 3, 2]);
  assert.equal(f("steps")?.delta, 3, "the two new scenes bring steps");
  assert.deepEqual(
    c.changes.map((x) => [x.id, x.kind]),
    [
      ["scene:02-search", "added"],
      ["scene:03-compare", "added"],
      ["scene:01-dash", "same"],
    ],
  );
  assert.match(c.changes[0]?.detail ?? "", /new scene 02-search \(2 steps\)/);
  assert.ok(
    c.evidence.includes("fact:scenes") && c.evidence.includes("scene:03-compare"),
    "a verdict may cite these",
  );
  assert.ok(!c.evidence.includes("scene:99-none"));
  // the other way round: removed
  const back = compareVersions(dir, "storyboard", 2, 1);
  assert.deepEqual(
    back.changes.filter((x) => x.kind === "removed").map((x) => x.id),
    ["scene:02-search", "scene:03-compare"],
  );
  assert.equal(back.facts.find((x) => x.id === "scenes")?.delta, -2);
});

const sc = (id: string, o: Partial<Scene> = {}): Scene =>
  ({ id, title: id, steps: [{ do: "pause", ms: 500, mark: `${id}-m` }], ...o }) as Scene;
const sb = (version: number, scenes: Scene[], title?: string): Storyboard =>
  ({ version, start_url: "/", scenes, ...(title ? { title } : {}) }) as Storyboard;

test("a changed scene says what changed; order, title, goals and findings are facts", () => {
  const a = sb(1, [sc("a"), sc("b", { takeaway: "old" }), sc("c")], "Old title");
  const b = sb(
    2,
    [
      sc("c"),
      sc("a", {
        title: "A renamed",
        takeaway: "new goal",
        steps: [
          { do: "pause", ms: 500, mark: "a-m" },
          { do: "pause", ms: 100, mark: "a-n" },
        ],
      }),
      sc("b", { takeaway: "newer", findings: ["f-0001"] }),
    ],
    "New title",
  );
  const c = compareStoryboardData(a, b);
  const by = (id: string) => c.changes.find((x) => x.id === id);
  assert.match(
    by("scene:a")?.detail ?? "",
    /title “a” → “A renamed”; takeaway added; steps 1 → 2; marks added: a-n/,
  );
  assert.match(by("scene:b")?.detail ?? "", /takeaway reworded; findings 0 → 1/);
  assert.equal(by("scene:c")?.kind, "same");
  assert.equal(by("order")?.kind, "reordered");
  const f = (id: string) => c.facts.find((x) => x.id === id);
  assert.deepEqual(
    [f("title")?.a, f("title")?.b],
    ["Old title", "New title"],
    "a title change is a fact",
  );
  assert.deepEqual([f("goals")?.a, f("goals")?.b], [1, 2]);
  assert.deepEqual([f("findings")?.a, f("findings")?.b], [0, 1]);
  const same = compareStoryboardData(a, { ...a, version: 3 });
  assert.equal(
    same.facts.find((x) => x.id === "title"),
    undefined,
    "no title fact when the title did not change",
  );
  assert.ok(same.changes.every((x) => x.kind === "same"));
});

test("the seeded voice-overs: words, anchors, speech against footage, the section that changed with its word counts", () => {
  const { dir } = seedPanelProject();
  const c = compareVersions(dir, "vo", 1, 2);
  const f = (id: string) => c.facts.find((x) => x.id === id);
  assert.deepEqual([f("sections")?.a, f("sections")?.b], [3, 3]);
  assert.equal(f("words")?.delta, 0, "one number reworded: same length");
  assert.equal(f("anchors")?.a, 2);
  assert.equal(f("take"), undefined, "the same recording: not a fact");
  assert.ok(typeof f("speech")?.a === "number" && typeof f("footage")?.a === "number");
  assert.deepEqual(
    c.changes.map((x) => [x.id, x.kind]),
    [
      ["section:_intro", "same"],
      ["section:01-dash", "changed"],
      ["section:_outro", "same"],
    ],
  );
  assert.match(c.changes[1]?.detail ?? "", /^words \d+ → \d+ \(\+\d+ −\d+\)$/);
  assert.ok(c.evidence.includes("section:01-dash") && c.evidence.includes("fact:words"));
});

test("refusals: the same version, a missing one, a stage that cannot be compared yet, not numbers", () => {
  const { dir } = seedPanelProject();
  assert.throws(() => compareVersions(dir, "storyboard", 1, 1), /two different versions/);
  assert.throws(() => compareVersions(dir, "storyboard", 1, 9), /no storyboard v9/);
  assert.throws(() => compareVersions(dir, "vo", 1, 9), /no voice-over v9/);
  assert.throws(() => compareVersions(dir, "recording", 1, 2), /not available yet/);
  assert.throws(() => compareVersions(dir, "storyboard", Number.NaN, 2), /two version numbers/);
});

test("the route: facts over HTTP, an error is a 400", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const get = (q: string) =>
    fetch(`http://127.0.0.1:${panel.port}/api/compare?${q}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    });
  try {
    const ok = await get("stage=storyboard&a=1&b=2");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as {
      stage: string;
      facts: { id: string }[];
      evidence: string[];
    };
    assert.equal(body.stage, "storyboard");
    assert.ok(
      body.facts.some((x) => x.id === "scenes") && body.evidence.includes("scene:02-search"),
    );
    const bad = await get("stage=storyboard&a=1&b=1");
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /two different versions/);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the default pair: the production line's version against the one you view, else the newest other", () => {
  const rows = [{ version: 1, inLine: true }, { version: 2 }, { version: 3 }];
  assert.deepEqual(defaultPair(rows, 3), [1, 3]);
  assert.deepEqual(
    defaultPair(rows, 1),
    [3, 1],
    "viewing the line's own version: against the newest other",
  );
  assert.deepEqual(defaultPair(rows, null), [1, 3], "nothing viewed: the newest");
  assert.deepEqual(defaultPair(rows, 9), [1, 3], "a version that does not exist is not used");
  assert.deepEqual(
    defaultPair([{ version: 1 }, { version: 2 }], 2),
    [1, 2],
    "no line: the newest other",
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
const skip = !browserType && "needs Playwright Chromium";

test(
  "in the browser: Advanced → Compare two versions… on the storyboard and the voice-over; facts, swap, the same version, Escape",
  { skip, timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/storyboard/v2`);
      await page.waitForSelector("[data-act=advanced]");
      // the menu: one entry, closes with Escape
      await page.click("[data-act=advanced]");
      assert.deepEqual(await page.locator(".ds-advanced li").allInnerTexts(), [
        "Compare two versions…",
      ]);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".ds-advanced ul").isVisible(), false);
      await page.click("[data-act=advanced]");
      await page.click("[data-act=compare-open]");
      await page.waitForSelector(".ds-compare .ds-table");
      // the default pair: the production line's v1 against the version viewed, v2
      assert.equal(await page.inputValue("#cmp-a"), "1");
      assert.equal(await page.inputValue("#cmp-b"), "2");
      const row = (id: string) => page.locator(`[data-fact=${id}]`).innerText();
      assert.match(await row("scenes"), /Scenes\s+1\s+3\s+\+2/);
      assert.match(
        await page.locator("[data-change='scene:02-search']").innerText(),
        /added[\s\S]*Search the catalogue[\s\S]*new scene 02-search \(2 steps\)/,
      );
      assert.match(await page.locator("[data-change='scene:01-dash']").innerText(), /unchanged/);
      // swap: the other way round, scenes removed
      await page.click("[data-act=compare-swap]");
      await page.waitForSelector("[data-change='scene:02-search'][data-kind=removed]");
      assert.match(await row("scenes"), /Scenes\s+3\s+1\s+−2|Scenes\s+3\s+1\s+-2/);
      // the same version twice: said, no table
      await page.selectOption("#cmp-b", "2");
      await page.waitForSelector(".ds-compare .ds-notice");
      assert.match(
        await page.locator(".ds-compare .ds-notice").innerText(),
        /two different versions/,
      );
      assert.equal(await page.locator(".ds-compare .ds-table").count(), 0);
      await page.keyboard.press("Escape");
      await page.waitForSelector(".ds-compare", { state: "detached" });
      // the voice-over
      await page.goto(`${panel.url}#/voice/v2`);
      await page.waitForSelector("[data-act=advanced]");
      await page.click("[data-act=advanced]");
      await page.click("[data-act=compare-open]");
      await page.waitForSelector(".ds-compare .ds-table");
      assert.match(
        await page
          .locator(".ds-compare")
          .getAttribute("data-stage")
          .then((x) => x ?? ""),
        /vo/,
      );
      assert.match(await row("words"), /Words\s+\d+\s+\d+\s+no change/);
      assert.match(
        await page.locator("[data-change='section:01-dash']").innerText(),
        /changed[\s\S]*words \d+ → \d+ \(\+\d+ −\d+\)/,
      );
      assert.match(await page.locator("[data-change='section:_intro']").innerText(), /unchanged/);
      await page.keyboard.press("Escape");
      // a stage that cannot compare yet has no Advanced entry
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector(".ds-stagehead");
      assert.equal(await page.locator("[data-act=advanced]").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
