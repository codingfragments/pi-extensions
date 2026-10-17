/**
 * P1a PR 9 (Q0c): anchors of a provider alignment go where the narration is HEARD. The first real run showed
 * ElevenLabs timestamps about 0.6 s ahead of the audible words after a pause; the edit trusted them and
 * placed the narration late. An anchor now moves to the nearest speech onset (up to 250 ms earlier, or later
 * while the onset is still inside the first word's own span); older cache entries are upgraded once.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { snapAnchorsToOnsets } from "../src/align/onset.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import type { TtsEngine } from "../src/tts/engines.ts";
import { readManifest, renderVoice } from "../src/tts/synthesize.ts";
import { parseVo } from "../src/vo/script.ts";

const FF = hasBinary("ffmpeg");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1a-snap-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** An envelope of 10 ms frames: speech (−10 dB) in the given [from, to) ms ranges, quiet (−80 dB) elsewhere. */
function envelopeOf(totalMs: number, speech: [number, number][]): number[] {
  return Array.from({ length: totalMs / 10 }, (_, f) =>
    speech.some(([a, b]) => f * 10 >= a && f * 10 < b) ? -10 : -80,
  );
}

const SEGMENTS = [{}, { anchor: "m1" }];
const words = (firstStart: number, firstEnd: number) => [
  { w: "Intro", seg: 0, s: 0, e: 0.4 },
  { w: "Office", seg: 1, s: firstStart, e: firstEnd },
  { w: "noise", seg: 1, s: firstEnd, e: firstEnd + 0.4 },
];

test("the provider is ahead: the anchor moves to the onset inside the first word's span", () => {
  // speech 0–2.28 s, a pause, speech from 2.74 s. The provider says the anchored word starts at 2.11 s (inside the first speech).
  const env = envelopeOf(4000, [
    [0, 2280],
    [2740, 4000],
  ]);
  const al = { words: words(2.11, 2.93), anchors: { m1: 2.11 } };
  assert.deepEqual(snapAnchorsToOnsets(al, SEGMENTS, env), [{ mark: "m1", from: 2.11, to: 2.74 }]);
  assert.equal(al.anchors.m1, 2.74);
});

test("an onset after the first word's span is another word: the anchor stays", () => {
  const env = envelopeOf(4000, [
    [0, 2280],
    [3500, 4000],
  ]);
  const al = { words: words(2.11, 2.93), anchors: { m1: 2.11 } };
  assert.deepEqual(snapAnchorsToOnsets(al, SEGMENTS, env), []);
  assert.equal(al.anchors.m1, 2.11);
});

test("the provider is a little behind: up to 250 ms back to the onset; further is left alone", () => {
  const env = envelopeOf(5000, [
    [0, 1000],
    [1800, 3000],
    [3600, 5000],
  ]);
  const near = { words: words(1.9, 2.4), anchors: { m1: 1.9 } }; // onset at 1.8 s: 100 ms back
  assert.deepEqual(snapAnchorsToOnsets(near, SEGMENTS, env), [{ mark: "m1", from: 1.9, to: 1.8 }]);
  const far = { words: words(2.4, 2.9), anchors: { m1: 2.4 } }; // nearest onset 1.8 s: 600 ms back
  assert.deepEqual(snapAnchorsToOnsets(far, SEGMENTS, env), []);
});

test("no onset (continuous speech) or an exact hit: nothing moves; a segment without an anchor is skipped", () => {
  const flow = envelopeOf(3000, [[0, 3000]]);
  const a = { words: words(1.0, 1.5), anchors: { m1: 1.0 } };
  assert.deepEqual(snapAnchorsToOnsets(a, SEGMENTS, flow), []);
  const exact = envelopeOf(3000, [
    [0, 800],
    [1500, 3000],
  ]);
  const b = { words: words(1.5, 2.0), anchors: { m1: 1.5 } };
  assert.deepEqual(snapAnchorsToOnsets(b, SEGMENTS, exact), []);
  const c = { words: words(1.0, 1.5), anchors: { m1: 1.0 } };
  assert.deepEqual(snapAnchorsToOnsets(c, [{}, {}], exact), [], "no anchor on the segment");
});

// --- through renderVoice -------------------------------------------------------------------

const VO = `---
take: take-001
---
## 01-a
Start text here. [@m1] Anchored phrase follows now.
`;

/**
 * A provider engine whose audio is speech-like bursts (0–1 s and 1.8–3 s) while its timestamps put the anchored
 * word (the 4th) at 1.0 s: 0.8 s early, inside the quiet pause.
 */
function earlyProvider(): TtsEngine & { calls: number } {
  const e = {
    id: "elevenlabs" as TtsEngine["id"],
    calls: 0,
    async health() {
      return { ok: true, reason: "ok", voice: { id: "v", name: "v" } };
    },
    identity: (v: string) => `elevenlabs:${v}:m`,
    async synthesize(text: string, out: string) {
      e.calls++;
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=if(lt(t\\,1)+between(t\\,1.8\\,3)\\,0.5*sin(2*PI*440*t)\\,0):s=22050:d=3",
          out,
        ],
        { stdio: "ignore" },
      );
      const c = [...text];
      // 12 chars per second: "Start text here. " is 17 chars → the anchored word starts at 17/17 = 1.0 s
      return {
        durationSec: 3,
        chars: {
          chars: c,
          starts: c.map((_, i) => i / 17),
          ends: c.map((_, i) => (i + 1) / 17),
        },
      };
    },
  };
  return e;
}

test(
  "renderVoice: an onset beyond the first word's span is another word: the anchor stays",
  { skip: !FF && "needs ffmpeg" },
  async () => {
    const engine = earlyProvider();
    const m = await renderVoice({
      projectDir: dir,
      voVersion: 1,
      take: "take-001",
      sections: parseVo(VO).sections,
      engines: [engine],
    });
    const al = m.sections["01-a"]?.alignment;
    assert.equal(al?.source, "provider");
    assert.equal(al?.snapped, true);
    // the provider said 1.0 s; the speech comes back at 1.8 s: that is within the first word's span ("Anchored" is 9 chars: 1.0 to 1.53 s)? no:
    // the onset (1.8 s) lies beyond the first word's end, so the anchor must NOT move to another word
    assert.equal(al?.anchors.m1, 1);
  },
);

/** Same, but the provider's first word of the segment is long enough to contain the onset. */
function longFirstWord(): TtsEngine {
  const base = earlyProvider();
  return {
    ...base,
    async synthesize(text, out) {
      const r = await base.synthesize(text, out, "v");
      const c = [...text];
      // the anchored word's chars cover 1.0 to 2.4 s: the onset at 1.8 s is inside that word's span
      const start = text.indexOf("Anchored");
      const end = start + "Anchored".length;
      return {
        durationSec: r.durationSec,
        chars: {
          chars: c,
          starts: c.map((_, i) =>
            i < start
              ? (i / start) * 1.0
              : i < end
                ? 1.0 + ((i - start) / (end - start)) * 1.4
                : 2.4 + (i - end) * 0.03,
          ),
          ends: c.map((_, i) =>
            i < start
              ? ((i + 1) / start) * 1.0
              : i < end
                ? 1.0 + ((i - start + 1) / (end - start)) * 1.4
                : 2.4 + (i - end + 1) * 0.03,
          ),
        },
      };
    },
  };
}

test(
  "renderVoice: onset inside the first word's span: snapped, and an older cache entry is upgraded once",
  { skip: !FF && "needs ffmpeg" },
  async () => {
    const engine = longFirstWord();
    const run = () =>
      renderVoice({
        projectDir: dir,
        voVersion: 1,
        take: "take-001",
        sections: parseVo(VO).sections,
        engines: [engine],
      });
    const first = await run();
    assert.equal(first.sections["01-a"]?.alignment.anchors.m1, 1.8, "moved to the audible onset");

    // simulate a cache entry made before Q0c: provider anchors, not marked as snapped
    const sec = first.sections["01-a"];
    const metaFile = path.join(dir, (sec?.file as string).replace(/\.wav$/, ".json"));
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    meta.alignment.anchors.m1 = 1.0;
    Reflect.deleteProperty(meta.alignment, "snapped");
    fs.writeFileSync(metaFile, JSON.stringify(meta));

    const second = await run();
    assert.equal(
      second.sections["01-a"]?.cached,
      true,
      "from the cache: nothing synthesized, nothing billed",
    );
    assert.equal(second.billedChars, 0);
    assert.equal(second.sections["01-a"]?.alignment.anchors.m1, 1.8, "upgraded");
    assert.equal(
      JSON.parse(fs.readFileSync(metaFile, "utf8")).alignment.snapped,
      true,
      "and stored",
    );
    assert.equal(readManifest(dir, 1)?.sections["01-a"]?.alignment.anchors.m1, 1.8);
  },
);
