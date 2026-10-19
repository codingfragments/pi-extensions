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

const scene = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  start,
  end,
  marks: [{ mark: "m1", t: start + 500, type: "wait-satisfied" }],
  typed: [],
  alerts: [],
  idle: [],
  streaming: [],
  motion: [],
  protected: [],
  keyframes: [
    { t: end - 100, label: "end", file: "/x/end.jpg" },
    { t: start + 100, label: "start", file: "/x/start.jpg" },
    { t: start + 850, label: "m1", file: "/x/m1.jpg" },
    { t: start + 900, label: "alert", file: "/x/gone.jpg" },
  ],
  ...extra,
});

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
  "in the browser: chapters with frames, a click on a frame shows the player and seeks, the playhead marks the chapter",
  { skip, timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const dir = path.join(seed.dir, "takes", "take-001");
    // a real six second video, three scenes of two seconds, and a still for each frame
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=10:duration=6",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      path.join(dir, "raw.mp4"),
    ]);
    const kfDir = path.join(dir, "analysis", "keyframes");
    fs.mkdirSync(kfDir, { recursive: true });
    const still = (name: string) => {
      const f = path.join(kfDir, `${name}.jpg`);
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=gray:s=160x90",
        "-frames:v",
        "1",
        f,
      ]);
      return f;
    };
    const mk = (id: string, start: number, end: number) =>
      scene(id, start, end, {
        marks: [{ mark: "m1", t: start + 700, type: "wait-satisfied" }],
        keyframes: [
          { t: start + 100, label: "start", file: still(`${id}-start`) },
          { t: start + 700, label: "m1", file: still(`${id}-m1`) },
          { t: end - 100, label: "end", file: still(`${id}-end`) },
        ],
      });
    fs.writeFileSync(
      path.join(dir, "analysis", "analysis.json"),
      JSON.stringify({
        take: "take-001",
        takeDir: dir,
        storyboardVersion: 1,
        durationMs: 6000,
        viewport: { width: 1600, height: 900, dpr: 2 },
        scenes: [mk("01-dash", 0, 2000), mk("02-search", 2000, 4000), mk("03-compare", 4000, 6000)],
        createdAt: "2026-10-15T12:00:00Z",
      }),
    );
    const f = recordFinding(seed.dir, {
      stage: "discovery",
      kind: "weakness",
      text: "Search ignores descriptions",
    });
    const sbFile = path.join(seed.dir, "storyboard", "v1.yaml");
    fs.writeFileSync(
      sbFile,
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
  - id: 02-search
    title: Search the catalogue
    steps:
      - { do: pause, ms: 600, mark: m1 }
  - id: 03-compare
    title: Compare two results
    steps:
      - { do: pause, ms: 600, mark: m1 }
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
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector(".ds-chapters");
      assert.equal(await page.locator(".ds-chapter").count(), 3, "three chapters");
      assert.equal(
        await page.locator(".ds-chapter:nth-child(2) .ds-frame").count(),
        3,
        "start, the mark and the end",
      );
      assert.deepEqual(
        await page.locator(".ds-chapter:nth-child(2) .ds-frame-label").allInnerTexts(),
        ["start", "m1", "end"],
      );
      assert.equal(
        await page.locator(".take-video").count(),
        0,
        "no player until you ask for a moment",
      );
      // a frame: the player appears and goes to that moment
      await page.click(".ds-chapter:nth-child(2) .ds-frame[data-label=m1]");
      await page.waitForSelector(".take-video");
      await page.waitForFunction(
        "(() => { const v = document.querySelector('.take-video'); return v && v.readyState >= 1 && Math.abs(v.currentTime - 2.7) < 0.15; })()",
      );
      await page.waitForFunction(
        "document.querySelector('.ds-chapter[data-here=true] .ds-chapter-no')?.textContent === '02-search'",
      );
      assert.equal(
        await page
          .locator(".ds-chapter[data-here=true] .ds-frame[aria-current=true]")
          .getAttribute("data-label"),
        "m1",
        "the frame you are at is marked",
      );
      // a chapter title goes to its start
      await page.click(".ds-chapter:nth-child(3) .ds-chapter-head");
      await page.waitForFunction(
        "Math.abs(document.querySelector('.take-video').currentTime - 4) < 0.15",
      );
      assert.equal(
        await page.locator(".ds-chapter[data-here=true] .ds-chapter-no").innerText(),
        "03-compare",
      );
      // the buttons say where they go
      assert.match(
        (await page
          .locator(".ds-chapter:nth-child(1) .ds-frame[data-label=end]")
          .getAttribute("aria-label")) ?? "",
        /^Go to end of Title 01-dash, 0:01\.9$/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
