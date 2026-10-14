/**
 * S5 part 7 — annotation rendering engine: file format + validation, anchor and
 * target resolution, filter-graph planning, and (with Chromium + ffmpeg) a real
 * render of every type on a synthetic take, checked pixel by pixel.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fullOps, prepareAnnotations } from "../src/annotations/apply.ts";
import {
  annotationVersions,
  readAnnotations,
  validateAnnotations,
  writeAnnotations,
} from "../src/annotations/file.ts";
import { sliceJob } from "../src/annotations/preview.ts";
import {
  type RenderAnnotations,
  zoomFilter,
  zoomProgressExpr,
  zoomRect,
} from "../src/annotations/render.ts";
import { resolveAnnotations, sceneMsToTake, takeToSceneMs } from "../src/annotations/resolve.ts";
import type { AnnotationFile, AnnotationItem } from "../src/annotations/types.ts";
import { resolveBrand } from "../src/brand/brand.ts";
import { variantKey } from "../src/edit/pipeline.ts";
import { filterGraph, frameCounts, planSegments, renderJob, sceneJob } from "../src/edit/render.ts";
import type { SceneTimeline, Timeline } from "../src/edit/timeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// --- a synthetic take: viewport 800×450 @ dpr 2 → source 1600×900 ----------------

const SCENE = {
  id: "s1",
  title: "Scene one",
  audioFile: null,
  // 0–2000 as is, hold 2000 for 1 s, cut 2000–2500, then 2500–4000 → 4.5 s
  pieces: [
    { src: [0, 2000], speed: 1, kind: "static" },
    { freeze: { at: 2000, dur: 1000 } },
    { src: [2500, 4000], speed: 1, kind: "static" },
  ],
  audio: [],
  anchors: [{ mark: "m1", event: 1000, out: 1000, audioAt: 1000, drift: 0 }],
  durationMs: 4500,
  stats: {
    cutMs: 500,
    frozenMs: 1000,
    spedMs: 0,
    slowedMs: 0,
    silenceMs: 0,
    residualMs: 0,
    stretchMs: 0,
    overrunMs: 0,
  },
} as unknown as SceneTimeline;

const TIMELINE = {
  schema: 1,
  take: "take-001",
  voVersion: 1,
  voice: { engine: "say", name: "x" },
  fps: 30,
  size: { width: 960, height: 540 },
  scenes: [SCENE],
  full: [{ type: "scene", id: "s1" }],
  totals: { fullMs: 4500, cutMs: 500, frozenMs: 1000, silenceMs: 0, worstDriftMs: 0 },
} as unknown as Timeline;

function makeProject(withVideo: boolean): string {
  const dir = tmp("ann-proj-");
  const take = path.join(dir, "takes", "take-001");
  fs.mkdirSync(take, { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({
      take: "take-001",
      viewport: { width: 800, height: 450, dpr: 2 },
      captureStats: { width: 1600, height: 900 },
    }),
  );
  const ev = [
    {
      t: 1000,
      type: "hover",
      scene: "s1",
      step: 0,
      mark: "m1",
      box: { x: 100, y: 100, w: 200, h: 60 },
    },
    {
      t: 1300,
      type: "target-settled",
      scene: "s1",
      step: 0,
      box: { x: 110, y: 100, w: 200, h: 60 },
      data: { moved: true },
    },
    {
      t: 3000,
      type: "click",
      scene: "s1",
      step: 1,
      mark: "m2",
      box: { x: 500, y: 300, w: 120, h: 40 },
    },
  ];
  fs.writeFileSync(
    path.join(take, "events.jsonl"),
    `${ev.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  const snap = (t: number) => ({
    t,
    reason: "settle",
    scene: "s1",
    url: "http://x/",
    scroll: { x: 0, y: 0 },
    viewport: { w: 800, h: 450 },
    els: [
      {
        id: "e1",
        role: "table",
        box: { x: 400, y: 200, w: 380, h: 200 },
        text: "Region Churn EMEA 14.2% NA 2.4%",
      },
      { id: "e2", role: "row", box: { x: 400, y: 240, w: 380, h: 30 }, text: "EMEA 14.2%" },
      { id: "e3", role: "cell", box: { x: 600, y: 240, w: 80, h: 30 }, text: "14.2%" },
    ],
  });
  fs.writeFileSync(
    path.join(take, "layout.jsonl"),
    `${[snap(500), snap(2900)].map((s) => JSON.stringify(s)).join("\n")}\n`,
  );
  if (withVideo)
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1600x900:r=30:d=4.2",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-crf",
      "12",
      "-y",
      path.join(take, "raw.mp4"),
    ]);
  return dir;
}

const item = (
  o: Partial<AnnotationItem> & Pick<AnnotationItem, "id" | "type">,
): AnnotationItem => ({
  scene: "s1",
  anchor: { mark: "m1" },
  enabled: true,
  ...o,
});
const fileOf = (items: AnnotationItem[]): AnnotationFile => ({
  version: 1,
  basedOn: { vo: 1 },
  take: "take-001",
  items,
});
const geo = { source: { w: 1600, h: 900 }, viewport: { width: 800, height: 450 } };

// --- file format ----------------------------------------------------------------

test("validation: structure, caps and path-precise errors", () => {
  const ok = fileOf([item({ id: "a", type: "callout", text: "Hi" })]);
  assert.equal(validateAnnotations(ok).items.length, 1);
  const bad = (items: unknown[], re: RegExp) =>
    assert.throws(() => validateAnnotations({ ...ok, items }), re);
  bad(
    [
      { ...item({ id: "a", type: "callout", text: "x" }) },
      { ...item({ id: "a", type: "callout", text: "y" }) },
    ],
    /items\[1\]\.id .*twice/,
  );
  bad([item({ id: "a", type: "highlight" })], /items\[0\]\.target is required for highlight/);
  bad([item({ id: "a", type: "callout", text: "x".repeat(61) })], /≤ 60 characters/);
  bad(
    [item({ id: "a", type: "zoom", target: { step: 0 }, factor: 2.5 })],
    /factor must be 1\.1\.\.1\.8/,
  );
  bad([{ ...item({ id: "a", type: "callout", text: "x" }), type: "arrow" }], /type must be one of/);
  bad(
    [{ ...item({ id: "a", type: "callout", text: "x" }), anchor: { word: 3 } }],
    /anchor must be/,
  );
  bad(
    ["a", "b", "c"].map((id) => item({ id, type: "zoom", target: { step: 0 } })),
    /3 enabled zooms — at most 2/,
  );
  // disabled zooms don't count
  assert.ok(
    validateAnnotations({
      ...ok,
      items: ["a", "b", "c"].map((id, i) =>
        item({ id, type: "zoom", target: { step: 0 }, enabled: i < 2 }),
      ),
    }),
  );
  assert.throws(() => validateAnnotations({ ...ok, take: "t1" }), /take must be a take id/);
});

test("versions: write stores the next version with its number, read validates", () => {
  const dir = tmp("ann-v-");
  const a = writeAnnotations(dir, {
    basedOn: { vo: 1 },
    take: "take-001",
    items: [item({ id: "a", type: "chapter", text: "One", anchor: { sceneStart: true } })],
  });
  const b = writeAnnotations(dir, { basedOn: { vo: 2 }, take: "take-001", items: [] });
  assert.deepEqual([a.version, b.version], [1, 2]);
  assert.deepEqual(annotationVersions(dir), [1, 2]);
  assert.equal(readAnnotations(dir)?.version, 2);
  assert.equal(readAnnotations(dir, 1)?.items[0]?.text, "One");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "annotations", "v1.json"), "utf8")).version,
    1,
  );
  assert.throws(
    () => writeAnnotations(dir, { basedOn: { vo: 1 }, take: "nope", items: [] }),
    /take/,
  );
  assert.deepEqual(annotationVersions(dir), [1, 2], "an invalid file is never stored");
});

// --- time + target resolution ----------------------------------------------------

test("take ↔ scene time through cuts and holds", () => {
  assert.equal(takeToSceneMs(SCENE, 500), 500);
  assert.equal(takeToSceneMs(SCENE, 2000), 2000);
  assert.equal(takeToSceneMs(SCENE, 2200), 3000, "a cut maps to the next kept moment");
  assert.equal(takeToSceneMs(SCENE, 3000), 3500);
  assert.equal(sceneMsToTake(SCENE, 2500), 2000, "inside a hold = the held frame");
  assert.equal(sceneMsToTake(SCENE, 3500), 3000);
});

test("resolve: anchors, lead-in, scaled boxes, settled targets, text targets, warnings", () => {
  const dir = makeProject(false);
  const ctx = { timeline: TIMELINE, takeDir: path.join(dir, "takes", "take-001"), ...geo };
  const r = resolveAnnotations(
    fileOf([
      item({ id: "hl", type: "highlight", target: { step: 0 } }),
      item({
        id: "sp",
        type: "spotlight",
        anchor: { mark: "m2" },
        target: { text: "emea", role: "row" },
      }),
      item({ id: "cell", type: "highlight", anchor: { mark: "m2" }, target: { text: "14.2" } }),
      item({
        id: "box",
        type: "redact",
        anchor: { sceneStart: true },
        target: { box: { x: 10, y: 10, w: 50, h: 20 } },
      }),
      item({
        id: "lay",
        type: "highlight",
        anchor: { mark: "m1", offsetMs: 200 },
        target: { layout: "t500#e1" },
      }),
      item({ id: "ch", type: "chapter", anchor: { sceneStart: true }, text: "Scene one" }),
      item({ id: "gone", type: "callout", anchor: { mark: "nope" }, text: "x" }),
      item({ id: "off", type: "callout", text: "x", enabled: false }),
      item({ id: "huge", type: "highlight", target: { box: { x: 0, y: 0, w: 800, h: 450 } } }),
      item({
        id: "miss",
        type: "highlight",
        anchor: { mark: "m2" },
        target: { text: "nothing like this" },
      }),
    ]),
    ctx,
  );
  const by = Object.fromEntries(r.items.map((x) => [x.id, x]));
  // m1 at 1000 ms (timeline anchor), highlight leads by 150 ms, lasts 2 s
  assert.deepEqual([by.hl?.startMs, by.hl?.atMs, by.hl?.endMs], [850, 1000, 3000]);
  assert.deepEqual(
    by.hl?.box,
    { x: 220, y: 200, w: 400, h: 120 },
    "settled box (x 110), CSS px × 2",
  );
  // m2 = take 3000 → scene 3500; the spotlight is clamped to the scene end (4500)
  assert.equal(by.sp?.atMs, 3500);
  assert.equal(by.sp?.endMs, 4500);
  assert.deepEqual(by.sp?.box, { x: 800, y: 480, w: 760, h: 60 }, "row, not the bigger table");
  assert.deepEqual(
    by.cell?.box,
    { x: 1200, y: 480, w: 160, h: 60 },
    "smallest element containing the text",
  );
  assert.equal(by.box?.endMs, 4500, "redact lasts to the end of the scene");
  assert.equal(by.box?.fadeMs, 0, "redact never fades");
  assert.equal(by.lay?.atMs, 1200);
  assert.equal(by.ch?.startMs, 0);
  assert.equal(by.off, undefined);
  assert.equal(by.gone, undefined);
  assert.equal(by.huge, undefined);
  const w = r.warnings.join("\n");
  assert.match(w, /gone: mark "nope" is not in s1/);
  assert.match(w, /huge: the target covers more than 60 %/);
  assert.match(w, /miss: no element with text "nothing like this"/);
});

test("resolve: overlapping zooms are dropped, overlapping callouts are cut short", () => {
  const dir = makeProject(false);
  const r = resolveAnnotations(
    fileOf([
      item({ id: "z1", type: "zoom", target: { step: 0 } }),
      item({ id: "z2", type: "zoom", anchor: { mark: "m1", offsetMs: 1000 }, target: { step: 1 } }),
      item({ id: "c1", type: "callout", text: "first" }),
      item({ id: "c2", type: "callout", anchor: { mark: "m1", offsetMs: 1000 }, text: "second" }),
    ]),
    { timeline: TIMELINE, takeDir: path.join(dir, "takes", "take-001"), ...geo },
  );
  assert.deepEqual(
    r.items.map((x) => x.id),
    ["z1", "c1", "c2"],
  );
  assert.match(r.warnings.join("\n"), /z2: overlaps zoom z1/);
  const c1 = r.items.find((x) => x.id === "c1");
  const c2 = r.items.find((x) => x.id === "c2");
  assert.equal(c1?.endMs, c2?.startMs, "only one callout at a time");
});

test("zoom geometry: centered, clamped to the frame, factor lowered to keep the target in view", () => {
  const src = { w: 1600, h: 900 };
  const a = zoomRect({ x: 700, y: 400, w: 200, h: 100 }, 1.6, src);
  assert.equal(a.factor, 1.6);
  assert.deepEqual(a.rect, { x: 300, y: 168.75, w: 1000, h: 562.5 });
  const corner = zoomRect({ x: 0, y: 0, w: 100, h: 50 }, 1.5, src);
  assert.deepEqual([corner.rect.x, corner.rect.y], [0, 0], "clamped, never shows outside the page");
  const big = zoomRect({ x: 0, y: 0, w: 1200, h: 300 }, 1.8, src);
  assert.ok(
    Math.abs(big.factor - (1600 / 1200) * 0.85) < 1e-9,
    "lowered so the target fits with margin",
  );
  // progress: 0 before, 1 in the middle, 0 after
  const P = zoomProgressExpr("T", 1000, 4000);
  const at = (T: number) =>
    Function(
      "T",
      `const lt=(a,b)=>a<b?1:0;const iff=(c,a,b)=>c?a:b;return ${P.replace(/if\(/g, "iff(")}`,
    )(T) as number;
  assert.equal(at(0.5), 0);
  assert.ok(Math.abs(at(1.3) - 0.5) < 1e-9);
  assert.equal(at(2), 1);
  assert.equal(at(4.2), 0);
  assert.match(
    zoomFilter({ id: "z", rect: a.rect, startMs: 1000, endMs: 4000 }, src, 30),
    /^perspective=.*interpolation=cubic.*eval=frame:enable='between\(t,1\.000,4\.000\)'$/,
  );
});

// --- filter graph planning --------------------------------------------------------

const OPS: RenderAnnotations = {
  page: [
    {
      id: "hl",
      file: "/x/hl.png",
      w: 100,
      h: 50,
      x: 10,
      y: 10,
      startMs: 850,
      endMs: 3000,
      fadeMs: 200,
      motion: { grow: 0.06, ms: 260 },
    },
  ],
  blurs: [],
  zooms: [{ id: "z", rect: { x: 300, y: 170, w: 1000, h: 562 }, startMs: 3600, endMs: 4500 }],
  screen: [
    {
      id: "co",
      file: "/x/co.png",
      w: 300,
      h: 60,
      x: 40,
      y: 450,
      startMs: 200,
      endMs: 1500,
      fadeMs: 150,
      motion: { dy: 12, ms: 260 },
    },
  ],
};

test("segments: only pieces under page ops / zoom stay at source resolution", () => {
  const job = sceneJob(TIMELINE, "s1", "/p");
  const counts = frameCounts(job.video, 30);
  assert.deepEqual(counts, [60, 30, 45]);
  assert.deepEqual(
    planSegments(counts, 30, undefined).map((s) => s.hi),
    [false],
  );
  const onlyZoom = planSegments(counts, 30, { ...OPS, page: [] });
  assert.deepEqual(
    onlyZoom.map((s) => [s.first, s.last, s.hi]),
    [
      [0, 1, false],
      [2, 2, true],
    ],
  );
  assert.equal(onlyZoom[1]?.startMs, 3000);
  const g = filterGraph(
    job,
    { fps: 30, width: 960, height: 540, source: { w: 1600, h: 900 }, annotations: OPS },
    [],
  );
  // pieces 0–2 are all hi (highlight 0.85–3.0 s, zoom 3.6–4.5 s): no early scale, one scale after the ops
  assert.equal((g.match(/scale=960:540:flags=lanczos/g) ?? []).length, 1);
  assert.match(
    g,
    /\[1:v\]loop=loop=\d+:size=1:start=0,setpts=N\/30\/TB,trim=end=3\.040,format=rgba,scale=w='trunc\(100\*/,
  );
  assert.match(g, /overlay=x='10-\(overlay_w-100\)\/2'/, "highlight settles around its center");
  assert.match(
    g,
    /perspective=.*between\(t,3\.600,4\.500\)/,
    "zoom times are relative to the segment start (0)",
  );
  assert.match(
    g,
    /\[2:v\]loop=.*fade=t=in:st=0\.200:d=0\.150:alpha=1/,
    "screen overlays come after the page ones",
  );
  assert.match(
    g,
    /y='450\+12\*\(1-\(st\(0,clip\(\(t-0\.200\)\/0\.260,0,1\)\)/,
    "callout rises into place",
  );
  assert.ok(g.indexOf("perspective") < g.indexOf("[2:v]"), "zoom before screen-space overlays");
});

test("full video: scene ops shift by the scene start; slices keep source time", () => {
  const prepared = { version: 1, resolved: [], warnings: [], scenes: { s1: OPS } };
  const full = fullOps(prepared, { s1: 2500 });
  assert.equal(full?.zooms[0]?.startMs, 6100);
  assert.equal(full?.screen[0]?.endMs, 4000);
  const sl = sliceJob(
    { ...sceneJob(TIMELINE, "s1", "/p"), audio: [{ file: "a.wav", src: [0, 3000], at: 500 }] },
    1500,
    3800,
  );
  assert.deepEqual(
    sl.video.map((p) => [p.src ?? p.hold, p.durMs]),
    [
      [[1500, 2000], 500],
      [2000, 1000],
      [[2500, 3300], 800],
    ],
  );
  assert.deepEqual(sl.audio, [{ file: "a.wav", src: [1000, 3000], at: 0 }]);
  assert.equal(sl.durationMs, 2300);
  assert.equal(variantKey({ brand: "neutral", annotations: 3 }), "neutral+a3");
  assert.equal(variantKey({ brand: "neutral" }), "neutral");
});

// --- a real render ----------------------------------------------------------------

function rgbCrop(
  file: string,
  t: number,
  box: { x: number; y: number; w: number; h: number },
): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}
const meanDiff = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] as number) - (b[i] as number));
  return s / a.length;
};
/** Fine detail: gradient energy, mean (pixel − right neighbour)² (rgb24) — what a redaction must remove. */
const detail = (a: Buffer) => {
  let d = 0;
  for (let i = 0; i + 3 < a.length; i++) d += ((a[i] as number) - (a[i + 3] as number)) ** 2;
  return d / a.length;
};
const frames = (f: string) =>
  Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      f,
    ]).toString(),
  );

test(
  "render: every type lands where and when it should, nothing else changes",
  { skip, timeout: 240_000 },
  async () => {
    const dir = makeProject(true);
    const root = tmp("ann-root-");
    const raw = path.join(dir, "takes", "take-001", "raw.mp4");
    const file = fileOf([
      item({
        id: "ch",
        type: "chapter",
        anchor: { sceneStart: true },
        text: "Scene one",
        durMs: 1500,
      }),
      item({ id: "hl", type: "highlight", target: { step: 0 } }),
      item({
        id: "rd",
        type: "redact",
        anchor: { sceneStart: true },
        target: { box: { x: 510, y: 290, w: 180, h: 95 } }, // over testsrc2's checkerboard
      }),
      item({ id: "co", type: "callout", anchor: { mark: "m2" }, text: "Look here", durMs: 900 }),
      item({
        id: "zm",
        type: "zoom",
        anchor: { mark: "m2" },
        target: { step: 1 },
        factor: 1.5,
        durMs: 1500,
      }),
    ]);
    const out = { width: 960, height: 540 };
    const prepared = await prepareAnnotations({
      projectDir: dir,
      timeline: TIMELINE,
      file,
      brand: resolveBrand(root, "neutral"),
      output: out,
      footage: { x: 0, y: 0, w: 960, h: 540 },
      cacheDir: path.join(root, "cache"),
    });
    assert.deepEqual(prepared.warnings, []);
    const job = sceneJob(TIMELINE, "s1", dir);
    const base = { fps: 30, ...out, source: { w: 1600, h: 900 } };
    const clean = path.join(dir, "clean.mp4");
    const ann = path.join(dir, "ann.mp4");
    await renderJob(job, raw, clean, base);
    await renderJob(job, raw, ann, {
      ...base,
      annotations: prepared.scenes.s1 as RenderAnnotations,
    });
    assert.equal(frames(ann), frames(clean), "same frame count — annotations never shift time");

    const s = 960 / 1600; // source px → output px
    const outBox = (b: { x: number; y: number; w: number; h: number }) => ({
      x: Math.round(b.x * s),
      y: Math.round(b.y * s),
      w: Math.round(b.w * s),
      h: Math.round(b.h * s),
    });
    // highlight outline, top edge: source (220 − 10, 200 − 10) → output (126, 114), ~2 px thick
    const ring = { x: 140, y: 113, w: 200, h: 3 };
    assert.ok(
      meanDiff(rgbCrop(ann, 1.5, ring), rgbCrop(clean, 1.5, ring)) > 15,
      "highlight outline visible at 1.5 s",
    );
    assert.ok(
      meanDiff(rgbCrop(ann, 0.3, ring), rgbCrop(clean, 0.3, ring)) < 3,
      "no highlight before its lead-in",
    );
    // redact (CSS 510,290 180×95 → source 1020,580 360×190): the checkerboard is gone
    const rd = outBox({ x: 1045, y: 600, w: 310, h: 150 });
    assert.ok(
      detail(rgbCrop(ann, 0.5, rd)) < detail(rgbCrop(clean, 0.5, rd)) * 0.1,
      "redacted region lost its detail",
    );
    assert.ok(
      detail(rgbCrop(ann, 0.0, rd)) < detail(rgbCrop(clean, 0.0, rd)) * 0.1,
      "redact is there from the first frame (no fade)",
    );
    // chapter: lower third, gone after it ends
    const ch = { x: 22, y: 488, w: 100, h: 30 };
    assert.ok(meanDiff(rgbCrop(ann, 0.8, ch), rgbCrop(clean, 0.8, ch)) > 15, "chapter visible");
    // zoom at m2 (scene 3.5 s): whole frame differs mid-zoom, identical after
    const all = { x: 0, y: 0, w: 960, h: 540 };
    assert.ok(
      meanDiff(rgbCrop(ann, 3.9, all), rgbCrop(clean, 3.9, all)) > 10,
      "zoomed in at 3.9 s",
    );
    // callout: bottom left while the zoom runs (screen space — not zoomed)
    const co = { x: 22, y: 500, w: 100, h: 20 };
    assert.ok(meanDiff(rgbCrop(ann, 3.8, co), rgbCrop(clean, 3.8, co)) > 15, "callout visible");
    // a stretch with nothing on it is (encoder noise aside) unchanged
    const quiet = { x: 300, y: 300, w: 300, h: 150 };
    assert.ok(
      meanDiff(rgbCrop(ann, 2.6, quiet), rgbCrop(clean, 2.6, quiet)) < 3,
      "untouched area unchanged",
    );
  },
);
