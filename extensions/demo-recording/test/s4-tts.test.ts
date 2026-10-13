/**
 * S4 voice: engines (mocked HTTP), chain + no-mixing policy, cache, alignment
 * (pure), and real local paths (say/Kokoro + Whisper) when uv is installed.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { alignChars, fromCharAlignment, fromTranscript } from "../src/align/align.ts";
import { dropSilentWords, envelope, refineOnsets } from "../src/align/onset.ts";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import {
  EngineUnavailable,
  type FetchLike,
  type TtsEngine,
  elevenLabs,
  kokoro,
  openAi,
} from "../src/tts/engines.ts";
import { briefVoice, buildEngines } from "../src/tts/factory.ts";
import { sayAvailable } from "../src/tts/say.ts";
import { readManifest, renderVoice, whisperWords } from "../src/tts/synthesize.ts";
import { parseVo, splitSegments } from "../src/vo/script.ts";

const FF = hasBinary("ffmpeg");
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-tts-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A real short audio file (tone) in the given format. */
function tone(file: string, sec = 1.2, codec: string[] = []) {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${sec}`,
    ...codec,
    file,
  ]);
  return fs.readFileSync(file);
}

type Call = { url: string; init?: Parameters<FetchLike>[1] };
function mockFetch(
  handler: (
    url: string,
    init?: Parameters<FetchLike>[1],
  ) => { status: number; json?: unknown; body?: Buffer | string },
) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.json ?? "")),
      arrayBuffer: async () => {
        const b = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ""));
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  return { fetch, calls };
}

const VOICES = {
  voices: [
    { voice_id: "v-1", name: "George" },
    { voice_id: "v-2", name: "Stefan v2 (pro clone)" },
  ],
};

test("ElevenLabs health: voice resolved by name (exact, then prefix); clear errors; key never sent elsewhere", async () => {
  const { fetch, calls } = mockFetch(() => ({ status: 200, json: VOICES }));
  const mk = (voiceName: string, apiKey?: string) =>
    elevenLabs({
      ...(apiKey ? { apiKey } : {}),
      voiceName,
      model: "eleven_v4",
      fallbackModel: "eleven_multilingual_v2",
      fetch,
    });
  assert.deepEqual((await mk("stefan v2", "k").health()).voice, {
    id: "v-2",
    name: "Stefan v2 (pro clone)",
  });
  assert.deepEqual((await mk("George", "k").health()).voice, { id: "v-1", name: "George" });
  const missing = await mk("Nobody", "k").health();
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /voice "Nobody" not found .*George, Stefan v2/);
  assert.match((await mk("George").health()).reason, /ELEVENLABS_API_KEY is not set/);
  assert.match((await mk("", "k").health()).reason, /no voice name configured/);
  assert.ok(calls.every((c) => c.url.startsWith("https://api.elevenlabs.io/")));
  assert.equal(calls[0]?.init?.headers?.["xi-api-key"], "k");

  const denied = mockFetch(() => ({ status: 401, json: {} }));
  const h = await elevenLabs({
    apiKey: "bad",
    voiceName: "George",
    model: "m",
    fallbackModel: "f",
    fetch: denied.fetch,
  }).health();
  assert.match(h.reason, /rejected the API key \(401\)/);
});

test(
  "ElevenLabs synth: with-timestamps → wav + char timings; model fallback; quota → EngineUnavailable",
  { skip: !FF && "needs ffmpeg" },
  async () => {
    const mp3 = tone(path.join(dir, "t.mp3"), 1.2, ["-c:a", "libmp3lame"]).toString("base64");
    const text = "Hello world";
    const chars = [..."Hello world"];
    const alignment = {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
    };
    let firstModel = "";
    const { fetch, calls } = mockFetch((url, init) => {
      if (url.endsWith("/v1/voices")) return { status: 200, json: VOICES };
      const body = JSON.parse(String(init?.body));
      if (!firstModel) firstModel = body.model_id;
      if (body.model_id === "eleven_v4")
        return { status: 400, body: "model eleven_v4 is not supported for this endpoint" };
      return { status: 200, json: { audio_base64: mp3, alignment } };
    });
    const el = elevenLabs({
      apiKey: "k",
      voiceName: "George",
      model: "eleven_v4",
      fallbackModel: "eleven_multilingual_v2",
      fetch,
    });
    const before = el.identity("v-1");
    const out = path.join(dir, "o.wav");
    const r = await el.synthesize(text, out, "v-1");
    assert.ok(Math.abs(r.durationSec - 1.2) < 0.1);
    assert.deepEqual(r.chars?.chars, chars);
    assert.equal(firstModel, "eleven_v4");
    assert.match(
      calls.at(-1)?.url ?? "",
      /\/v1\/text-to-speech\/v-1\/with-timestamps\?output_format=mp3_44100_128/,
    );
    assert.notEqual(el.identity("v-1"), before, "cache identity follows the model actually used");
    const probe = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", out],
      { encoding: "utf8" },
    ).trim();
    assert.equal(probe, "48000,1");

    for (const status of [402, 429, 503]) {
      const q = mockFetch((url) =>
        url.endsWith("/v1/voices") ? { status: 200, json: VOICES } : { status, body: "nope" },
      );
      const e = elevenLabs({
        apiKey: "k",
        voiceName: "George",
        model: "m",
        fallbackModel: "m",
        fetch: q.fetch,
      });
      await assert.rejects(
        e.synthesize("x", path.join(dir, `q${status}.wav`), "v-1"),
        EngineUnavailable,
      );
    }
  },
);

test(
  "OpenAI synth: wav response, instructions sent, 5xx → EngineUnavailable",
  { skip: !FF && "needs ffmpeg" },
  async () => {
    const wav = tone(path.join(dir, "o.wav"), 0.8);
    const { fetch, calls } = mockFetch(() => ({ status: 200, body: wav }));
    const oa = openAi({
      apiKey: "sk",
      model: "gpt-4o-mini-tts",
      voice: "ash",
      instructions: "calm",
      fetch,
    });
    assert.equal((await oa.health()).ok, true);
    const r = await oa.synthesize("Hi there", path.join(dir, "out.wav"), "ash");
    assert.ok(Math.abs(r.durationSec - 0.8) < 0.1);
    assert.equal(r.chars, undefined);
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.deepEqual(body, {
      model: "gpt-4o-mini-tts",
      voice: "ash",
      input: "Hi there",
      response_format: "wav",
      instructions: "calm",
    });
    assert.equal(calls[0]?.init?.headers?.authorization, "Bearer sk");
    assert.match(
      (await openAi({ model: "m", voice: "v" }).health()).reason,
      /OPENAI_API_KEY is not set/,
    );
    const bad = mockFetch(() => ({ status: 500, body: "x" }));
    await assert.rejects(
      openAi({ apiKey: "k", model: "m", voice: "v", fetch: bad.fetch }).synthesize(
        "x",
        path.join(dir, "b.wav"),
        "v",
      ),
      EngineUnavailable,
    );
  },
);

test("factory: chain order from config, voice from the brief, keys from env only", async () => {
  const cfg = {
    ...resolveConfig({ env: {}, home: "/h", readFile: () => undefined }),
    voiceName: "Config Voice",
  };
  assert.equal(briefVoice("- **Voice:** Stefan v2\n"), "Stefan v2");
  assert.equal(briefVoice("- **Voice:** _TODO_\n"), undefined);
  assert.equal(briefVoice("- **Voice:** default\n"), undefined);
  const engines = buildEngines(cfg, {
    env: {},
    brief: "- **Voice:** Stefan v2\n",
    uvAvailable: () => false,
  });
  assert.deepEqual(
    engines.map((e) => e.id),
    ["elevenlabs", "openai", "kokoro"],
  );
  assert.match((await engines[0]?.health())?.reason ?? "", /ELEVENLABS_API_KEY is not set/);
  assert.match((await engines[2]?.health())?.reason ?? "", /uv is not installed/);
});

// ---------------- chain policy + cache with fake engines ----------------

function fakeEngine(
  id: string,
  opts: { failAfter?: number; healthy?: boolean; chars?: boolean } = {},
): TtsEngine & { synthCalls: string[] } {
  const synthCalls: string[] = [];
  return {
    id: id as TtsEngine["id"],
    synthCalls,
    async health() {
      return opts.healthy === false
        ? { ok: false, reason: `${id} down` }
        : { ok: true, reason: "ok", voice: { id: `${id}-voice`, name: id } };
    },
    identity: (v) => `${id}:${v}`,
    async synthesize(text, out) {
      if (opts.failAfter !== undefined && synthCalls.length >= opts.failAfter)
        throw new EngineUnavailable(`${id} quota exceeded`);
      synthCalls.push(text);
      tone(out, 0.5 + text.split(" ").length * 0.25);
      if (!opts.chars) return { durationSec: 0.5 + text.split(" ").length * 0.25 };
      const c = [...text];
      return {
        durationSec: 1,
        chars: {
          chars: c,
          starts: c.map((_, i) => i * 0.05),
          ends: c.map((_, i) => i * 0.05 + 0.05),
        },
      };
    },
  };
}

const VO = `---
take: take-001
---
## _intro
Intro words here.
## 01-a
Start text. [@m1] Anchored phrase follows.
## 02-b
Another scene speaks.
`;

const sectionsOf = (text: string) => parseVo(text).sections;
const fakeTranscribe = async (_wav: string, text: string) =>
  text.split(" ").map((w, i) => ({ w, s: 0.3 + i * 0.25, e: 0.3 + i * 0.25 + 0.2 }));

test(
  "renderVoice: skips unhealthy engines, restarts the WHOLE voice-over on mid-run failure (no mixing), caches",
  { skip: !FF && "needs ffmpeg" },
  async () => {
    const down = fakeEngine("elevenlabs", { healthy: false });
    const flaky = fakeEngine("openai", { failAfter: 1 });
    const local = fakeEngine("kokoro");
    const m = await renderVoice({
      projectDir: dir,
      voVersion: 1,
      take: "take-001",
      sections: sectionsOf(VO),
      engines: [down, flaky, local],
      transcribe: fakeTranscribe,
    });
    assert.equal(m.engine, "kokoro");
    assert.deepEqual(
      m.skipped.map((s) => s.engine),
      ["elevenlabs", "openai"],
    );
    assert.match(m.skipped[1]?.reason ?? "", /quota/);
    assert.equal(local.synthCalls.length, 3, "all sections re-done with the next engine");
    assert.deepEqual(Object.keys(m.sections), ["_intro", "01-a", "02-b"]);
    assert.ok(
      Object.values(m.sections).every((s) => fs.readFileSync(path.join(dir, s.file)).length > 1000),
    );
    assert.ok(
      m.sections["01-a"]?.alignment.anchors.m1 !== undefined,
      "anchor time from the transcript",
    );
    assert.equal(
      m.billedChars,
      Object.values(m.sections).reduce((n, sec) => n + sec.chars, 0),
    );
    assert.deepEqual(readManifest(dir, 1)?.engine, "kokoro");

    // Second render: everything cached, nothing billed. Edit one section: only that one is synthesized.
    const again = await renderVoice({
      projectDir: dir,
      voVersion: 2,
      take: "take-001",
      sections: sectionsOf(VO),
      engines: [local],
      transcribe: fakeTranscribe,
    });
    assert.equal(again.billedChars, 0);
    assert.ok(Object.values(again.sections).every((s) => s.cached));
    const edited = await renderVoice({
      projectDir: dir,
      voVersion: 3,
      take: "take-001",
      sections: sectionsOf(VO.replace("Another scene speaks.", "A changed line.")),
      engines: [local],
      transcribe: fakeTranscribe,
    });
    assert.equal(edited.sections["02-b"]?.cached, false);
    assert.equal(edited.sections["01-a"]?.cached, true);
    assert.equal(local.synthCalls.length, 4);

    await assert.rejects(
      renderVoice({
        projectDir: dir,
        voVersion: 4,
        take: "t",
        sections: sectionsOf(VO),
        engines: [down],
      }),
      /no TTS engine is available:\n- elevenlabs: elevenlabs down/,
    );
  },
);

// ---------------- alignment (pure) ----------------

test("alignChars maps matching characters through insertions/deletions", () => {
  const map = alignChars("emea142percent", "emeasitsat142percent");
  assert.equal(map[0], 0);
  assert.equal(map[4], 10, "'1' of 142 maps past the inserted 'sitsat'");
  assert.equal(map[13], 19);
});

test("fromTranscript: numbers split differently still align; anchors get the first word's start", () => {
  const segs = splitSegments("EMEA leads at 14.2% today. [@results] Six times North America.");
  const transcript = [
    { w: "EMEA", s: 0.1, e: 0.4 },
    { w: "leads", s: 0.45, e: 0.7 },
    { w: "at", s: 0.72, e: 0.8 },
    { w: "14", s: 0.85, e: 1.0 },
    { w: ".2", s: 1.0, e: 1.2 },
    { w: "percent", s: 1.2, e: 1.6 },
    { w: "today.", s: 1.62, e: 2.0 },
    { w: "Six", s: 2.6, e: 2.8 },
    { w: "times", s: 2.85, e: 3.1 },
    { w: "North", s: 3.15, e: 3.4 },
    { w: "America.", s: 3.45, e: 4.0 },
  ];
  const al = fromTranscript(segs, transcript, 4.2);
  assert.equal(al.anchors.results, 2.6);
  assert.equal(al.words.find((w) => w.w === "14.2%")?.s, 0.85);
  assert.equal(al.words.length, 9);
});

test("fromCharAlignment: provider char times over our exact text", () => {
  const segs = splitSegments("Hi there. [@go] Now!");
  const text = "Hi there. Now!";
  const chars = [...text];
  const al = fromCharAlignment(
    segs,
    text,
    chars,
    chars.map((_, i) => i * 0.1),
    chars.map((_, i) => i * 0.1 + 0.1),
    1.5,
  );
  assert.deepEqual(
    al.words.map((w) => [w.w, +w.s.toFixed(2)]),
    [
      ["Hi", 0],
      ["there.", 0.3],
      ["Now!", 1.0],
    ],
  );
  assert.equal(al.anchors.go, 1.0);
});

// ---------------- real local paths ----------------

const UV = hasBinary("uv");

test(
  "say + Whisper + onset refinement: anchors within ±80 ms of ground truth",
  { skip: !(UV && FF && sayAvailable()) && "needs uv + ffmpeg + macOS say", timeout: 600_000 },
  async () => {
    const phrases = [
      "Headline churn is 3.1 percent.",
      "Then the regional chart.",
      "EMEA sits at 14.2 percent.",
      "Six times North America.",
    ];
    const gaps = [0, 0.6, 1.1, 0.4];
    const truth: number[] = [];
    const parts: string[] = [];
    let t = 0;
    for (const [i, p] of phrases.entries()) {
      if (gaps[i]) {
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=22050:cl=mono",
          "-t",
          String(gaps[i]),
          path.join(dir, `g${i}.wav`),
        ]);
        parts.push(`g${i}.wav`);
        t += gaps[i] as number;
      }
      execFileSync("say", [
        "--file-format=WAVE",
        "--data-format=LEI16@22050",
        "-o",
        path.join(dir, `p${i}.wav`),
        p,
      ]);
      const env = await envelope(path.join(dir, `p${i}.wav`));
      const peak = Math.max(...env);
      truth.push(t + env.findIndex((v) => v >= peak - 32) / 100);
      t += Number(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            path.join(dir, `p${i}.wav`),
          ],
          { encoding: "utf8" },
        ),
      );
      parts.push(`p${i}.wav`);
    }
    fs.writeFileSync(path.join(dir, "list.txt"), parts.map((p) => `file '${p}'\n`).join(""));
    const wav = path.join(dir, "all.wav");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      path.join(dir, "list.txt"),
      "-ar",
      "16000",
      wav,
    ]);
    const script = phrases.map((p, i) => (i ? `[@a${i}] ${p}` : p)).join(" ");
    const segs = splitSegments(script);
    const env = await envelope(wav);
    const words = refineOnsets(
      dropSilentWords(await whisperWords(wav, phrases.join(" ")), env),
      env,
    );
    const al = fromTranscript(segs, words, t);
    for (let i = 1; i < phrases.length; i++) {
      const err = Math.abs(((al.anchors[`a${i}`] as number) - (truth[i] as number)) * 1000);
      assert.ok(
        err <= 80,
        `anchor a${i}: ${err.toFixed(0)} ms off (truth ${truth.map((x) => x.toFixed(2))}, anchors ${JSON.stringify(al.anchors)}, words ${words.map((w) => `${w.w}@${w.s}`).join(" ")})`,
      );
    }
  },
);

test(
  "Kokoro (local) synthesizes a section",
  { skip: !(UV && FF) && "needs uv + ffmpeg", timeout: 600_000 },
  async () => {
    const k = kokoro({ voice: "am_michael", uvAvailable: () => true });
    assert.equal((await k.health()).ok, true);
    const r = await k.synthesize(
      "Headline churn is three point one percent.",
      path.join(dir, "k.wav"),
      "am_michael",
    );
    assert.ok(r.durationSec > 1.5 && r.durationSec < 6, `duration ${r.durationSec}`);
  },
);

test("alignment resists Whisper hallucinations: silent words dropped, earliest copy wins", () => {
  // 3 s of speech energy, then silence; Whisper repeats the script at 3.2–3.4 s.
  const env = Array.from({ length: 400 }, (_, f) => (f < 300 ? -12 : -80));
  const words = [
    { w: "Then", s: 0.2, e: 0.5 },
    { w: "EMEA", s: 1.5, e: 1.9 },
    { w: "leads.", s: 2.0, e: 2.6 },
    { w: "Then", s: 3.2, e: 3.21 },
    { w: "EMEA", s: 3.3, e: 3.31 },
    { w: "leads.", s: 3.35, e: 3.36 },
  ];
  assert.deepEqual(
    dropSilentWords(words, env).map((w) => w.s),
    [0.2, 1.5, 2.0],
  );
  const segs = splitSegments("Then [@x] EMEA leads.");
  assert.equal(
    fromTranscript(segs, words, 4).anchors.x,
    1.5,
    "even with the duplicate kept, the earliest copy is used",
  );
});

test("refineOnsets: a pause swallowed into the next word moves its start to the real onset", () => {
  // 10 ms frames: speech 0–1.40 s, silence 1.40–2.00 s, speech 2.00–3.00 s
  const env = Array.from({ length: 320 }, (_, f) => (f < 140 || (f >= 200 && f < 300) ? -12 : -80));
  const words = [
    { w: "percent,", s: 1.0, e: 1.38 },
    { w: "six", s: 1.38, e: 2.3 }, // Whisper glued the pause onto "six"
    { w: "times", s: 2.3, e: 2.7 },
  ];
  const r = refineOnsets(words, env);
  assert.equal(r[1]?.s, 2, "starts where the energy starts, not at the previous word's tail");
  assert.equal(r[2]?.s, 2.3, "continuous speech is untouched");
  assert.equal(r[0]?.s, 1.0);
});

test("norm: number words, percent and ampersand normalize identically on both sides", async () => {
  const { norm } = await import("../src/align/align.ts");
  assert.equal(norm("Six"), norm("6"));
  assert.equal(norm("14.2%"), "142percent");
  assert.equal(norm("R&D"), "randd");
  const segs = splitSegments("EMEA at 14.2 percent. [@x] Six times North America.");
  const words = [
    { w: "EMEA", s: 0.1, e: 0.4 },
    { w: "at", s: 0.45, e: 0.6 },
    { w: "14", s: 0.62, e: 0.9 },
    { w: ".2%,", s: 0.9, e: 1.5 },
    { w: "6", s: 2.0, e: 2.3 },
    { w: "times", s: 2.3, e: 2.6 },
    { w: "North", s: 2.62, e: 2.9 },
    { w: "America.", s: 2.9, e: 3.4 },
  ];
  assert.equal(fromTranscript(segs, words, 3.5).anchors.x, 2.0, "'Six' matches Whisper's '6'");
});

test("snapToOnset: an anchor inside a pause moves to the next speech onset", async () => {
  const { snapToOnset } = await import("../src/align/onset.ts");
  const env = Array.from({ length: 300 }, (_, f) => (f < 100 || f >= 180 ? -12 : -80));
  assert.equal(snapToOnset(1.3, env), 1.8);
  assert.equal(snapToOnset(0.5, env), 0.5, "inside speech: unchanged");
});

test("refineOnsets: a pause stretched into the PREVIOUS word's end is found too", () => {
  // speech 0–1.0 s, silence 1.0–2.3 s, speech 2.3–3.0 s; Whisper says "more." lasts until 2.5 and "Results" starts at 2.5
  const env = Array.from({ length: 320 }, (_, f) =>
    f < 100 || (f >= 230 && f < 300) ? -12 : -120,
  );
  const words = [
    { w: "nothing", s: 0.2, e: 0.6 },
    { w: "more.", s: 0.6, e: 2.5 },
    { w: "Results", s: 2.5, e: 2.9 },
  ];
  const r = refineOnsets(words, env);
  assert.equal(r[2]?.s, 2.3);
  assert.equal(r[1]?.e, 1.0, "previous word ends where the pause starts");
});
