/**
 * S1 end-to-end (opt-in: DEMO_REC_E2E=1): fixture → storyboard → approved
 * take → `say` narration → naive mux. Asserts the output format and that the
 * page visibly changed at the `results-visible` anchor (video time == take time).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { serveFixture } from "../src/fixture/server.ts";
import { ffprobe, run } from "../src/media/ffmpeg.ts";
import { runS1 } from "../src/pipeline/s1.ts";
import { sayAvailable } from "../src/tts/say.ts";
import { readState } from "../src/workdir/state.ts";

const STORYBOARD = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "storyboards",
  "s1-search.yaml",
);
const enabled = process.env.DEMO_REC_E2E === "1";
const skip = !enabled ? "set DEMO_REC_E2E=1" : !sayAvailable() ? "needs macOS say" : false;

type Box = { x: number; y: number; w: number; h: number };

/** 64×32 grayscale thumbnail of `box` (CSS px × dpr) in the frame at `sec`. */
async function thumb(video: string, sec: number, box: Box, dpr: number): Promise<Buffer> {
  const out = path.join(os.tmpdir(), `demo-rec-thumb-${process.pid}-${sec}.gray`);
  const crop = `crop=${box.w * dpr}:${box.h * dpr}:${box.x * dpr}:${box.y * dpr}`;
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    sec.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    `${crop},scale=64:32,format=gray`,
    "-f",
    "rawvideo",
    out,
  ]);
  const buf = fs.readFileSync(out);
  fs.rmSync(out);
  return buf;
}
const meanDiff = (a: Buffer, b: Buffer) =>
  a.reduce((n, v, i) => n + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

test(
  "S1 walking skeleton produces a narrated 1080p30 MP4 whose timeline matches the take",
  { skip, timeout: 240_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-e2e-"));
    const fixture = await serveFixture(0);
    try {
      const config = { ...resolveConfig({ env: {}, readFile: () => undefined }), root };
      const result = await runS1({
        config,
        project: "e2e",
        appName: "Acme Pulse",
        baseUrl: fixture.url,
        storyboardFile: STORYBOARD,
        seed: 5,
      });

      // Gate was exercised: storyboard stored as v1 and approved.
      assert.equal(readState(result.projectDir)?.line.storyboard, 1);

      const probe = await ffprobe(result.output);
      const v = probe.streams.find((s) => s.codec_type === "video");
      const a = probe.streams.find((s) => s.codec_type === "audio");
      assert.equal(`${v?.width}x${v?.height}`, "1920x1080");
      assert.equal(v?.r_frame_rate, "30/1");
      assert.equal(a?.codec_name, "aac");
      assert.ok(Math.abs(probe.duration - result.mux.total) < 0.1);

      // Anchor check on the master, inside the anchor's own box: empty just
      // before results-visible, filled right after, stable afterwards.
      const shown = result.take.events.find((e) => e.mark === "results-visible");
      assert.ok(shown?.box && result.take.rawVideo);
      const dpr = config.viewport.dpr;
      const at = (dt: number) =>
        thumb(result.take.rawVideo as string, (shown.t + dt) / 1000, shown.box as Box, dpr);
      const before = await at(-150);
      const afterShown = await at(100);
      const later = await at(500);
      const appear = meanDiff(before, afterShown);
      const settle = meanDiff(afterShown, later);
      assert.ok(
        appear > 8,
        `results appear within ±150 ms of the anchor (diff ${appear.toFixed(1)})`,
      );
      assert.ok(
        settle < appear / 4,
        `and stay (diff ${settle.toFixed(1)} vs ${appear.toFixed(1)})`,
      );

      // A second run reuses the identical storyboard version and allocates take-002.
      const again = await runS1({
        config,
        project: "e2e",
        appName: "Acme Pulse",
        baseUrl: fixture.url,
        storyboardFile: STORYBOARD,
        seed: 6,
      });
      assert.equal(again.storyboardVersion, 1);
      assert.equal(again.take.takeId, "take-002");
    } finally {
      await fixture.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
