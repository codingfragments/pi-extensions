/**
 * P1a PR 7 (Q0): the drift check records what it saw at every anchor and shows the measurement beside
 * the edit's plan. A disagreement between the two is flagged, never silently believed. Nothing about
 * what blocks changes. The "transcript" is injected: the audio only has to be there (and, at the
 * measured moment, loud), so no Whisper is needed.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import type { SceneTimeline, Timeline } from "../src/edit/timeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { type Ctx, checkDrift, formatQaMarkdown, sidesWith } from "../src/qa/run.ts";
import type { QaReport } from "../src/qa/types.ts";
import type { RenderRecord } from "../src/render/store.ts";

const skip = !hasBinary("ffmpeg") && "needs ffmpeg";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "p1a-qa-diag-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const VO = `---
take: take-001
---
## 01-a
Intro words here. [@m1] Then the chart shows it.
`;

/**
 * One scene, "01-a", starts at 2000 ms in the full video; its anchor m1 sits at output 3000 ms (event at
 * 5000 ms in the full video) and the edit planned the narration at `audioAt` (output ms).
 */
function fixture(audioAt: number, editAudioAt = audioAt, toneAtMs = 5400) {
  const dir = path.join(root, "projects", "p");
  fs.mkdirSync(path.join(dir, "vo", "audio"), { recursive: true });
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  fs.mkdirSync(path.join(dir, "render"), { recursive: true });
  fs.writeFileSync(path.join(dir, "vo", "script.v1.md"), VO);
  const w = (word: string, seg: number, s: number) => ({ w: word, seg, s, e: s + 0.3 });
  fs.writeFileSync(
    path.join(dir, "vo", "audio", "v1.json"),
    JSON.stringify({
      schema: 1,
      voVersion: 1,
      take: "take-001",
      sections: {
        "01-a": {
          key: "01-a",
          alignment: {
            anchors: { m1: 1.2 },
            words: [
              w("Intro", 0, 0),
              w("words", 0, 0.4),
              w("here", 0, 0.8),
              w("Then", 1, 1.2),
              w("the", 1, 1.5),
              w("chart", 1, 1.8),
              w("shows", 1, 2.1),
              w("it", 1, 2.4),
            ],
          },
        },
      },
    }),
  );
  const scene = (audioAtMs: number) =>
    ({
      id: "01-a",
      title: "A",
      audioFile: null,
      pieces: [],
      audio: [],
      anchors: [
        {
          mark: "m1",
          event: 4000,
          out: 3000,
          audioAt: audioAtMs,
          drift: audioAtMs - 3000,
        },
      ],
      durationMs: 6000,
      stats: {},
    }) as unknown as SceneTimeline;
  const timeline = (a: number) =>
    ({
      schema: 1,
      take: "take-001",
      voVersion: 1,
      scenes: [scene(a)],
      full: [],
      totals: {},
    }) as unknown as Timeline;
  fs.writeFileSync(
    path.join(dir, "edit", "timeline.v1.json"),
    JSON.stringify(timeline(editAudioAt)),
  );
  // a 12 s clip with a tone where the transcript will say the narration is
  const full = path.join(root, "full.mp4");
  const t = toneAtMs / 1000;
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x36:r=10:d=12",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=if(between(t\\,${t}\\,${t + 2})\\,0.5*sin(2*PI*440*t)\\,0):s=16000:d=12`,
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      full,
    ],
    { stdio: "ignore" },
  );
  const heardAt = (ms: number) => async () => {
    const words = ["intro", "words", "here", "then", "the", "chart", "shows", "it"];
    return words.map((x, i) => {
      const at = ms / 1000 + (i < 3 ? -1.2 + i * 0.4 : i * 0.3 - 0.9);
      return { w: x, s: at, e: at + 0.25 };
    });
  };
  const ctx = (heard: number): Ctx =>
    ({
      projectDir: dir,
      config: resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      rec: { version: 1, timeline: 1 } as unknown as RenderRecord,
      t: timeline(audioAt),
      takeDir: path.join(dir, "takes", "take-001"),
      snaps: [],
      events: [],
      timing: { titleMs: 0, sceneStart: { "01-a": 2000 }, itemStart: [] },
      full,
      transcribe: heardAt(heard) as never,
    }) as Ctx;
  return { dir, ctx };
}

test("planned and measured agree: the item shows both, no disagreement", { skip }, async () => {
  const f = fixture(3400); // the edit planned the narration 400 ms late, at 5400 in the full video
  const r = await checkDrift(f.ctx(5400));
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.equal(it?.level, "blocking", "400 ms late is over the limit: what blocks is unchanged");
  assert.match(
    it?.message ?? "",
    /starts 400 ms after its moment \(measured; the edit planned \+400 ms\)$/,
  );
  const a = r.diagnostics?.anchors[0];
  assert.deepEqual(
    [a?.eventMs, a?.plannedAudioMs, a?.plannedDriftMs, a?.editDriftMs],
    [5000, 5400, 400, 400],
  );
  assert.deepEqual([a?.measuredMs, a?.measuredDriftMs, a?.gapMs, a?.matches], [5400, 400, 0, 1]);
  assert.deepEqual(a?.words, ["then", "the"]);
  assert.equal(a?.heard.find(([w]) => w === "then")?.[1], 5400);
  assert.deepEqual(r.diagnostics?.sceneStart, { "01-a": 2000 });
});

test("measured and planned disagree: the item says so, with the gap", { skip }, async () => {
  const f = fixture(3000); // the plan puts the narration right on the event
  const r = await checkDrift(f.ctx(5400)); // but the audio has it 400 ms late
  assert.match(
    r.items[0]?.message ?? "",
    /\(measured; the edit planned \+0 ms\): the two disagree by 400 ms/,
  );
  assert.equal(r.diagnostics?.anchors[0]?.gapMs, 400);
});

test(
  "the report keeps the render's override apart from the edit's own plan",
  { skip },
  async () => {
    // the edit planned +0; a render override moved the narration 700 ms late
    const f = fixture(3700, 3000);
    const r = await checkDrift(f.ctx(5700));
    const a = r.diagnostics?.anchors[0];
    assert.deepEqual([a?.plannedDriftMs, a?.editDriftMs, a?.gapMs], [700, 0, 0]);
  },
);

test(
  "a big gap with the narration on its moment is an info item, not a blocker",
  { skip },
  async () => {
    const f = fixture(3800, 3800, 5000); // planned 800 ms late; the tone (the audio) is on the event
    const r = await checkDrift(f.ctx(5000)); // measured right on the event
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]?.level, "info");
    assert.match(
      r.items[0]?.message ?? "",
      /800 ms before where the edit put it.*the measurement and the render disagree/,
    );
  },
);

test("no match is recorded, not invented", { skip }, async () => {
  const f = fixture(3000);
  const c = f.ctx(5000);
  c.transcribe = (async () => [{ w: "nothing", s: 1, e: 1.2 }]) as never;
  const r = await checkDrift(c);
  assert.deepEqual(r.items, []);
  const a = r.diagnostics?.anchors[0];
  assert.deepEqual([a?.matches, a?.measuredMs, a?.gapMs], [0, undefined, undefined]);
});

test("the markdown report has the diagnostics table", { skip }, async () => {
  const f = fixture(3400);
  const r = await checkDrift(f.ctx(5400));
  const report: QaReport = {
    render: 1,
    variant: "x",
    createdAt: "2025-01-01T00:00:00.000Z",
    whisper: true,
    items: r.items,
    ...(r.diagnostics ? { diagnostics: r.diagnostics } : {}),
  };
  const md = formatQaMarkdown(report);
  assert.match(md, /## Sync diagnostics/);
  assert.match(md, /\| 01-a \| @m1 \| 5000 \| \+400 \| \+400 \| \+400 \| 0 \| 1 \| yes \| yes \|/);
});

test("the audio onset says which of the two is wrong", { skip }, async () => {
  // the plan is off: the speech starts 400 ms after where the edit put it, and the transcript agrees with the audio
  const a = fixture(3000, 3000, 5400);
  const planWrong = await checkDrift(a.ctx(5400));
  assert.match(
    planWrong.items[0]?.message ?? "",
    /the transcript's word start is on a speech onset, so the measurement is probably right and the plan is off$/,
  );
  const d = planWrong.diagnostics?.anchors[0];
  assert.deepEqual([d?.transcriptOnOnset, d?.onsetAtPlanMs], [true, undefined]);

  // a word that Whisper stretched over the pause before it (word start 4.3 s, the speech starts at 5.4 s) is measured
  // at the speech onset, not at the stretched start: the measurement is right, the transcript was not
  const b = fixture(3400, 3400, 5400);
  const c = b.ctx(5400);
  c.transcribe = (async () => [
    { w: "then", s: 4.3, e: 5.9 },
    { w: "the", s: 5.9, e: 6.2 },
    { w: "chart", s: 6.2, e: 6.5 },
  ]) as never;
  const stretched = await checkDrift(c);
  const e = stretched.diagnostics?.anchors[0];
  assert.deepEqual([e?.rawMeasuredMs, e?.measuredMs, e?.gapMs], [4300, 5400, 0]);
  assert.equal(e?.transcriptOnOnset, false, "the stretched word start is not on an onset");
  assert.doesNotMatch(stretched.items[0]?.message ?? "", /disagree/);
});

test("sidesWith: who the audio supports when the transcript and the plan disagree", () => {
  assert.match(
    sidesWith({ transcriptOnOnset: true }),
    /measurement is probably right and the plan is off/,
  );
  assert.match(
    sidesWith({ transcriptOnOnset: false, onsetAtPlanMs: 5400 }),
    /the measurement is probably off/,
  );
  assert.match(sidesWith({ transcriptOnOnset: false }), /the measurement or the render is off/);
});
