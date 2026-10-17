/**
 * P1a PR 8 (Q0): calibration of the drift measurement. A rendered mix is built from real speech (macOS `say`) placed
 * at KNOWN times, one phrase deliberately late; the QA's drift check (real Whisper on the mix, onset refinement) must
 * reproduce the planned drift within 100 ms. This proves the measurement on clean speech; what it cannot do is
 * what the keycraft run showed (docs/QA.md, "Calibration verdict"): a plan that is off, or a transcript that stretches
 * a word over the pause before it. The diagnostics exist to tell those apart.
 *
 * Whisper is not deterministic on this audio (the same mix finds 0 to 3 of the 3 anchors from run to run), so the test asserts
 * accuracy of what is found, reports coverage, and skips when nothing was found.
 *
 * Needs ffmpeg, uv (Whisper) and macOS say; skipped elsewhere (CI has none of them).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { envelope } from "../src/align/onset.ts";
import { resolveConfig } from "../src/config.ts";
import type { SceneTimeline, Timeline } from "../src/edit/timeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { type Ctx, checkDrift } from "../src/qa/run.ts";
import type { RenderRecord } from "../src/render/store.ts";
import { sayAvailable } from "../src/tts/say.ts";

const skip =
  !(hasBinary("ffmpeg") && hasBinary("uv") && sayAvailable()) && "needs ffmpeg + uv + macOS say";

const PHRASES = [
  "Headline churn is three point one percent.",
  "Then the regional chart appears.",
  "Results arrive in a table below.",
  "Six times North America.",
];
/** When each phrase's audio file starts in the mix (ms) and how late its speech is planned after its event (ms). */
const AT = [1000, 4500, 8500, 12500];
const LATE = [0, 0, 400, 0];

test(
  "a mix of real speech at known times: measured drift reproduces the planned drift within 100 ms",
  { skip, timeout: 600_000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1a-calib-"));
    try {
      const proj = path.join(dir, "projects", "p");
      fs.mkdirSync(path.join(proj, "vo", "audio"), { recursive: true });
      fs.mkdirSync(path.join(proj, "edit"), { recursive: true });
      fs.mkdirSync(path.join(proj, "render"), { recursive: true });

      // the speech, and where in each file it really starts (the truth)
      const onset: number[] = [];
      for (const [i, p] of PHRASES.entries()) {
        const wav = path.join(dir, `p${i}.wav`);
        execFileSync("say", ["--file-format=WAVE", "--data-format=LEI16@22050", "-o", wav, p]);
        const env = await envelope(wav);
        const peak = Math.max(...env);
        onset.push(env.findIndex((v) => v >= peak - 32) * 10);
      }
      // the mix: each phrase delayed to its place, black video of the same length
      const inputs = PHRASES.flatMap((_, i) => ["-i", path.join(dir, `p${i}.wav`)]);
      const delays = AT.map((t, i) => `[${i + 1}:a]adelay=${t}|${t}[a${i}]`).join(";");
      const mix = `${delays};${AT.map((_, i) => `[a${i}]`).join("")}amix=inputs=${AT.length}:normalize=0[out]`;
      const full = path.join(dir, "full.mp4");
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=64x36:r=10:d=18",
          ...inputs,
          "-filter_complex",
          mix,
          "-map",
          "0:v",
          "-map",
          "[out]",
          "-t",
          "18",
          "-pix_fmt",
          "yuv420p",
          full,
        ],
        { stdio: "ignore" },
      );

      // the plan: anchor a_i (i ≥ 1) has its speech planned at the true onset; its event is LATE[i] earlier
      const marks = PHRASES.slice(1).map((_, k) => `a${k + 1}`);
      const speechAt = AT.map((t, i) => t + (onset[i] as number));
      const anchors = marks.map((mark, k) => {
        const i = k + 1;
        return {
          mark,
          event: 0,
          out: (speechAt[i] as number) - (LATE[i] as number),
          audioAt: speechAt[i] as number,
          drift: LATE[i] as number,
        };
      });
      const words = PHRASES.flatMap((p, seg) =>
        p.split(" ").map((w) => ({ w, seg, s: 0, e: 0.3 })),
      );
      fs.writeFileSync(
        path.join(proj, "vo", "audio", "v1.json"),
        JSON.stringify({
          schema: 1,
          voVersion: 1,
          take: "take-001",
          sections: { "01-a": { key: "01-a", alignment: { anchors: {}, words } } },
        }),
      );
      fs.writeFileSync(
        path.join(proj, "vo", "script.v1.md"),
        `---\ntake: take-001\n---\n## 01-a\n${PHRASES.map((p, i) => (i ? `[@a${i}] ${p}` : p)).join(" ")}\n`,
      );
      const timeline = {
        schema: 1,
        take: "take-001",
        voVersion: 1,
        scenes: [
          {
            id: "01-a",
            title: "A",
            audioFile: null,
            pieces: [],
            audio: [],
            anchors,
            durationMs: 18000,
            stats: {},
          } as unknown as SceneTimeline,
        ],
        full: [],
        totals: {},
      } as unknown as Timeline;
      fs.writeFileSync(path.join(proj, "edit", "timeline.v1.json"), JSON.stringify(timeline));

      const c: Ctx = {
        projectDir: proj,
        config: resolveConfig({ env: { DEMO_REC_CONFIG: path.join(dir, "none.json") } }),
        rec: { version: 1, timeline: 1 } as unknown as RenderRecord,
        t: timeline,
        takeDir: path.join(proj, "takes", "take-001"),
        snaps: [],
        events: [],
        timing: { titleMs: 0, sceneStart: { "01-a": 0 }, itemStart: [] },
        full,
      };
      const r = await checkDrift(c);
      assert.equal(r.whisper, true, "Whisper ran");
      const diag = r.diagnostics?.anchors ?? [];
      assert.equal(diag.length, 3);
      // ACCURACY is what makes a fix safe: an anchor that is found must be measured right. COVERAGE (Whisper
      // sometimes drops words or stretches them over a pause, so an anchor is not found) is reported, not asserted;
      // QA says "not measured" for those and never guesses.
      const found = diag.filter((a) => a.measuredDriftMs !== undefined);
      t.diagnostic(`found ${found.length} of ${diag.length} anchors in the transcript`);
      if (!found.length)
        return t.skip("Whisper found none of the anchors this time: nothing to calibrate");
      for (const a of found) {
        const i = Number(a.mark.slice(1));
        assert.ok(
          Math.abs((a.measuredDriftMs as number) - (LATE[i] as number)) <= 100,
          `${a.mark}: measured ${a.measuredDriftMs} ms, planned ${LATE[i]} ms (speech at ${speechAt[i]}, measured ${a.measuredMs}, heard ${JSON.stringify(a.heard)})`,
        );
        assert.ok(Math.abs(a.gapMs as number) <= 100, `${a.mark}: gap ${a.gapMs}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
