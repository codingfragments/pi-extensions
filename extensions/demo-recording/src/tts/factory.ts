/**
 * Build the TTS engine chain from config + environment + the brief.
 * Voice name precedence: the brief's "Voice:" field → config `voiceName`.
 */

import type { DemoRecConfig } from "../config.ts";
import { hasBinary } from "../media/ffmpeg.ts";
import { type FetchLike, type TtsEngine, elevenLabs, kokoro, openAi, say } from "./engines.ts";

/** Voice name from brief.md (`- **Voice:** Stefan v2`), ignoring placeholders. */
export function briefVoice(brief: string): string | undefined {
  const v = /\*\*Voice:?\*\*:?\s*(.+)/i.exec(brief)?.[1]?.trim().replace(/^_|_$/g, "");
  if (!v || /todo|default|^-+$/i.test(v)) return undefined;
  return v;
}

export function buildEngines(
  cfg: DemoRecConfig,
  opts: {
    env?: NodeJS.ProcessEnv;
    brief?: string;
    fetch?: FetchLike;
    uvAvailable?: () => boolean;
  } = {},
): TtsEngine[] {
  const env = opts.env ?? process.env;
  const voiceName = (opts.brief ? briefVoice(opts.brief) : undefined) ?? cfg.voiceName;
  const uv = opts.uvAvailable ?? (() => hasBinary("uv"));
  const all: Record<string, TtsEngine> = {
    elevenlabs: elevenLabs({
      ...(env.ELEVENLABS_API_KEY ? { apiKey: env.ELEVENLABS_API_KEY } : {}),
      voiceName,
      model: cfg.tts.elevenlabs.model,
      fallbackModel: cfg.tts.elevenlabs.fallbackModel,
      ...(cfg.tts.elevenlabs.stability !== undefined
        ? { stability: cfg.tts.elevenlabs.stability }
        : {}),
      ...(cfg.tts.elevenlabs.similarity !== undefined
        ? { similarity: cfg.tts.elevenlabs.similarity }
        : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }),
    openai: openAi({
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
      model: cfg.tts.openai.model,
      voice: cfg.tts.openai.voice,
      instructions: cfg.tts.openai.instructions,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }),
    kokoro: kokoro({ voice: cfg.tts.kokoro.voice, uvAvailable: uv }),
    say: say(cfg.tts.say.voice ? { voice: cfg.tts.say.voice } : {}),
  };
  return cfg.ttsChain.map((id) => all[id] as TtsEngine);
}
