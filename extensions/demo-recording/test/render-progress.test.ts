/**
 * Render progress (R3-21, item 20): ffmpeg's `-progress` lines are parsed, the pieces of a render are weighted by their length, and the label says how far and how long.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PieceProgress, etaWords } from "../src/edit/progress.ts";
import { type FfmpegProgress, ffmpeg, progressParser } from "../src/media/ffmpeg.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";

test("the parser reads -progress blocks: output time (µs), speed, and the end", () => {
  const got: FfmpegProgress[] = [];
  const feed = progressParser((p) => got.push(p));
  // a block split across chunks, the way a pipe delivers it
  feed("frame=30\nfps=0.00\nout_time_us=1000000\nout_ti");
  feed("me_ms=1000000\nspeed=2.5x\nprogress=continue\n");
  feed(
    "out_time_us=2500000\nspeed=N/A\nprogress=continue\nout_time_us=4000000\nspeed= 3.1x \nprogress=end\n",
  );
  assert.deepEqual(got, [
    { outTimeMs: 1000, speed: 2.5, end: false },
    { outTimeMs: 2500, speed: null, end: false },
    { outTimeMs: 4000, speed: 3.1, end: true },
  ]);
  // out_time_ms alone (the same number, microseconds), and a block without a time says nothing
  const g2: FfmpegProgress[] = [];
  const f2 = progressParser((p) => g2.push(p));
  f2(
    "progress=continue\nout_time_ms=500000\nspeed=1x\nprogress=continue\nout_time_us=N/A\nprogress=continue\n",
  );
  assert.deepEqual(g2, [
    { outTimeMs: 500, speed: 1, end: false },
    { outTimeMs: 500, speed: 1, end: false },
  ]);
});

test("how long is left, in words that do not pretend to be exact", () => {
  assert.equal(etaWords(3), "a few seconds left");
  assert.equal(etaWords(21), "about 25 s left");
  assert.equal(etaWords(59), "about 60 s left");
  assert.equal(etaWords(90), "about 2 min left");
  assert.equal(etaWords(600), "about 10 min left");
  assert.equal(etaWords(Number.NaN), "");
});

test("pieces are weighted by their length; the bar moves inside a piece; updates are throttled but a start and an end never are", () => {
  const out: { done: number; total: number; label: string; percent: number; etaSec?: number }[] =
    [];
  let t = 1000;
  // two scenes of 10 s and 20 s, then the full video of 32 s (the scenes plus a 2 s title)
  const p = new PieceProgress([10_000, 20_000, 32_000], (e) => out.push(e), { now: () => t });
  p.at(0, "scene a (draft)", 0);
  assert.deepEqual(
    [out[0]?.done, out[0]?.total, out[0]?.percent, out[0]?.label],
    [0, 62_000, 0, "scene a (draft) · 0 %"],
  );
  t += 100;
  p.at(0, "scene a (draft)", 0.4, 2); // within 400 ms of the last one: dropped
  assert.equal(out.length, 1, "throttled");
  t += 400;
  p.at(0, "scene a (draft)", 0.5, 2);
  assert.equal(out.at(-1)?.done, 5000);
  assert.equal(out.at(-1)?.percent, 8, "5 s of 62 s");
  assert.equal(out.at(-1)?.etaSec, 28.5, "57 s of output left at 2x real time");
  assert.match(out.at(-1)?.label ?? "", /^scene a \(draft\) · 8 % · about 30 s left$/);
  p.at(0, "scene a (draft)", 1);
  assert.equal(out.at(-1)?.done, 10_000, "an end is never throttled");
  p.at(1, "scene b (draft)", 0);
  assert.equal(out.at(-1)?.done, 10_000, "the next piece starts where the last ended");
  t += 500;
  p.at(1, "scene b (draft)", 0.5, 4);
  assert.equal(out.at(-1)?.done, 20_000);
  assert.equal(out.at(-1)?.percent, 32);
  p.at(1, "scene b (draft)", 1);
  p.at(2, "full video (draft)", 0);
  t += 500;
  p.at(2, "full video (draft)", 0.5, 4);
  assert.equal(
    out.at(-1)?.done,
    46_000,
    "the full video is the biggest piece: half of it is 16 s of the 62",
  );
  assert.equal(out.at(-1)?.percent, 74);
  p.finish("done (draft)");
  assert.deepEqual(
    [out.at(-1)?.done, out.at(-1)?.total, out.at(-1)?.percent, out.at(-1)?.label],
    [62_000, 62_000, 100, "done (draft)"],
  );
  // the bar never goes backwards
  const dones = out.map((e) => e.done);
  assert.deepEqual(
    dones,
    [...dones].sort((a, b) => a - b),
  );
});

test("one piece (a draft has no scene files): the bar moves from 0 to 100 inside it", () => {
  const out: number[] = [];
  let t = 0;
  const p = new PieceProgress([30_000], (e) => out.push(e.percent), { now: () => t });
  for (const f of [0, 0.1, 0.3, 0.6, 0.9, 1]) {
    t += 1000;
    p.at(0, "full video", f, 3);
  }
  assert.deepEqual(out, [0, 10, 30, 60, 90, 100]);
});

test(
  "ffmpeg reports its own progress while it runs (real ffmpeg)",
  { skip: !hasBinary("ffmpeg") && "needs ffmpeg" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffprog-"));
    try {
      const seen: FfmpegProgress[] = [];
      await ffmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x180:rate=30:duration=3",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          path.join(dir, "o.mp4"),
        ],
        { onProgress: (p) => seen.push(p) },
      );
      assert.ok(seen.length >= 1);
      assert.equal(seen.at(-1)?.end, true);
      assert.ok(
        Math.abs((seen.at(-1)?.outTimeMs ?? 0) - 3000) < 100,
        `ends near 3 s: ${seen.at(-1)?.outTimeMs}`,
      );
      assert.ok(seen.every((p, i) => i === 0 || p.outTimeMs >= (seen[i - 1]?.outTimeMs ?? 0)));
      // without a callback nothing changes: stdout is not parsed and the command line has no -progress
      const plain = await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=10:duration=1",
        path.join(dir, "p.mp4"),
      ]);
      assert.equal(plain.stdout, "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
