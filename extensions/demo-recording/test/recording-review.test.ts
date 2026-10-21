/**
 * Item 7, R0: the recording review's data (per scene: frames as chapter navigation, the storyboard's goal and
 * findings, what the take found there) and the shared chapter list: a click on a chapter or a frame seeks the raw
 * video to that moment, the playhead marks where you are.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { chapterAt, reviewScenes } from "../src/analysis/review.ts";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { clock, frameAt, chapterAt as uiChapterAt } from "../src/panel/public/chapters-core.js";
import { Runtime } from "../src/runtime.ts";
import type { Scene } from "../src/storyboard/types.ts";
import { recordFinding } from "../src/workdir/findings.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";
import { scene, seedReviewTakes } from "./helpers/review-take.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const analysis = (scenes: unknown[]) =>
  ({
    take: "take-002",
    takeDir: "/x",
    storyboardVersion: 1,
    durationMs: 9000,
    scenes,
  }) as TakeAnalysis;

test("frames: in time order, with their kind, a missing file left out; the scene's goal and the findings it names", () => {
  const sb = [
    {
      id: "01-a",
      title: "A",
      takeaway: "Search is name-only",
      emphasis: "the empty state is the story",
      narration_outline: ["open", "type"],
      findings: ["f-0001", "f-0099"],
      steps: [],
    },
  ] as Scene[];
  const out = reviewScenes({
    analysis: analysis([scene("01-a", 0, 4000), scene("02-b", 4000, 9000)]),
    storyboardScenes: sb,
    findings: [
      {
        id: "f-0001",
        at: "",
        source: "agent",
        stage: "discovery",
        kind: "weakness",
        text: "Search ignores descriptions",
        evidence: [],
        state: "use",
      },
    ],
    localize: (f) => (f.endsWith("gone.jpg") ? undefined : f.replace("/x/", "takes/take-002/")),
  });
  const a = out[0];
  assert.deepEqual(
    a?.frames.map((f) => [f.label, f.kind, f.t, f.file]),
    [
      ["start", "start", 100, "takes/take-002/start.jpg"],
      ["m1", "mark", 850, "takes/take-002/m1.jpg"],
      ["alert", "event", 900, undefined],
      ["end", "end", 3900, "takes/take-002/end.jpg"],
    ],
  );
  assert.deepEqual(
    [a?.goal, a?.emphasis, a?.outline],
    ["Search is name-only", "the empty state is the story", ["open", "type"]],
  );
  assert.deepEqual(
    a?.planned.map((p) => [p.id, p.state]),
    [["f-0001", "use"]],
    "an unknown finding id is left out",
  );
  assert.deepEqual(
    [out[1]?.goal, out[1]?.planned, out[1]?.found],
    [undefined, [], []],
    "a scene the storyboard does not know has no goal",
  );
});

test("what the take found: this take's engine findings, by scene or by time; other takes and agent findings are not mixed in", () => {
  const ev = (take: string, t: number, scene?: string) => ({
    type: "take" as const,
    take,
    t,
    ...(scene ? { scene } : {}),
  });
  const eng = (id: string, kind: string, text: string, evidence: ReturnType<typeof ev>[]) =>
    ({
      id,
      at: "",
      source: "engine" as const,
      stage: "recording" as const,
      kind,
      text,
      evidence,
    }) as never;
  const out = reviewScenes({
    analysis: analysis([scene("01-a", 0, 4000), scene("02-b", 4000, 9000)]),
    findings: [
      eng("e1", "error", "error shown: boom", [
        ev("take-001", 100, "01-a"),
        ev("take-002", 3000, "01-a"),
      ]),
      eng("e2", "retry", "resumed after: a click timed out", [ev("take-002", 5000)]),
      eng("e3", "dead-time", "other take only", [ev("take-001", 5000, "02-b")]),
      {
        id: "f-1",
        at: "",
        source: "agent",
        stage: "recording",
        kind: "weakness",
        text: "agent says",
        evidence: [ev("take-002", 100, "01-a")],
      } as never,
    ],
    localize: () => undefined,
  });
  assert.deepEqual(
    out[0]?.found.map((f) => [f.id, f.t]),
    [["e1", 3000]],
    "the evidence of THIS take",
  );
  assert.deepEqual(
    out[1]?.found.map((f) => [f.id, f.t]),
    [["e2", 5000]],
    "a resume has no scene: placed by its time",
  );
});

test("the playhead: the chapter is the last scene that has started, the frame the last one at or before it", () => {
  const scenes = [{ startMs: 0 }, { startMs: 4000 }, { startMs: 9000 }];
  assert.deepEqual(
    [-1, 0, 3999, 4000, 20000].map((t) => chapterAt(scenes, t)),
    [-1, 0, 0, 1, 2],
  );
  assert.deepEqual(
    [-1, 0, 3999, 4000, 20000].map((t) => uiChapterAt(scenes, t)),
    [-1, 0, 0, 1, 2],
    "the same in the page",
  );
  const frames = [{ t: 100 }, { t: 850 }, { t: 3900 }];
  assert.deepEqual(
    [0, 100, 849, 850, 5000].map((t) => frameAt(frames, t)),
    [-1, 0, 0, 1, 2],
  );
  assert.deepEqual(
    [clock(0), clock(1500), clock(65_250), clock(-5)],
    ["0:00.0", "0:01.5", "1:05.3", "0:00.0"],
  );
});

test("the route: each take of the storyboard carries its review scenes (goal, findings it names, what the take found, frames)", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const dir = path.join(seed.dir, "takes", "take-001");
  fs.writeFileSync(
    path.join(dir, "analysis", "analysis.json"),
    JSON.stringify({
      take: "take-001",
      takeDir: dir,
      storyboardVersion: 1,
      durationMs: 6000,
      viewport: { width: 1600, height: 900, dpr: 2 },
      scenes: [scene("01-dash", 0, 6000, { alerts: [{ t: 2500, text: "boom", level: "error" }] })],
      createdAt: "2026-10-15T12:00:00Z",
    }),
  );
  const f = recordFinding(seed.dir, {
    stage: "discovery",
    kind: "weakness",
    text: "Search ignores descriptions",
  });
  fs.writeFileSync(
    path.join(seed.dir, "storyboard", "v1.yaml"),
    `version: 1
app: keycraft
start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    takeaway: The KPIs at a glance
    findings: [${f.id}]
    steps:
      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }
`,
  );
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  try {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/recordings`, {
      headers: { authorization: `Bearer ${panel.token}` },
    });
    const data = (await res.json()) as {
      takes: {
        id: string;
        review: {
          id: string;
          goal?: string;
          planned: { id: string; text: string }[];
          found: { kind: string; text: string; t?: number }[];
          frames: { label: string; kind: string; file?: string }[];
        }[];
      }[];
    };
    const review = data.takes.find((t) => t.id === "take-001")?.review ?? [];
    assert.equal(review.length, 1);
    assert.equal(review[0]?.goal, "The KPIs at a glance");
    assert.deepEqual(
      review[0]?.planned.map((p) => [p.id, p.text]),
      [[f.id, "Search ignores descriptions"]],
    );
    assert.deepEqual(
      review[0]?.found.map((x) => [x.kind, x.t]),
      [["error", 2500]],
      "what the take found, from the engine's findings",
    );
    assert.deepEqual(
      review[0]?.frames.map((x) => [x.label, x.kind, x.file]),
      [
        ["start", "start", undefined],
        ["m1", "mark", undefined],
        ["alert", "event", undefined],
        ["end", "end", undefined],
      ],
      "the stills of this synthetic take are not on disk: frames without a file",
    );
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
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
const skip = (!browserType || !hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

test(
  "in the browser: chapters beside a smaller player that stays in view, on the one scrolling page, the scene's goal and findings above it, chapter bar, [ and ], one take at a time",
  { skip, timeout: 150_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    seedReviewTakes(seed);
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const rect = (sel: string) =>
      `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })()`;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 520 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector(".ds-rv");
      // one take at a time: the production line's take is shown although take-002 is newer; the other is one click away
      assert.equal(await page.locator(".ds-rv").getAttribute("data-take"), "take-001");
      assert.equal(await page.locator(".ds-rv-video").count(), 1, "one player, for the one take");
      assert.equal(await page.locator(".ds-chapter").count(), 3, "three chapters");
      assert.deepEqual(
        await page.locator(".ds-chapter:nth-child(2) .ds-frame-label").allInnerTexts(),
        ["start", "m1", "end"],
      );
      // the player is smaller (at most 40% of the window) and is there from the start
      const video = (await page.evaluate(rect(".ds-rv-video"))) as { height: number };
      assert.ok(video.height <= 520 * 0.4 + 1, `the player is ${video.height}px tall`);
      // the scene above the video: first chapter's goal; the goal and findings of chapter two after a click on its frame
      assert.match(
        await page.locator(".ds-rv-context").innerText(),
        /01-dash[\s\S]*Goal The KPIs at a glance/i,
      );
      await page.click(".ds-chapter:nth-child(2) .ds-frame[data-label=m1]");
      await page.waitForFunction(
        "(() => { const v = document.querySelector('.ds-rv-video'); return v.readyState >= 1 && Math.abs(v.currentTime - 2.7) < 0.15; })()",
      );
      await page.waitForSelector(".ds-rv-context[data-scene='02-search']");
      const ctx = await page.locator(".ds-rv-context").innerText();
      assert.match(ctx, /Goal Search is name-only · the empty state is the story/);
      assert.match(
        ctx,
        /Findings this scene should show[\s\S]*weakness[\s\S]*Search ignores descriptions/,
      );
      assert.match(
        ctx,
        /What this take found here[\s\S]*0:03\.0[\s\S]*error[\s\S]*error shown: "boom"/,
      );
      assert.match(await page.locator(".ds-rv-context").innerText(), /02-search/i);
      assert.equal(
        await page
          .locator(".ds-chapter[data-here=true] .ds-frame[aria-current=true]")
          .getAttribute("data-label"),
        "m1",
        "the frame you are at is marked",
      );
      // a found item goes to its moment
      await page.click(".ds-rv-context [data-act=found]");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 3) < 0.15",
      );
      // the chapter bar: a segment per scene on the take's time line, a click goes there, the current one is marked
      assert.equal(await page.locator(".ds-cbar-seg").count(), 3);
      const seg = (await page.evaluate(rect(".ds-cbar-seg:nth-child(2)"))) as {
        left: number;
        width: number;
      };
      const bar = (await page.evaluate(rect(".ds-cbar"))) as { left: number; width: number };
      assert.ok(
        Math.abs((seg.left - bar.left) / bar.width - 1 / 3) < 0.01,
        "the second scene starts a third in",
      );
      assert.ok(Math.abs(seg.width / bar.width - 1 / 3) < 0.01);
      await page.click(".ds-cbar-seg:nth-child(3)");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 4) < 0.15",
      );
      assert.equal(
        await page.locator(".ds-cbar-seg[aria-current=true]").getAttribute("data-scene"),
        "03-compare",
      );
      assert.equal(await page.locator(".ds-rv-context").getAttribute("data-scene"), "03-compare");
      // [ and ] with focus inside; not in a text field
      await page.focus(".ds-chapter:nth-child(3) .ds-chapter-head");
      await page.keyboard.press("[");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 2) < 0.15",
      );
      await page.keyboard.press("]");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.ds-rv-video').currentTime - 4) < 0.15",
      );
      await page.keyboard.press("]");
      await wait(300);
      assert.ok(
        ((await page.evaluate("document.querySelector('.ds-rv-video').currentTime")) as number) <
          4.5,
        "] at the last chapter stays",
      );
      await page.fill("textarea[aria-label='notes for the next take']", "[ ] typed");
      assert.equal(
        await page.inputValue("textarea[aria-label='notes for the next take']"),
        "[ ] typed",
        "typing keeps its brackets",
      );
      // one scroll, the page's (D145): nothing in the review scrolls on its own, and the ONE thing that sticks is the player (video, chapter bar, note button)
      const inner = await page.evaluate(`[...document.querySelectorAll('.ds-rv, .ds-rv *')]
        .filter((e) => !/^(TEXTAREA|SELECT|INPUT|VIDEO)$/.test(e.tagName) && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
        .map((e) => e.className || e.tagName)`);
      assert.deepEqual(inner, [], "nothing in the review scrolls on its own");
      const sticky = await page.evaluate(`[...document.querySelectorAll('.ds-rv, .ds-rv *')]
        .filter((e) => getComputedStyle(e).position === 'sticky').map((e) => e.className || e.tagName)`);
      assert.deepEqual(sticky, ["ds-rv-player"], "only the player is pinned");
      const hw = (await page.evaluate(
        "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hwrap-h'))",
      )) as number;
      await page.evaluate("window.scrollTo(0, 600)");
      await wait(150);
      const pl = (await page.evaluate(rect(".ds-rv-player"))) as { top: number; bottom: number };
      assert.ok(
        Math.abs(pl.top - (hw + 8)) < 3,
        `the player is pinned at ${pl.top}, header block ${hw}`,
      );
      assert.ok(pl.bottom < 600, `the player (bottom ${pl.bottom}) leaves room: it is small`);
      // the wheel over the player still moves the page: the player is not a scroll area
      await page.evaluate("window.scrollTo(0, 200)");
      await wait(150);
      const pl2 = (await page.evaluate(rect(".ds-rv-player"))) as {
        top: number;
        left: number;
        width: number;
      };
      await page.mouse.move(pl2.left + pl2.width / 2, pl2.top + 60);
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 100);
      await page.waitForFunction("scrollY > 300");
      await page.evaluate("window.scrollTo(0, 0)");
      // the other take: one click, the workspace follows
      await page.click("#take-2 [data-act=review-take]");
      await page.waitForFunction("document.querySelector('.ds-rv')?.dataset.take === 'take-002'");
      assert.equal(await page.locator("[data-act=review-take][aria-pressed=true]").count(), 1);
      // 900 px (the narrowest supported): two columns, nothing sideways
      await page.setViewportSize({ width: 900, height: 520 });
      await wait(200);
      assert.equal(
        await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
        true,
        "no sideways scroll at 900 px",
      );
      const two = (await page.evaluate(rect(".ds-rv-pane"))) as { left: number };
      const list2 = (await page.evaluate(rect(".ds-rv-chapters"))) as { right: number };
      assert.ok(two.left >= list2.right, "side by side at 900 px");
      // below that the columns stack: the player first, so the chapters stay reachable
      await page.setViewportSize({ width: 800, height: 520 });
      await wait(200);
      const narrowPane = (await page.evaluate(rect(".ds-rv-pane"))) as { bottom: number };
      const narrowList = (await page.evaluate(rect(".ds-rv-chapters"))) as { top: number };
      assert.ok(narrowPane.bottom <= narrowList.top + 1, "stacked: the player above the chapters");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
