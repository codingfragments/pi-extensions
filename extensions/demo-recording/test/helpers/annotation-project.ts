/** A synthetic annotation project (no browser, no model): one scene, 6 s, marks m1 (1 s) and m2 (3 s). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SceneTimeline, Timeline } from "../../src/edit/timeline.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

export const SCENE = {
  id: "01-dash",
  title: "Dashboard",
  audioFile: "vo/audio/s1.wav",
  pieces: [{ src: [0, 6000], speed: 1, kind: "static" }],
  // narration section audio 0–4 s played from 0.5 s
  audio: [{ src: [0, 4000], at: 500 }],
  anchors: [
    { mark: "m1", event: 1000, out: 1000, audioAt: 1000, drift: 0 },
    { mark: "m2", event: 3000, out: 3000, audioAt: 3000, drift: 0 },
  ],
  durationMs: 6000,
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

export const TIMELINE = {
  schema: 1,
  take: "take-001",
  voVersion: 1,
  voice: { engine: "say", name: "x" },
  fps: 30,
  size: { width: 1920, height: 1080 },
  scenes: [SCENE],
  full: [{ type: "scene", id: "01-dash" }],
  totals: { fullMs: 6000, cutMs: 0, frozenMs: 0, silenceMs: 0, worstDriftMs: 0 },
} as unknown as Timeline;

export const ELS = [
  { id: "e1", role: "heading", box: { x: 20, y: 20, w: 400, h: 40 }, text: "Customer health" },
  { id: "e2", role: "div", box: { x: 100, y: 100, w: 200, h: 60 }, text: "3.1%" },
  {
    id: "e3",
    role: "row",
    box: { x: 400, y: 300, w: 600, h: 40 },
    text: "Litware Bank EMEA $310K",
  },
  { id: "e4", role: "cell", box: { x: 800, y: 300, w: 100, h: 40 }, text: "$310K" },
  {
    id: "e5",
    role: "cell",
    box: { x: 400, y: 360, w: 300, h: 30 },
    text: "dana.whitfield@litware.example",
  },
  {
    id: "e6",
    role: "cell",
    box: { x: 400, y: 400, w: 300, h: 30 },
    text: "sk-live-abcdefghijklmnop1234",
  },
];

export function makeProject(): string {
  const dir = tmp("ann8-");
  const take = path.join(dir, "takes", "take-001");
  fs.mkdirSync(take, { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({
      take: "take-001",
      storyboardVersion: 1,
      viewport: { width: 1600, height: 900, dpr: 2 },
      captureStats: { width: 3200, height: 1800 },
    }),
  );
  const ev = [
    {
      t: 1000,
      type: "hover",
      scene: "01-dash",
      step: 0,
      mark: "m1",
      box: { x: 100, y: 100, w: 200, h: 60 },
    },
    {
      t: 3000,
      type: "hover",
      scene: "01-dash",
      step: 1,
      mark: "m2",
      box: { x: 400, y: 300, w: 600, h: 40 },
    },
  ];
  fs.writeFileSync(
    path.join(take, "events.jsonl"),
    `${ev.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  const snap = (t: number, mark?: string) => ({
    t,
    reason: mark ? "mark" : "settle",
    ...(mark ? { mark } : {}),
    scene: "01-dash",
    url: "http://x/",
    scroll: { x: 0, y: 0 },
    viewport: { w: 1600, h: 900 },
    els: ELS,
  });
  fs.writeFileSync(
    path.join(take, "layout.jsonl"),
    `${[snap(400), snap(1000, "m1"), snap(3000, "m2")].map((s) => JSON.stringify(s)).join("\n")}\n`,
  );
  fs.mkdirSync(path.join(dir, "storyboard"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "storyboard", "v1.yaml"),
    [
      "version: 1",
      "app: x",
      "start_url: /",
      "scenes:",
      "  - id: 01-dash",
      "    title: Dashboard",
      "    steps:",
      "      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }",
      "      - { do: hover, target: { css: '#row' }, mark: m2, dwell: 1s, emphasis: the EMEA row is the story }",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(dir, "vo", "audio"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vo", "script.v1.md"),
    "---\ntake: take-001\n---\n## 01-dash — Dashboard\nChurn looks fine. [@m1] Three point one percent churn. [@m2] But EMEA tells another story, EMEA again.\n",
  );
  const words = [
    "Churn",
    "looks",
    "fine.",
    "Three",
    "point",
    "one",
    "percent.",
    "But",
    "EMEA",
    "tells",
    "another",
    "story,",
    "EMEA",
    "again.",
  ].map((w, i) => ({ w, seg: 0, s: i * 0.25, e: i * 0.25 + 0.2 }));
  fs.writeFileSync(
    path.join(dir, "vo", "audio", "v1.json"),
    JSON.stringify({
      schema: 1,
      voVersion: 1,
      take: "take-001",
      sections: {
        "01-dash": {
          key: "01-dash",
          alignment: { durationSec: 4, words, anchors: {}, source: "transcript" },
        },
      },
    }),
  );
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  fs.writeFileSync(path.join(dir, "edit", "timeline.v1.json"), JSON.stringify(TIMELINE));
  return dir;
}
