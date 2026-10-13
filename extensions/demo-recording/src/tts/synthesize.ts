/**
 * Render the approved voice-over to audio (S4, D12).
 *
 * - One engine for the WHOLE voice-over: the first healthy one in the chain.
 *   If it fails mid-way with a provider-level error (quota, 5xx, auth), the
 *   render restarts from scratch with the next engine — never mixing voices.
 * - Content-hash cache: unchanged sections reuse their audio (re-renders after
 *   text edits only pay for what changed).
 * - Every section gets word timings mapped onto the SCRIPT words, and the
 *   start time of each [@mark] anchor (input for the sync editor).
 *
 *   vo/audio/cache/<sha>.wav|.json     vo/audio/v<N>.json (manifest)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type SectionAlignment, fromCharAlignment, fromTranscript } from "../align/align.ts";
import {
  type TimedWord,
  dropSilentWords,
  envelope,
  refineOnsets,
  snapToOnset,
} from "../align/onset.ts";
import { run } from "../media/ffmpeg.ts";
import type { VoSection } from "../vo/script.ts";
import { writeFileAtomic } from "../workdir/versioning.ts";
import { type EngineHealth, EngineUnavailable, type TtsEngine } from "./engines.ts";

const PY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "py");

export interface SectionAudio {
  key: string;
  /** Path relative to the project dir. */
  file: string;
  durationSec: number;
  chars: number;
  cached: boolean;
  alignment: SectionAlignment;
  /** Provider model used for this section (e.g. eleven_v4). */
  model?: string;
}

export interface VoiceManifest {
  schema: 1;
  voVersion: number;
  take: string;
  engine: string;
  voice: { id: string; name: string };
  /** Provider model(s) used across sections (one expected). */
  models: string[];
  /** Model fallbacks that happened during this render. */
  modelFallbacks: { section: string; from: string; to: string; reason: string }[];
  createdAt: string;
  skipped: { engine: string; reason: string }[];
  sections: Record<string, SectionAudio>;
  totalSec: number;
  /** Characters actually sent to the provider in this render (cache misses). */
  billedChars: number;
}

export interface RenderOptions {
  projectDir: string;
  voVersion: number;
  take: string;
  sections: VoSection[];
  engines: TtsEngine[];
  /** Whisper model for engines without provider timings. */
  alignModel?: string;
  signal?: AbortSignal;
  onProgress?: (p: {
    done: number;
    total: number;
    section: string;
    engine: string;
    cached: boolean;
  }) => void;
  /** Override for tests: transcribe audio → words. */
  transcribe?: (wav: string, text: string) => Promise<TimedWord[]>;
}

export const audioDir = (projectDir: string) => path.join(projectDir, "vo", "audio");
export const manifestFile = (projectDir: string, voVersion: number) =>
  path.join(audioDir(projectDir), `v${voVersion}.json`);

export function readManifest(projectDir: string, voVersion: number): VoiceManifest | undefined {
  const f = manifestFile(projectDir, voVersion);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as VoiceManifest) : undefined;
}

/** The model segment of an engine identity ("elevenlabs:<voice>:<model>:…", "openai:<model>:…", "kokoro:<model>:…"). */
export function modelFromIdentity(identity: string): string | undefined {
  const [engine, a, b] = identity.split(":");
  if (engine === "elevenlabs") return b;
  if (engine === "openai" || engine === "kokoro") return a;
  return undefined;
}

export function cacheKey(identity: string, text: string): string {
  return crypto.createHash("sha256").update(`${identity}\n${text}`).digest("hex").slice(0, 24);
}

/** Whisper word timings via py/align.py (uv). */
export async function whisperWords(
  wav: string,
  text: string,
  model = "base.en",
): Promise<TimedWord[]> {
  const prompt = `${wav}.prompt.txt`;
  fs.writeFileSync(prompt, text);
  try {
    const { stdout } = await run("uv", [
      "run",
      "--quiet",
      path.join(PY_DIR, "align.py"),
      "--audio",
      wav,
      "--model",
      model,
      "--prompt-file",
      prompt,
    ]);
    const json = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { words?: TimedWord[] };
    return json.words ?? [];
  } finally {
    fs.rmSync(prompt, { force: true });
  }
}

/** First healthy engine in chain order (with reasons for the skipped ones). */
export async function selectEngine(
  engines: TtsEngine[],
  signal?: AbortSignal,
): Promise<{
  engine: TtsEngine;
  health: EngineHealth;
  skipped: { engine: string; reason: string }[];
}> {
  const skipped: { engine: string; reason: string }[] = [];
  for (const engine of engines) {
    const health = await engine.health(signal);
    if (health.ok && health.voice) return { engine, health, skipped };
    skipped.push({ engine: engine.id, reason: health.reason });
  }
  throw new Error(
    `no TTS engine is available:\n${skipped.map((s) => `- ${s.engine}: ${s.reason}`).join("\n")}`,
  );
}

async function renderWith(
  engine: TtsEngine,
  voice: { id: string; name: string },
  o: RenderOptions,
): Promise<Omit<VoiceManifest, "skipped">> {
  const cache = path.join(audioDir(o.projectDir), "cache");
  fs.mkdirSync(cache, { recursive: true });
  const spoken = o.sections.filter((s) => s.body.trim());
  const sections: Record<string, SectionAudio> = {};
  const fallbacks: VoiceManifest["modelFallbacks"] = [];
  let billedChars = 0;
  for (const [i, section] of spoken.entries()) {
    if (o.signal?.aborted) throw new Error("voice synthesis cancelled");
    const text = section.segments
      .map((s) => s.text)
      .join(" ")
      .trim();
    const identity = engine.identity(voice.id);
    const key = cacheKey(identity, text);
    let wav = path.join(cache, `${key}.wav`);
    let meta = path.join(cache, `${key}.json`);
    let model: string | undefined;
    let cached = fs.existsSync(wav) && fs.existsSync(meta);
    let alignment: SectionAlignment | undefined;
    let durationSec = 0;
    if (cached) {
      const m = JSON.parse(fs.readFileSync(meta, "utf8")) as {
        alignment: SectionAlignment;
        durationSec: number;
        model?: string;
      };
      ({ alignment, durationSec } = m);
      model = m.model ?? modelFromIdentity(identity);
      // Anchors are re-derived from the current segments (cache key is text-only).
      if (Object.keys(alignment.anchors).length !== section.segments.filter((s) => s.anchor).length)
        cached = false;
    }
    if (!cached) {
      const tmp = `${wav}.${process.pid}.tmp.wav`;
      const res = await engine.synthesize(text, tmp, voice.id, o.signal);
      durationSec = res.durationSec;
      model = res.model ?? modelFromIdentity(identity);
      if (res.fallback) fallbacks.push({ section: section.key, ...res.fallback });
      // A model fallback changes the engine identity: store under the identity actually used.
      const usedKey = cacheKey(engine.identity(voice.id), text);
      if (usedKey !== key) {
        wav = path.join(cache, `${usedKey}.wav`);
        meta = path.join(cache, `${usedKey}.json`);
      }
      billedChars += text.length;
      if (res.chars) {
        alignment = fromCharAlignment(
          section.segments,
          text,
          res.chars.chars,
          res.chars.starts,
          res.chars.ends,
          durationSec,
        );
      } else {
        const words = await (o.transcribe ?? ((w, t) => whisperWords(w, t, o.alignModel)))(
          tmp,
          text,
        );
        const env = await envelope(tmp);
        const refined = refineOnsets(dropSilentWords(words, env), env);
        alignment = fromTranscript(section.segments, refined, durationSec);
        for (const [mark, t] of Object.entries(alignment.anchors))
          alignment.anchors[mark] = snapToOnset(t, env);
      }
      fs.renameSync(tmp, wav);
      fs.writeFileSync(
        meta,
        JSON.stringify({
          alignment,
          durationSec,
          text,
          engine: engine.id,
          voice,
          model,
          identity: engine.identity(voice.id),
        }),
      );
    }
    sections[section.key] = {
      key: section.key,
      file: path.relative(o.projectDir, wav),
      durationSec: +(durationSec as number).toFixed(3),
      chars: text.length,
      cached,
      alignment: alignment as SectionAlignment,
      ...(model ? { model } : {}),
    };
    o.onProgress?.({
      done: i + 1,
      total: spoken.length,
      section: section.key,
      engine: engine.id,
      cached,
    });
  }
  const totalSec = +Object.values(sections)
    .reduce((n, s) => n + s.durationSec, 0)
    .toFixed(2);
  return {
    schema: 1,
    voVersion: o.voVersion,
    take: o.take,
    engine: engine.id,
    voice,
    models: [
      ...new Set(
        Object.values(sections)
          .map((x) => x.model)
          .filter((x): x is string => !!x),
      ),
    ],
    modelFallbacks: fallbacks,
    createdAt: new Date().toISOString(),
    sections,
    totalSec,
    billedChars,
  };
}

export async function renderVoice(o: RenderOptions): Promise<VoiceManifest> {
  let remaining = [...o.engines];
  const skipped: { engine: string; reason: string }[] = [];
  for (;;) {
    const pick = await selectEngine(remaining, o.signal).catch((err: Error) => {
      throw new Error(
        `${err.message}${skipped.length ? `\n(also failed during synthesis: ${skipped.map((s) => `${s.engine}: ${s.reason}`).join("; ")})` : ""}`,
      );
    });
    skipped.push(...pick.skipped);
    try {
      const m = await renderWith(pick.engine, pick.health.voice as { id: string; name: string }, o);
      const manifest: VoiceManifest = { ...m, skipped };
      writeFileAtomic(
        manifestFile(o.projectDir, o.voVersion),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      return manifest;
    } catch (err) {
      if (!(err instanceof EngineUnavailable)) throw err;
      // Provider-level failure: restart the WHOLE voice-over with the next engine.
      skipped.push({ engine: pick.engine.id, reason: err.message });
      remaining = remaining.slice(remaining.indexOf(pick.engine) + 1);
    }
  }
}
