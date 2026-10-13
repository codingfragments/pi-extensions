/**
 * LIVE ElevenLabs check (opt-in, costs ~200 characters):
 *   DEMO_REC_ELEVENLABS_E2E=1 ELEVENLABS_API_KEY=… DEMO_REC_VOICE="<your voice name>" \
 *     node --test extensions/demo-recording/test/s4-elevenlabs.test.ts
 * Verifies voice-by-name resolution, the real /with-timestamps response, and
 * that provider anchor times match the audio's energy onsets. The sample is
 * kept at $TMPDIR/demo-rec-elevenlabs-sample.wav for listening.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { envelope, snapToOnset } from "../src/align/onset.ts";
import { resolveConfig } from "../src/config.ts";
import { buildEngines } from "../src/tts/factory.ts";
import { renderVoice } from "../src/tts/synthesize.ts";
import { parseVo } from "../src/vo/script.ts";

const live = process.env.DEMO_REC_ELEVENLABS_E2E === "1";
const skip = !live
  ? "set DEMO_REC_ELEVENLABS_E2E=1 (live, costs credits)"
  : !process.env.ELEVENLABS_API_KEY
    ? "ELEVENLABS_API_KEY not set"
    : false;

test(
  "live ElevenLabs: voice by name, real timestamps, anchors on onsets",
  { skip, timeout: 120_000 },
  async () => {
    const cfg = resolveConfig();
    assert.ok(cfg.voiceName, "set DEMO_REC_VOICE or voiceName in the config");
    const [el] = buildEngines({ ...cfg, ttsChain: ["elevenlabs"] });
    assert.ok(el);
    const health = await el.health();
    assert.ok(health.ok, health.reason);
    console.log(`voice resolved: ${health.voice?.name} (${health.voice?.id})`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-el-"));
    const vo = parseVo(
      "---\ntake: take-001\n---\n## 01-a\nHeadline churn is 3.1 percent. [@emea] Then the regional chart: EMEA sits at 14.2 percent.\n",
    );
    const m = await renderVoice({
      projectDir: dir,
      voVersion: 1,
      take: "take-001",
      sections: vo.sections,
      engines: [el],
    });
    const sec = m.sections["01-a"];
    assert.ok(sec);
    assert.equal(sec.alignment.source, "provider", "timings came from ElevenLabs, not Whisper");
    const wav = path.join(dir, sec.file);
    const env = await envelope(wav);
    const t = sec.alignment.anchors.emea as number;
    const onset = snapToOnset(t, env);
    console.log(
      `anchor @emea at ${t.toFixed(3)} s (energy onset ${onset.toFixed(3)} s), ${sec.durationSec.toFixed(2)} s audio, ${m.billedChars} chars`,
    );
    assert.ok(
      Math.abs(onset - t) <= 0.08,
      `provider anchor within 80 ms of the onset (${((onset - t) * 1000).toFixed(0)} ms)`,
    );
    const keep = path.join(os.tmpdir(), "demo-rec-elevenlabs-sample.wav");
    fs.copyFileSync(wav, keep);
    console.log(`listen: ${keep}`);
    fs.rmSync(dir, { recursive: true, force: true });
  },
);
