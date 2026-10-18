/**
 * S5 part 9 — the Render stage: gate, options, annotation selection, variants
 * and reuse, pruning and delete, transcripts and cues, next-step texts, a real
 * draft + final render on a synthetic take (Chromium + ffmpeg), and the panel
 * routes.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { writeAnnotations } from "../src/annotations/file.ts";
import { resolveConfig } from "../src/config.ts";
import type { SceneTimeline, Timeline } from "../src/edit/timeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import {
  finalBlocker,
  normalizeOptions,
  planRender,
  reuseKey,
  runRender,
} from "../src/render/run.ts";
import {
  deleteRenderFiles,
  legacyRenders,
  listRenders,
  pruneDrafts,
  readRender,
  renderNames,
  saveRecord,
  startRecord,
  variantName,
} from "../src/render/store.ts";
import {
  MAX_LINE,
  buildCues,
  fullWords,
  sceneWords,
  toVtt,
  wrap,
} from "../src/render/subtitles.ts";
import { Runtime } from "../src/runtime.ts";
import { writeZip } from "../src/util/zip.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { nextStep } from "../src/workdir/stages.ts";
import { acceptStage, acceptTake, approve, readState } from "../src/workdir/state.ts";
import { editDraft } from "./helpers/annotation-drafts.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const renderSkip =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-render-"));
  process.env.DEMO_REC_CONFIG = path.join(root, "none.json");
  process.env.DEMO_REC_NO_OPEN = "1";
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const config = () => ({
  ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
  root,
  panelPort: 0,
});

// One scene of 4 s; narration section audio 0–3 s played from 0.5 s; an intro card of 2 s before it.
const SCENE = {
  id: "01-a",
  title: "First",
  audioFile: "vo/audio/s1.wav",
  pieces: [{ src: [0, 4000], speed: 1, kind: "static" }],
  audio: [{ src: [0, 3000], at: 500 }],
  anchors: [{ mark: "m1", event: 1500, out: 1500, audioAt: 1500, drift: 0 }],
  durationMs: 4000,
  stats: {
    cutMs: 0,
    frozenMs: 0,
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
  full: [
    {
      type: "card",
      kind: "intro",
      holdAt: 0,
      durationMs: 2000,
      audio: { file: "vo/audio/intro.wav", src: [0, 1200] },
    },
    { type: "scene", id: "01-a" },
  ],
  totals: { fullMs: 6000, cutMs: 0, frozenMs: 0, silenceMs: 0, worstDriftMs: 0 },
} as unknown as Timeline;

const SCENE_WORDS = ["Look", "here.", "Three", "point", "one", "percent", "churn."].map((w, i) => ({
  w,
  seg: 0,
  s: i * 0.35,
  e: i * 0.35 + 0.3,
}));
const INTRO_WORDS = ["Hello", "there."].map((w, i) => ({
  w,
  seg: 0,
  s: i * 0.4,
  e: i * 0.4 + 0.35,
}));

function project(withMedia = false) {
  const h = ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
  const dir = h.dir;
  fs.mkdirSync(path.join(dir, "storyboard"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "storyboard", "v1.yaml"),
    "version: 1\nstart_url: /\nscenes:\n  - id: 01-a\n    title: First\n    steps:\n      - { do: hover, target: { css: '#k' }, mark: m1, dwell: 1s }\n",
  );
  const take = path.join(dir, "takes", "take-001");
  fs.mkdirSync(take, { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({
      take: "take-001",
      status: "ok",
      storyboardVersion: 1,
      viewport: { width: 800, height: 450, dpr: 2 },
      captureStats: { width: 1600, height: 900 },
    }),
  );
  fs.writeFileSync(
    path.join(take, "events.jsonl"),
    `${JSON.stringify({ t: 1500, type: "hover", scene: "01-a", step: 0, mark: "m1", box: { x: 100, y: 100, w: 200, h: 60 } })}\n`,
  );
  fs.writeFileSync(path.join(take, "layout.jsonl"), "");
  fs.mkdirSync(path.join(dir, "vo", "audio"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vo", "script.v1.md"),
    "---\ntake: take-001\n---\n## _intro\nHello there.\n\n## 01-a — First\nLook here. [@m1] Three point one percent churn.\n",
  );
  fs.writeFileSync(
    path.join(dir, "vo", "audio", "v1.json"),
    JSON.stringify({
      schema: 1,
      voVersion: 1,
      take: "take-001",
      sections: {
        _intro: {
          key: "_intro",
          file: "vo/audio/intro.wav",
          alignment: { durationSec: 1.2, words: INTRO_WORDS, anchors: {}, source: "transcript" },
        },
        "01-a": {
          key: "01-a",
          file: "vo/audio/s1.wav",
          alignment: {
            durationSec: 3,
            words: SCENE_WORDS,
            anchors: { m1: 1 },
            source: "transcript",
          },
        },
      },
    }),
  );
  if (withMedia) {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1600x900:r=30:d=4.2",
      "-pix_fmt",
      "yuv420p",
      "-y",
      path.join(take, "raw.mp4"),
    ]);
    for (const [f, d] of [
      ["s1.wav", 3],
      ["intro.wav", 1.2],
    ] as const)
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${d}`,
        "-ar",
        "48000",
        "-y",
        path.join(dir, "vo", "audio", f),
      ]);
  }
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  fs.writeFileSync(path.join(dir, "edit", "timeline.v1.json"), JSON.stringify(TIMELINE));
  approve(dir, "storyboard", 1);
  acceptTake(dir, "take-001");
  approve(dir, "vo", 1);
  return dir;
}

const ANN = (dir: string, items: unknown[]) =>
  writeAnnotations(dir, { basedOn: { vo: 1 }, take: "take-001", items: items as never });
const CALLOUT = {
  id: "co",
  type: "callout",
  scene: "01-a",
  anchor: { mark: "m1" },
  text: "Headline churn",
  enabled: true,
};
const CHAPTER = {
  id: "ch",
  type: "chapter",
  scene: "01-a",
  anchor: { sceneStart: true },
  text: "First",
  enabled: true,
};
const REDACT = {
  id: "rd",
  type: "redact",
  scene: "01-a",
  anchor: { sceneStart: true },
  target: { box: { x: 10, y: 10, w: 50, h: 20 } },
  enabled: true,
};

// --- options, gate, selection --------------------------------------------------------

test("options and variant names", () => {
  assert.deepEqual(normalizeOptions(undefined), {
    annotationTypes: "all",
    subtitles: false,
    logoBug: true,
  });
  assert.deepEqual(
    normalizeOptions({ annotationTypes: ["chapter", "callout", "chapter"] }).annotationTypes,
    ["callout", "chapter"],
  );
  assert.throws(() => normalizeOptions({ annotationTypes: ["arrow" as never] }), /annotationTypes/);
  assert.equal(variantName("neutral", normalizeOptions({})), "neutral");
  assert.equal(variantName("acme", normalizeOptions({ annotationTypes: [] })), "acme_plain");
  assert.equal(
    variantName("acme", normalizeOptions({ annotationTypes: ["chapter"], logoBug: false })),
    "acme_chapters-only_nobug",
  );
  assert.equal(
    variantName("acme", normalizeOptions({ annotationTypes: ["chapter", "callout"] })),
    "acme_callout-chapter-only",
  );
  const n = renderNames("my-demo", "final", 3, "acme_callouts-only");
  assert.equal(n.full, "my-demo_final-v3_acme_callouts-only.mp4");
  assert.equal(n.fullSubtitled, "my-demo_final-v3_acme_callouts-only_subtitled.mp4");
  assert.equal(n.vtt, "my-demo_final-v3_acme_callouts-only_transcript.vtt");
  assert.equal(n.callouts, "my-demo_final-v3_acme_callouts-only_callouts.srt");
  assert.equal(n.poster, "my-demo_final-v3_acme_callouts-only_poster.jpg");
  assert.equal(
    n.scene("01-dashboard"),
    "scenes/my-demo_final-v3_acme_callouts-only_01-dashboard.mp4",
  );
  assert.equal(
    n.sceneSubtitled("01-dashboard"),
    "scenes/my-demo_final-v3_acme_callouts-only_01-dashboard_subtitled.mp4",
  );
});

test("final gate: needs an accepted, usable annotation version; drafts don't", () => {
  const dir = project();
  const cfg = config();
  assert.match(finalBlocker(dir) ?? "", /needs an approved annotation version/);
  assert.throws(
    () => planRender(dir, cfg, { kind: "final", by: "cli" }),
    /needs an approved annotation version/,
  );
  const v = ANN(dir, [CALLOUT, CHAPTER]);
  assert.match(finalBlocker(dir, v.version) ?? "", /not approved/);
  assert.equal(
    planRender(dir, cfg, { kind: "draft", by: "cli" }).annotationVersion,
    1,
    "a draft follows the newest annotations of the VO",
  );
  assert.equal(
    planRender(dir, cfg, { kind: "draft", annotations: null, by: "cli" }).file,
    undefined,
    "or none",
  );
  acceptStage(dir, "annotations", v.version);
  assert.equal(finalBlocker(dir), undefined);
  const plan = planRender(dir, cfg, { kind: "final", by: "cli" });
  assert.equal(plan.annotationVersion, 1);
  assert.deepEqual(plan.size, cfg.output);
  assert.throws(
    () => planRender(dir, cfg, { kind: "final", fromDraft: true, by: "cli" }),
    /unsaved changes/,
  );
  assert.throws(
    () => planRender(dir, cfg, { kind: "draft", brands: ["nope"], by: "cli" }),
    /brand/,
  );
});

test("annotation selection per render: types filter, redactions need a confirm, unsaved draft for drafts", () => {
  const dir = project();
  const cfg = config();
  ANN(dir, [CALLOUT, CHAPTER, REDACT, { ...CALLOUT, id: "off", enabled: false }]);
  const all = planRender(dir, cfg, { kind: "draft", by: "cli" });
  assert.deepEqual(
    all.file?.items.map((x) => x.id),
    ["co", "ch", "rd"],
    "enabled only",
  );
  const chapters = planRender(dir, cfg, {
    kind: "draft",
    options: { annotationTypes: ["chapter", "redact"] },
    by: "cli",
  });
  assert.deepEqual(
    chapters.file?.items.map((x) => x.id),
    ["ch", "rd"],
  );
  assert.throws(
    () => planRender(dir, cfg, { kind: "draft", options: { annotationTypes: [] }, by: "cli" }),
    /leave out 1 enabled redaction/,
  );
  const none = planRender(dir, cfg, {
    kind: "draft",
    options: { annotationTypes: [] },
    confirmUnredacted: true,
    by: "cli",
  });
  assert.equal(none.included, 0);
  editDraft(dir, 1, { op: "text", id: "co", text: "Unsaved text" });
  const fromDraft = planRender(dir, cfg, { kind: "draft", fromDraft: true, by: "cli" });
  assert.ok(fromDraft.fromDraft);
  assert.equal(fromDraft.file?.items.find((x) => x.id === "co")?.text, "Unsaved text");
  // Reuse keys: same inputs → same key; anything that changes pixels → another key
  const k = reuseKey(all, "neutral", 30);
  assert.equal(reuseKey(planRender(dir, cfg, { kind: "draft", by: "cli" }), "neutral", 30), k);
  assert.notEqual(reuseKey(all, "acme", 30), k);
  assert.notEqual(reuseKey(chapters, "neutral", 30), k);
  assert.notEqual(
    reuseKey(
      planRender(dir, cfg, { kind: "draft", options: { subtitles: true }, by: "cli" }),
      "neutral",
      30,
    ),
    k,
  );
});

// --- store: versions, pruning, delete, legacy ----------------------------------------

test("render versions: never overwritten; drafts pruned beyond keepDrafts (finals kept); delete keeps the record", () => {
  const dir = project();
  const mk = (kind: "draft" | "final") => {
    const r = startRecord(dir, {
      kind,
      basedOn: {},
      timeline: 1,
      voVersion: 1,
      take: "take-001",
      by: "cli",
      options: normalizeOptions({}),
      brands: ["neutral"],
      size: { width: 960, height: 540 },
    });
    const vdir = path.join(dir, "render", `v${r.version}`, "neutral");
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir, "full.mp4"), Buffer.alloc(1000));
    r.status = "done";
    r.variants.push({
      key: "neutral",
      brand: "neutral",
      dir: `render/v${r.version}/neutral`,
      files: { full: "full.mp4", scenes: [] },
      bytes: 1000,
      durationSec: 1,
      reuseKey: `k${r.version}`,
    });
    saveRecord(dir, r);
    return r.version;
  };
  const ids = [mk("draft"), mk("final"), mk("draft"), mk("draft"), mk("draft")];
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  assert.deepEqual(pruneDrafts(dir, 2), [3, 1], "the newest 2 drafts keep their files");
  assert.ok(readRender(dir, 1)?.pruned && readRender(dir, 3)?.pruned);
  assert.ok(!fs.existsSync(path.join(dir, "render", "v1")));
  assert.ok(
    fs.existsSync(path.join(dir, "render", "v2", "neutral", "full.mp4")),
    "finals are never pruned",
  );
  assert.equal(deleteRenderFiles(dir, 2, "deleted"), 1000);
  assert.ok(readRender(dir, 2)?.deleted, "record stays, marked deleted");
  assert.equal(listRenders(dir).length, 5);
  // legacy renders from before the Render stage
  fs.mkdirSync(path.join(dir, "out", "edit-v1", "neutral", "scenes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "edit-v1", "neutral", "full.mp4"), "x");
  fs.writeFileSync(path.join(dir, "out", "edit-v1", "neutral", "scenes", "01-a.mp4"), "x");
  assert.deepEqual(
    legacyRenders(dir).map((l) => [l.edit, l.variant, l.scenes]),
    [[1, "neutral", ["scenes/01-a.mp4"]]],
  );
});

test(
  "zip writer: stored entries that unzip verifies, byte for byte, with sub-folders and UTF-8 names",
  { skip: !hasBinary("unzip") && "needs unzip" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
    fs.mkdirSync(path.join(dir, "src", "scenes"), { recursive: true });
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
    fs.writeFileSync(path.join(dir, "src", "a.mp4"), big);
    fs.writeFileSync(path.join(dir, "src", "scenes", "b_ünïcode.vtt"), "WEBVTT\n");
    const out = path.join(dir, "out.zip");
    const bytes = await writeZip(out, [
      { name: "base/a.mp4", file: path.join(dir, "src", "a.mp4") },
      { name: "base/scenes/b_ünïcode.vtt", file: path.join(dir, "src", "scenes", "b_ünïcode.vtt") },
    ]);
    assert.equal(bytes, fs.statSync(out).size);
    assert.match(execFileSync("unzip", ["-t", out]).toString(), /No errors detected/);
    // Names via Python's zipfile (macOS's old Info-ZIP unzip can't display UTF-8 names; Finder/ditto can).
    const list = JSON.parse(
      execFileSync("python3", [
        "-c",
        "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
        out,
      ]).toString(),
    );
    assert.deepEqual(list, ["base/a.mp4", "base/scenes/b_ünïcode.vtt"]);
    assert.ok(
      execFileSync("unzip", ["-p", out, "base/a.mp4"], { maxBuffer: 64 * 1024 * 1024 }).equals(big),
    );
    assert.ok(!fs.existsSync(`${out}.part`), "written via a temp file");
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

// --- transcripts and cues ---------------------------------------------------------------

test("words in output time: scene narration via its audio placement, cards at their start + 0.5 s", () => {
  const dir = project();
  const sw = sceneWords(dir, TIMELINE, "01-a");
  assert.equal(sw[0]?.startMs, 500, "section audio 0 s played at 0.5 s");
  assert.equal(sw[2]?.startMs, 500 + 700);
  const fw = fullWords(dir, TIMELINE, [0, 2000]);
  assert.deepEqual(
    fw.slice(0, 3).map((w) => [w.w, w.startMs]),
    [
      ["Hello", 500],
      ["there.", 900],
      ["Look", 2500],
    ],
  );
});

test("cues: sentence ends, pauses, ≤ 2 lines × 42 chars, ≤ 6 s, never overlapping; VTT format", () => {
  const w = (text: string, start: number, step = 300) =>
    text
      .split(" ")
      .map((x, i) => ({ w: x, startMs: start + i * step, endMs: start + i * step + 250 }));
  const words = [
    ...w("Headline churn is three point one percent.", 0),
    ...w("The regional chart says otherwise", 3000), // pause before → its own cue
    ...w(
      "and EMEA is far above everyone else in this quarter, by a wide margin, which matters a lot for us here",
      4900,
    ),
  ];
  const cues = buildCues(words);
  assert.equal(cues[0]?.lines.join(" "), "Headline churn is three point one percent.");
  assert.ok(
    cues.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= MAX_LINE)),
    "≤ 2 lines of ≤ 42 chars",
  );
  assert.ok(cues.every((c) => c.endMs - c.startMs <= 6500));
  for (let i = 1; i < cues.length; i++)
    assert.ok((cues[i - 1]?.endMs ?? 0) < (cues[i]?.startMs ?? 0), "no overlap");
  assert.deepEqual(wrap("one two three".split(" ")), ["one two three"]);
  const two = wrap("Headline churn is three point one percent and rising fast".split(" "));
  assert.equal(two.length, 2);
  const vtt = toVtt(cues.slice(0, 1));
  assert.match(
    vtt,
    /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:02\.\d{3}\nHeadline churn is three point one percent\.\n/,
  );
});

test("next step: render a final → accept it → delivered", () => {
  const dir = project();
  const v = ANN(dir, [CHAPTER]);
  acceptStage(dir, "annotations", v.version);
  let s = readState(dir);
  assert.deepEqual(
    nextStep(dir, s?.accepted ?? {}, s?.line ?? {}),
    {
      who: "agent",
      stage: "vo",
      text: "voice-over approved — generate the voice and render (demo_rec_tts, demo_rec_edit)",
    } as never,
    "no render versions yet",
  );
  const mk = (kind: "draft" | "final") => {
    const r = startRecord(dir, {
      kind,
      basedOn: { annotations: 1 },
      timeline: 1,
      voVersion: 1,
      take: "take-001",
      by: "cli",
      options: normalizeOptions({}),
      brands: ["neutral"],
      size: { width: 960, height: 540 },
    });
    r.status = "done";
    saveRecord(dir, r);
    return r.version;
  };
  mk("draft");
  s = readState(dir);
  assert.deepEqual(nextStep(dir, s?.accepted ?? {}, s?.line ?? {}), {
    who: "user",
    stage: "render",
    text: "render a final in the Render tab",
  });
  const f = mk("final");
  s = readState(dir);
  assert.equal(
    nextStep(dir, s?.accepted ?? {}, s?.line ?? {}).text,
    `review and approve final render v${f}`,
  );
  acceptStage(dir, "render", f);
  s = readState(dir);
  assert.match(
    nextStep(dir, s?.accepted ?? {}, s?.line ?? {}).text,
    /^delivered — final render v2/,
  );
});

// --- real renders ---------------------------------------------------------------------

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
const size = (f: string) =>
  execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    f,
  ])
    .toString()
    .trim();
const crop = (f: string, t: number, b: { x: number; y: number; w: number; h: number }) =>
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      f,
      "-frames:v",
      "1",
      "-vf",
      `crop=${b.w}:${b.h}:${b.x}:${b.y}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
const diff = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] as number) - (b[i] as number));
  return s / a.length;
};

test(
  "real renders: draft (960×540, DRAFT tag, full only) and final (scenes, VTT, SRT, poster, subtitles, reuse)",
  { skip: renderSkip, timeout: 300_000 },
  async () => {
    const dir = project(true);
    const cfg = { ...config(), output: { width: 1280, height: 720 } };
    const v = ANN(dir, [CALLOUT, CHAPTER]);
    const draft = await runRender({
      projectDir: dir,
      config: cfg,
      request: { kind: "draft", by: "cli" },
    });
    assert.equal(draft.status, "done");
    const dv = draft.variants[0];
    assert.ok(dv);
    const dfull = path.join(dir, dv.dir, dv.files.full);
    assert.equal(dv.files.full, "p_draft-v1_neutral.mp4", "project_kind-vN_flavor");
    assert.equal(size(dfull), "960,540");
    assert.deepEqual(dv.files.scenes, [], "drafts: full video only");
    assert.ok(dv.files.vtt && dv.files.poster);
    // the DRAFT tag (top right) is there; compare to the same draft without it isn't possible → check it differs from the footage around it
    const tag = crop(dfull, 3, { x: 960 - 120, y: 8, w: 110, h: 34 });
    const below = crop(dfull, 3, { x: 960 - 120, y: 60, w: 110, h: 34 });
    assert.ok(diff(tag, below) > 10, "a tag in the top-right corner");

    await assert.rejects(
      runRender({ projectDir: dir, config: cfg, request: { kind: "final", by: "cli" } }),
      /needs an approved annotation version/,
    );
    acceptStage(dir, "annotations", v.version);
    const final = await runRender({
      projectDir: dir,
      config: cfg,
      request: { kind: "final", options: { subtitles: true }, by: "cli" },
    });
    const fv = final.variants[0];
    assert.ok(fv);
    const f = (x: string) => path.join(dir, fv.dir, x);
    const base = `p_final-v${final.version}_neutral`;
    assert.equal(fv.files.full, `${base}.mp4`);
    assert.equal(size(f(fv.files.full)), "1280,720");
    assert.deepEqual(fv.files.scenes, [`scenes/${base}_01-a.mp4`]);
    assert.deepEqual(fv.files.scenesVtt, [`scenes/${base}_01-a_transcript.vtt`]);
    assert.ok(fs.existsSync(f(`${base}_poster.jpg`)));
    const vtt = fs.readFileSync(f(`${base}_transcript.vtt`), "utf8");
    assert.match(vtt, /^WEBVTT/);
    // The brand's title card is longer than the intro card: the video opens on a hold first.
    const hold = Number(/\n00:00:(\d\d)\.(\d{3}) -->/.exec(vtt)?.slice(1).join("")) - 500;
    assert.ok(hold >= 0 && hold < 3000, `title hold ${hold} ms`);
    const at = (ms: number) => `00:00:${String(Math.floor(ms / 1000)).padStart(2, "0")}`;
    assert.match(vtt, /\nHello there\./, "intro words from the card (start + 0.5 s)");
    assert.ok(
      vtt.includes(`${at(hold + 2000 + 500)}.${String((hold + 2500) % 1000).padStart(3, "0")} -->`),
      "scene words: scene start + the audio placement (0.5 s)",
    );
    const srt = fs.readFileSync(f(`${base}_callouts.srt`), "utf8");
    const co = hold + 2000 + 1500 - 150;
    assert.ok(
      srt.startsWith(`1\n${at(co)},${String(co % 1000).padStart(3, "0")} --> `),
      `callout at scene start + 1.5 s − 0.15 s lead: ${srt.slice(0, 40)}`,
    );
    assert.match(srt, /Headline churn/);
    // burned-in subtitles: an extra file, same frames, differs at the bottom centre while a cue shows
    assert.ok(fv.files.fullSubtitled && fs.existsSync(f(`${base}_subtitled.mp4`)));
    assert.equal(frames(f(`${base}_subtitled.mp4`)), frames(f(`${base}.mp4`)));
    const bottom = { x: 440, y: 560, w: 400, h: 110 };
    assert.ok(
      diff(
        crop(f(`${base}_subtitled.mp4`), (hold + 2900) / 1000, bottom),
        crop(f(`${base}.mp4`), (hold + 2900) / 1000, bottom),
      ) > 8,
      "subtitle visible",
    );
    assert.deepEqual(fv.files.scenesSubtitled, [`scenes/${base}_01-a_subtitled.mp4`]);
    // a second render with the same inputs reuses the files; another type selection renders anew
    const again = await runRender({
      projectDir: dir,
      config: cfg,
      request: { kind: "final", options: { subtitles: true }, by: "cli" },
    });
    assert.equal(again.variants[0]?.reusedFrom, final.version);
    const ab = `p_final-v${again.version}_neutral`;
    assert.equal(
      again.variants[0]?.files.full,
      `${ab}.mp4`,
      "reused files carry the new version in their names",
    );
    assert.ok(fs.existsSync(path.join(dir, again.variants[0]?.dir ?? "", `${ab}_subtitled.mp4`)));
    assert.deepEqual(again.variants[0]?.files.scenes, [`scenes/${ab}_01-a.mp4`]);
    const chapterOnly = await runRender({
      projectDir: dir,
      config: cfg,
      request: { kind: "final", options: { annotationTypes: ["chapter"] }, by: "cli" },
    });
    assert.equal(chapterOnly.variants[0]?.key, "neutral_chapters-only");
    assert.equal(
      chapterOnly.variants[0]?.files.full,
      `p_final-v${chapterOnly.version}_neutral_chapters-only.mp4`,
    );
    assert.equal(chapterOnly.variants[0]?.reusedFrom, undefined);
    assert.equal(
      chapterOnly.variants[0]?.files.callouts,
      undefined,
      "no callouts in a chapters-only render",
    );
  },
);

// --- panel routes -------------------------------------------------------------------------

test(
  "Render tab routes: view, start a render job, accept finals only, delete (record stays), no annotations",
  { skip: renderSkip, timeout: 300_000 },
  async () => {
    const dir = project(true);
    const rt = new Runtime(() => ({ ...config(), output: { width: 960, height: 540 } }));
    const told: string[] = [];
    (rt as unknown as { tellAgent: (t: string) => void }).tellAgent = (t) => told.push(t);
    rt.setActiveProject("p");
    const panel = await rt.ensurePanel();
    const base = `http://127.0.0.1:${panel.port}`;
    const auth = { authorization: `Bearer ${panel.token}` };
    const get = async (n: string) =>
      (await (await fetch(`${base}/api/${n}`, { headers: auth })).json()) as Record<
        string,
        unknown
      >;
    const post = async (n: string, body: unknown) => {
      const res = await fetch(`${base}/api/${n}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const waitDone = async () => {
      for (let i = 0; i < 240; i++) {
        const j = rt.jobs.latest("render");
        if (j && j.status !== "running") return j;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("render did not finish");
    };
    try {
      let v = await get("renders");
      assert.match(String(v.finalBlocker), /needs an approved annotation version/);
      assert.equal(v.hasEdit, true);
      // "Use no annotations" → an empty version to accept
      let r = await post("annotations-empty", {});
      assert.equal(r.status, 200, String(r.json.error));
      const empty = Number(r.json.version);
      r = await post("approve", { artifact: "annotations", version: empty });
      assert.equal(r.status, 200, String(r.json.error));
      // a final from the panel: background job, quiet note to the agent
      r = await post("render", { kind: "final", brands: ["neutral"] });
      assert.equal(r.status, 200, String(r.json.error));
      r = await post("render", { kind: "draft" });
      assert.ok(
        r.status >= 400 && /already running/.test(String(r.json.error)),
        "one render at a time",
      );
      const job = await waitDone();
      assert.equal(job.status, "done", job.error);
      assert.match(told.at(-1) ?? "", /Final render v1 \(done\) of annotations v1/);
      v = await get("renders");
      const renders = v.renders as {
        version: number;
        kind: string;
        accepted: boolean;
        variants: { present: boolean }[];
      }[];
      assert.equal(renders[0]?.kind, "final");
      assert.equal(renders[0]?.variants[0]?.present, true);
      // drafts can't be accepted
      await post("render", { kind: "draft" });
      await waitDone();
      r = await post("approve", { artifact: "render", version: 2 });
      assert.ok(r.status >= 400 && /only final renders/.test(String(r.json.error)));
      // QA ran with the final (D69): the synthetic page shows no text, so the said "3.1" is found nowhere (D71).
      // That needs your eyes, but it is a report, not a stop (Q1a): the final can be approved.
      const qa = (await get("render-qa?version=1")) as {
        report: {
          items: { id: string; level: string; high?: boolean; check: string; message: string }[];
        };
        summary: { status: string; blocking: number; high: number };
      };
      assert.deepEqual([qa.summary.status, qa.summary.blocking, qa.summary.high], ["pass", 0, 1]);
      assert.equal(
        qa.report.items.some((i) => i.level === "blocking"),
        false,
        "no hard stop: the files are intact",
      );
      const high = qa.report.items.filter((i) => i.high);
      assert.equal(high.length, 1);
      assert.equal(high[0]?.check, "values");
      assert.deepEqual(
        (high[0] as { identity?: { value?: string; anchor?: string } }).identity?.value,
        "3.1",
        "a finding carries what it is about (Q2): the value, not its numbers",
      );
      assert.match(
        high[0]?.message ?? "",
        /“Three point one” \(3\.1\) — it isn't on screen anywhere in 01-a/,
      );
      r = await post("approve", { artifact: "render", version: 1 });
      assert.equal(r.status, 200, String(r.json.error));
      assert.equal(readState(dir)?.line.render, 1);
      // ⬇ zip (all): everything of the variant in one archive, cached
      r = await post("render-zip", { version: 1, variant: "neutral" });
      assert.equal(r.status, 200, String(r.json.error));
      assert.equal(r.json.zip, "render/v1/p_final-v1_neutral.zip");
      const zip = path.join(dir, String(r.json.zip));
      const entries = execFileSync("unzip", ["-Z1", zip]).toString().trim().split("\n");
      for (const want of [
        "p_final-v1_neutral/p_final-v1_neutral.mp4",
        "p_final-v1_neutral/p_final-v1_neutral_transcript.vtt",
        "p_final-v1_neutral/p_final-v1_neutral_poster.jpg",
        "p_final-v1_neutral/scenes/p_final-v1_neutral_01-a.mp4",
      ])
        assert.ok(entries.includes(want), `${want} in the zip`);
      assert.match(execFileSync("unzip", ["-t", zip]).toString(), /No errors detected/);
      const mtime = fs.statSync(zip).mtimeMs;
      r = await post("render-zip", { version: 1, variant: "neutral" });
      assert.equal(fs.statSync(zip).mtimeMs, mtime, "second request: the cached zip");
      r = await post("render-zip", { version: 1, variant: "nope" });
      assert.ok(r.status >= 400);
      // delete: the accepted deliverable needs an explicit confirm; the record stays
      r = await post("render-delete", { version: 1 });
      assert.ok(r.status >= 400 && /approved deliverable/.test(String(r.json.error)));
      r = await post("render-delete", { version: 1, confirmAccepted: true });
      assert.equal(r.status, 200, String(r.json.error));
      assert.ok(Number(r.json.bytes) > 10_000);
      assert.ok(readRender(dir, 1)?.deleted);
      assert.ok(!fs.existsSync(zip), "the zip goes with the files");
      r = await post("approve", { artifact: "render", version: 1 });
      assert.ok(r.status >= 400 && /no files any more/.test(String(r.json.error)));
    } finally {
      await panel.close();
      await rt.shutdown();
    }
  },
);
