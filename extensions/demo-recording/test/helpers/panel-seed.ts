/**
 * A seeded project with something on every tab (Project, Storyboard, Recording, Voice over,
 * Annotations, Render, Config), built from the files the panel reads. No browser, no model,
 * no ffmpeg. Used by the panel screenshots, the panel audit and the browser tests, so
 * before/after comparisons and audits always see the same project.
 *
 * Shape: storyboard v1 (accepted) and v2 (a draft with three scenes), take-001 (accepted),
 * voice-over v1 (accepted) and v2 (re-directed, changed, one low-confidence section),
 * annotations v1 (accepted, six items incl. a redaction), renders: three finals (one blocked
 * by QA, one passed and accepted, one with deleted files) and a few drafts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAnnotations } from "../../src/annotations/file.ts";
import type { QaSummary } from "../../src/qa/types.ts";
import { normalizeOptions } from "../../src/render/run.ts";
import { type RenderRecord, saveRecord, startRecord } from "../../src/render/store.ts";
import { writeStoryboard } from "../../src/storyboard/store.ts";
import { writeVo } from "../../src/vo/store.ts";
import { ensureProject } from "../../src/workdir/layout.ts";
import { acceptTake, approve, setSceneReview } from "../../src/workdir/state.ts";
import { TIMELINE, makeProject } from "./annotation-project.ts";

export interface PanelSeed {
  root: string;
  slug: string;
  dir: string;
}

const SB1 = `version: 1
app: keycraft
start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }
      - { do: hover, target: { css: '#row' }, mark: m2, dwell: 1s, emphasis: the EMEA row is the story }
`;

const SB2 = `version: 2
app: keycraft
start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }
      - { do: hover, target: { css: '#row' }, mark: m2, dwell: 1s, emphasis: the EMEA row is the story }
  - id: 02-search
    title: Search the catalogue
    deep_link: /search
    steps:
      - { do: type, target: { role: searchbox, name: Search }, text: churn, improvise: true, mark: typed }
      - { do: pause, ms: 600, mark: results }
  - id: 03-compare
    title: Compare two results
    deep_link: /compare
    steps:
      - { do: click, target: { role: button, name: Compare }, mark: compare }
`;

const VO1 = `---
take: take-001
---
## _intro
Churn looks fine. It isn't.

## 01-dash — Dashboard
Headline churn is 3.1 percent. [@m1] Three point one, steady. [@m2] But EMEA is the outlier at 14.2 percent.

## _outro
Two questions, one answer.
`;

const VO2 = VO1.replace("Headline churn is 3.1 percent.", "Headline churn reads 4.2 percent.");

const ITEMS = [
  {
    id: "zoom-kpi",
    type: "zoom",
    scene: "01-dash",
    anchor: { mark: "m1" },
    target: { step: 0 },
    enabled: true,
    value: 5,
    reason: "the number the story hangs on",
  },
  {
    id: "hl-row",
    type: "highlight",
    scene: "01-dash",
    anchor: { mark: "m2" },
    target: { step: 1 },
    enabled: true,
    value: 4,
    reason: "points at the EMEA row",
  },
  {
    id: "co-kpi",
    type: "callout",
    scene: "01-dash",
    anchor: { mark: "m1", offsetMs: 300 },
    text: "Headline churn",
    enabled: true,
    value: 3,
    reason: "names the figure",
  },
  {
    id: "ch-dash",
    type: "chapter",
    scene: "01-dash",
    anchor: { sceneStart: true },
    text: "The dashboard",
    enabled: false,
    value: 2,
    reason: "structure",
  },
  {
    id: "sp-row",
    type: "spotlight",
    scene: "01-dash",
    anchor: { mark: "m2" },
    target: { step: 1 },
    enabled: false,
    value: 2,
    reason: "dims the rest",
  },
  {
    id: "rd-mail",
    type: "redact",
    scene: "01-dash",
    anchor: { sceneStart: true },
    target: { box: { x: 400, y: 360, w: 300, h: 30 } },
    enabled: false,
    value: 3,
    reason: "an e-mail address is visible",
  },
];

function copyTree(from: string, to: string, skip: Set<string>) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst, new Set());
    } else fs.copyFileSync(src, dst);
  }
}

function render(
  dir: string,
  kind: "draft" | "final",
  by: RenderRecord["by"],
  qa: RenderRecord["qa"],
  extra: Partial<RenderRecord> = {},
): RenderRecord {
  const rec = startRecord(dir, {
    kind,
    basedOn: { annotations: 1 },
    timeline: 1,
    voVersion: 1,
    take: "take-001",
    by,
    options: normalizeOptions({}),
    brands: ["neutral"],
    size: kind === "draft" ? { width: 960, height: 540 } : { width: 1920, height: 1080 },
  });
  rec.status = "done";
  rec.finishedAt = rec.createdAt;
  rec.qa = qa;
  const key = "neutral";
  const rel = path.join("render", `v${rec.version}`, key);
  rec.variants = [
    {
      key,
      brand: "neutral",
      dir: rel,
      files: { full: "full.mp4", scenes: ["01-dash.mp4"], vtt: "full.vtt", poster: "poster.jpg" },
      bytes: kind === "draft" ? 3_100_000 : 96_000_000,
      durationSec: 128,
      reuseKey: `seed-${rec.version}`,
    },
  ];
  Object.assign(rec, extra);
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  for (const f of ["full.mp4", "01-dash.mp4", "full.vtt", "poster.jpg"])
    fs.writeFileSync(path.join(dir, rel, f), "");
  saveRecord(dir, rec);
  return rec;
}

const QA_OK: QaSummary = {
  status: "pass",
  blocking: 0,
  warnings: 1,
  confirmed: 0,
  info: 0,
  ranAt: "2026-10-15T12:20:00Z",
};
const QA_BLOCKED: QaSummary = { ...QA_OK, status: "blocked", blocking: 1 };

/** What `demo_rec_take analyze` would have written for the synthetic take (one scene, marks m1 and m2). */
const ANALYSIS = {
  take: "take-001",
  takeDir: "/x",
  storyboardVersion: 1,
  durationMs: 6000,
  viewport: { width: 1600, height: 900, dpr: 2 },
  scenes: [
    {
      id: "01-dash",
      title: "Dashboard",
      start: 0,
      end: 6000,
      marks: [
        { mark: "m1", t: 1000, type: "wait-satisfied", dom: '- img "Churn 3.1%"' },
        { mark: "m2", t: 3000, type: "wait-satisfied", dom: '- bar "EMEA 14.2%"' },
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
  createdAt: "2026-10-15T12:00:00Z",
};

/** Build the project under `root` (a fresh temp dir when omitted). */
export function seedPanelProject(root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-seed-"))) {
  // a seeded panel never lists the voices of a real account (tests, screenshots and the audit use this)
  process.env.DEMO_REC_NO_VOICE_LIST ??= "1";
  const p = ensureProject(root, {
    project: "keycraft",
    appName: "Keycraft",
    appUrl: "https://keycraft.example",
    brief:
      "# Demo brief: keycraft\n\n- **Title:** Keycraft in four minutes\n- **Persona:** Product teams evaluating search\n- **Depth:** showcase\n- **Goal / key message:** Search, compare, act.\n",
  });
  // a synthetic take, layout snapshots and timeline from the annotation fixture
  const tmp = makeProject();
  copyTree(tmp, p.dir, new Set(["state.json", "inputs.jsonl", "brief.md", "jobs", "context"]));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(p.dir, "storyboard"), { recursive: true, force: true });
  fs.rmSync(path.join(p.dir, "vo", "script.v1.md"), { force: true });
  fs.mkdirSync(path.join(p.dir, "storyboard"), { recursive: true });
  fs.mkdirSync(path.join(p.dir, "vo"), { recursive: true });
  fs.writeFileSync(path.join(p.dir, "edit", "timeline.v1.json"), JSON.stringify(TIMELINE));

  const takeDir = path.join(p.dir, "takes", "take-001");
  fs.mkdirSync(path.join(takeDir, "analysis"), { recursive: true });
  fs.writeFileSync(path.join(takeDir, "analysis", "analysis.json"), JSON.stringify(ANALYSIS));
  writeStoryboard(p.dir, SB1);
  writeStoryboard(p.dir, SB2);
  approve(p.dir, "storyboard", 1);
  acceptTake(p.dir, "take-001");
  writeVo(p.dir, VO1);
  setSceneReview(p.dir, 1, "_intro", "approved", undefined, "vo");
  writeVo(p.dir, VO2);
  approve(p.dir, "vo", 1);

  writeAnnotations(p.dir, {
    basedOn: { vo: 1 },
    take: "take-001",
    items: ITEMS as never,
  });
  approve(p.dir, "annotations", 1);

  render(p.dir, "final", "cli", QA_BLOCKED);
  const passed = render(p.dir, "final", "panel", QA_OK);
  render(p.dir, "final", "panel", null, { deleted: "files deleted by you" });
  for (let i = 0; i < 4; i++) render(p.dir, "draft", i === 0 ? "edit" : "panel", null);
  approve(p.dir, "render", passed.version);
  return { root, slug: p.slug, dir: p.dir } satisfies PanelSeed;
}
