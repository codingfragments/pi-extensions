/**
 * TTS engines (D12). Each writes a WAV for one section and may return
 * character timings (ElevenLabs). Keys come from the environment only.
 *
 *   elevenlabs  ELEVENLABS_API_KEY, custom voice BY NAME, /with-timestamps
 *   openai      OPENAI_API_KEY, gpt-4o-mini-tts with tone instructions
 *   kokoro      local (uv + kokoro-onnx), offline
 *   say         macOS, dev/CI only
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, ffprobe, run } from "../media/ffmpeg.ts";
import { sayAvailable, sayToWav } from "./say.ts";

export type EngineId = "elevenlabs" | "openai" | "kokoro" | "say";

export interface EngineHealth {
  ok: boolean;
  reason: string;
  /** Resolved voice (id + display name). */
  voice?: { id: string; name: string };
}

export interface SynthResult {
  durationSec: number;
  /** Model actually used (provider engines), e.g. eleven_v4. */
  model?: string;
  /** Set when the engine had to fall back from the configured model. */
  fallback?: { from: string; to: string; reason: string };
  /** Provider character timings over the given text (ElevenLabs). */
  chars?: { chars: string[]; starts: number[]; ends: number[] };
}

export interface TtsEngine {
  id: EngineId;
  /** Cheap readiness check: keys present, voice resolvable, binaries present. */
  health(signal?: AbortSignal): Promise<EngineHealth>;
  /** Stable identity for caching (engine + voice + model + settings). */
  identity(voiceId: string): string;
  synthesize(
    text: string,
    outWav: string,
    voiceId: string,
    signal?: AbortSignal,
  ): Promise<SynthResult>;
}

/** HTTP errors that should make the chain fall back to the next engine. */
export class EngineUnavailable extends Error {}

/** 401 on the voice listing (kept separate so a voice-id fallback can apply). */
export class VoicesUnauthorized extends EngineUnavailable {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.detail = detail;
  }
}

const PY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "py");

/** Normalize any audio to 48 kHz mono PCM WAV (editor input format). */
async function toWav(input: string, out: string): Promise<number> {
  await ffmpeg(["-i", input, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
  return (await ffprobe(out)).duration;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

// ---------------- ElevenLabs ----------------

/** ElevenLabs' own error explanation: {"detail": {"status": "...", "message": "..."}} or {"detail": "..."}. */
export async function elevenLabsDetail(res: { text(): Promise<string> }): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw) as { detail?: string | { status?: string; message?: string } };
    if (typeof j.detail === "string") return j.detail;
    if (j.detail) return [j.detail.status, j.detail.message].filter(Boolean).join(": ");
    return ""; // JSON without a detail: nothing useful to add
  } catch {
    // not JSON
  }
  return raw.slice(0, 200);
}

/** Hint for the common 401 causes. */
export function elevenLabsAuthHint(detail: string): string {
  if (/missing_permissions|permission/i.test(detail)) {
    return " — the key is restricted: enable 'Voices: Read' (and 'Text to Speech') for it in ElevenLabs → API keys, or set voiceName to the voice ID";
  }
  if (/invalid_api_key|invalid api key/i.test(detail)) {
    return " — the key is wrong or revoked: copy it again (no quotes/whitespace), export it, and restart pi";
  }
  return "";
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  /** cloned | professional | generated | premade | … */
  category?: string;
  labels?: Record<string, string>;
}

/** All voices in the account (needs the key's "Voices: Read" permission). */
export async function listElevenLabsVoices(o: {
  apiKey?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<ElevenLabsVoice[]> {
  if (!o.apiKey) throw new EngineUnavailable("ELEVENLABS_API_KEY is not set");
  const http = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const res = await http(`${o.baseUrl ?? "https://api.elevenlabs.io"}/v1/voices`, {
    headers: { "xi-api-key": o.apiKey, "content-type": "application/json" },
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (res.status === 401) {
    const detail = await elevenLabsDetail(res);
    throw new VoicesUnauthorized(
      `ElevenLabs rejected the API key (401${detail ? `: ${detail}` : ""})${elevenLabsAuthHint(detail)}`,
      detail,
    );
  }
  if (!res.ok)
    throw new EngineUnavailable(
      `ElevenLabs /v1/voices failed (${res.status}: ${await elevenLabsDetail(res)})`,
    );
  return ((await res.json()) as { voices: ElevenLabsVoice[] }).voices;
}

/** Your own voices first (cloned/professional/generated), then the library; alphabetical within. */
export function sortVoices(voices: ElevenLabsVoice[]): ElevenLabsVoice[] {
  const own = (v: ElevenLabsVoice) => (v.category && v.category !== "premade" ? 0 : 1);
  return [...voices].sort((a, b) => own(a) - own(b) || a.name.localeCompare(b.name));
}

/** ElevenLabs voice IDs are 20 alphanumeric characters. */
export const looksLikeVoiceId = (s: string) => /^[A-Za-z0-9]{20}$/.test(s.trim());

export interface ElevenLabsOptions {
  apiKey?: string;
  voiceName: string;
  model: string;
  /** Used when the account rejects `model` on the timestamp endpoint. */
  fallbackModel: string;
  stability?: number;
  similarity?: number;
  fetch?: FetchLike;
  baseUrl?: string;
}

export function elevenLabs(o: ElevenLabsOptions): TtsEngine {
  const http = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = o.baseUrl ?? "https://api.elevenlabs.io";
  let model = o.model;
  let voices: ElevenLabsVoice[] | undefined;
  const headers = () => ({ "xi-api-key": o.apiKey ?? "", "content-type": "application/json" });

  const listVoices = async (signal?: AbortSignal) => {
    if (voices) return voices;
    voices = await listElevenLabsVoices({
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
      fetch: http,
      baseUrl: base,
      ...(signal ? { signal } : {}),
    });
    return voices;
  };

  return {
    id: "elevenlabs",
    async health(signal) {
      if (!o.apiKey) return { ok: false, reason: "ELEVENLABS_API_KEY is not set" };
      if (!o.voiceName)
        return {
          ok: false,
          reason: "no voice name configured (voiceName in config or the brief's Voice field)",
        };
      try {
        const all = await listVoices(signal);
        const want = o.voiceName.trim().toLowerCase();
        const voice =
          all.find((v) => v.name.toLowerCase() === want) ??
          all.find((v) => v.name.toLowerCase().startsWith(want)) ??
          all.find((v) => v.voice_id === o.voiceName);
        if (!voice) {
          const names = all
            .map((v) => v.name)
            .slice(0, 12)
            .join(", ");
          return {
            ok: false,
            reason: `voice "${o.voiceName}" not found in your ElevenLabs voices (${names}${all.length > 12 ? ", …" : ""})`,
          };
        }
        return {
          ok: true,
          reason: `voice "${voice.name}"`,
          voice: { id: voice.voice_id, name: voice.name },
        };
      } catch (err) {
        // A key restricted to text-to-speech can't list voices: a voice ID still works.
        if (
          err instanceof VoicesUnauthorized &&
          /permission/i.test(err.detail) &&
          looksLikeVoiceId(o.voiceName)
        ) {
          const id = o.voiceName.trim();
          return {
            ok: true,
            reason: `voice id ${id} (key can't list voices; using the id directly)`,
            voice: { id, name: id },
          };
        }
        return { ok: false, reason: (err as Error).message };
      }
    },
    identity: (voiceId) =>
      `elevenlabs:${voiceId}:${model}:${o.stability ?? "d"}:${o.similarity ?? "d"}`,
    async synthesize(text, outWav, voiceId, signal) {
      const call = async (m: string) =>
        http(
          `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              text,
              model_id: m,
              ...(o.stability !== undefined || o.similarity !== undefined
                ? {
                    voice_settings: {
                      ...(o.stability !== undefined ? { stability: o.stability } : {}),
                      ...(o.similarity !== undefined ? { similarity_boost: o.similarity } : {}),
                    },
                  }
                : {}),
            }),
            ...(signal ? { signal } : {}),
          },
        );
      let fallback: SynthResult["fallback"];
      let res = await call(model);
      if (res.status === 400 || res.status === 422) {
        const detail = await res.text();
        if (/model/i.test(detail) && model !== o.fallbackModel) {
          fallback = { from: model, to: o.fallbackModel, reason: detail.slice(0, 160) };
          model = o.fallbackModel; // account/model mismatch: same voice, older model
          res = await call(model);
        } else
          throw new Error(
            `ElevenLabs TTS rejected the request (${res.status}): ${detail.slice(0, 200)}`,
          );
      }
      if (res.status === 401 || res.status === 402 || res.status === 429 || res.status >= 500) {
        const detail = await elevenLabsDetail(res);
        throw new EngineUnavailable(
          `ElevenLabs TTS failed (${res.status}${res.status === 429 ? ", rate limit or quota" : res.status === 402 ? ", quota" : ""}${detail ? `: ${detail}` : ""})${res.status === 401 ? elevenLabsAuthHint(detail) : ""}`,
        );
      }
      if (!res.ok)
        throw new Error(`ElevenLabs TTS failed (${res.status}): ${await elevenLabsDetail(res)}`);
      const body = (await res.json()) as {
        audio_base64: string;
        alignment?: {
          characters: string[];
          character_start_times_seconds: number[];
          character_end_times_seconds: number[];
        };
      };
      const mp3 = `${outWav}.mp3`;
      fs.writeFileSync(mp3, Buffer.from(body.audio_base64, "base64"));
      const durationSec = await toWav(mp3, outWav);
      fs.rmSync(mp3, { force: true });
      const a = body.alignment;
      return {
        durationSec,
        model,
        ...(fallback ? { fallback } : {}),
        ...(a
          ? {
              chars: {
                chars: a.characters,
                starts: a.character_start_times_seconds,
                ends: a.character_end_times_seconds,
              },
            }
          : {}),
      };
    },
  };
}

// ---------------- OpenAI ----------------

export interface OpenAiOptions {
  apiKey?: string;
  model: string;
  voice: string;
  /** Tone/delivery instructions (gpt-4o-mini-tts). */
  instructions?: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export function openAi(o: OpenAiOptions): TtsEngine {
  const http = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = o.baseUrl ?? "https://api.openai.com";
  return {
    id: "openai",
    async health() {
      if (!o.apiKey) return { ok: false, reason: "OPENAI_API_KEY is not set" };
      return {
        ok: true,
        reason: `${o.model} voice "${o.voice}"`,
        voice: { id: o.voice, name: o.voice },
      };
    },
    identity: (voiceId) => `openai:${o.model}:${voiceId}:${o.instructions ?? ""}`,
    async synthesize(text, outWav, voiceId, signal) {
      const res = await http(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: o.model,
          voice: voiceId,
          input: text,
          response_format: "wav",
          ...(o.instructions ? { instructions: o.instructions } : {}),
        }),
        ...(signal ? { signal } : {}),
      });
      if (res.status === 401 || res.status === 429 || res.status >= 500)
        throw new EngineUnavailable(`OpenAI TTS failed (${res.status})`);
      if (!res.ok)
        throw new Error(`OpenAI TTS failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const raw = `${outWav}.src.wav`;
      fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
      const durationSec = await toWav(raw, outWav);
      fs.rmSync(raw, { force: true });
      return { durationSec, model: o.model };
    },
  };
}

// ---------------- Kokoro (local) ----------------

export function kokoro(o: { voice: string; uvAvailable: () => boolean }): TtsEngine {
  return {
    id: "kokoro",
    async health() {
      if (!o.uvAvailable()) return { ok: false, reason: "uv is not installed (brew install uv)" };
      return {
        ok: true,
        reason: `local voice "${o.voice}"`,
        voice: { id: o.voice, name: o.voice },
      };
    },
    identity: (voiceId) => `kokoro:v1.0-int8:${voiceId}`,
    async synthesize(text, outWav, voiceId) {
      const textFile = `${outWav}.txt`;
      fs.writeFileSync(textFile, text);
      const raw = `${outWav}.src.wav`;
      await run("uv", [
        "run",
        "--quiet",
        path.join(PY_DIR, "kokoro_tts.py"),
        "--text-file",
        textFile,
        "--out",
        raw,
        "--voice",
        voiceId,
      ]);
      const durationSec = await toWav(raw, outWav);
      fs.rmSync(raw, { force: true });
      fs.rmSync(textFile, { force: true });
      return { durationSec };
    },
  };
}

// ---------------- say (dev) ----------------

export function say(o: { voice?: string }): TtsEngine {
  return {
    id: "say",
    async health() {
      return sayAvailable()
        ? {
            ok: true,
            reason: "macOS say (dev only)",
            voice: { id: o.voice ?? "default", name: o.voice ?? "default" },
          }
        : { ok: false, reason: "macOS say not available" };
    },
    identity: (voiceId) => `say:${voiceId}`,
    async synthesize(text, outWav, voiceId) {
      const raw = `${outWav}.src.wav`;
      await sayToWav(text, raw, voiceId !== "default" ? { voice: voiceId } : {});
      const durationSec = await toWav(raw, outWav);
      fs.rmSync(raw, { force: true });
      fs.rmSync(`${raw}.txt`, { force: true });
      return { durationSec };
    },
  };
}
