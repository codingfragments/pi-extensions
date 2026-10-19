/**
 * A project whose take-001 has a real six second video, three scenes of two seconds with a still for every frame, a goal and
 * a finding in the storyboard, and an error toast in scene two; plus a newer take-002 of the same storyboard. For the recording
 * review tests (item 7). Needs ffmpeg.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { recordFinding } from "../../src/workdir/findings.ts";
import type { seedPanelProject } from "./panel-seed.ts";

export const scene = (
  id: string,
  start: number,
  end: number,
  extra: Record<string, unknown> = {},
) => ({
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

export function seedReviewTakes(seed: ReturnType<typeof seedPanelProject>): void {
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
  const mk = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
    scene(id, start, end, {
      marks: [{ mark: "m1", t: start + 700, type: "wait-satisfied" }],
      keyframes: [
        { t: start + 100, label: "start", file: still(`${id}-start`) },
        { t: start + 700, label: "m1", file: still(`${id}-m1`) },
        { t: end - 100, label: "end", file: still(`${id}-end`) },
      ],
      ...extra,
    });
  const analysisFor = (take: string) =>
    JSON.stringify({
      take,
      takeDir: dir,
      storyboardVersion: 1,
      durationMs: 6000,
      viewport: { width: 1600, height: 900, dpr: 2 },
      scenes: [
        // many notable moments make the first chapter tall, as a long scene does: the pane has room to stay pinned
        mk("01-dash", 0, 2000, {
          keyframes: Array.from({ length: 14 }, (_, i) => ({
            t: 100 + i * 120,
            label: `e${i}`,
            file: still(`01-e${i}`),
          })),
        }),
        mk("02-search", 2000, 4000, { alerts: [{ t: 3000, text: "boom", level: "error" }] }),
        mk("03-compare", 4000, 6000),
      ],
      createdAt: "2026-10-15T12:00:00Z",
    });
  fs.writeFileSync(path.join(dir, "analysis", "analysis.json"), analysisFor("take-001"));
  // a second, newer take of the same storyboard (the production line keeps take-001)
  const dir2 = path.join(seed.dir, "takes", "take-002");
  fs.cpSync(dir, dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, "analysis", "analysis.json"), analysisFor("take-002"));
  fs.writeFileSync(
    path.join(dir2, "take.json"),
    JSON.stringify({
      take: "take-002",
      storyboardVersion: 1,
      status: "ok",
      durationMs: 6000,
      viewport: { width: 1600, height: 900, dpr: 2 },
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
    steps:
      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }
  - id: 02-search
    title: Search the catalogue
    takeaway: Search is name-only
    emphasis: the empty state is the story
    findings: [${f.id}]
    steps:
      - { do: pause, ms: 600, mark: m2 }
  - id: 03-compare
    title: Compare two results
    steps:
      - { do: pause, ms: 600, mark: m3 }
`,
  );
}
