/**
 * The voices of the user's ElevenLabs account, for the panel's pickers (UX17, D131).
 *
 *   GET /api/voices[?refresh=1]
 *       → { available: true, voices: [{ id, name, category, own }], at }   (yours first)
 *       → { available: false, reason }   no key, a key that may not read voices, or no network: told as data,
 *                                        so the picker falls back to a text field instead of failing.
 *
 * Read-only and free (no credits). The key is read from the environment here and never leaves the server: it is not
 * in the reply, the log or the cache (only a digest of it, to know the cache belongs to this key).
 */

import { createHash } from "node:crypto";
import {
  type ElevenLabsVoice,
  type FetchLike,
  listElevenLabsVoices,
  sortVoices,
} from "../tts/engines.ts";
import type { GetRoute } from "./server.ts";

export interface VoiceListDeps {
  apiKey: () => string | undefined;
  /** Test seam. */
  fetch?: FetchLike;
  now?: () => number;
}

export interface PickerVoice {
  id: string;
  name: string;
  category: string;
  /** Yours (cloned, professional, generated), as opposed to the library. */
  own: boolean;
}

export const VOICES_TTL_MS = 5 * 60_000;

export function voiceListRoutes(deps: VoiceListDeps): { get: Record<string, GetRoute> } {
  let cache: { digest: string; at: number; voices: PickerVoice[] } | undefined;
  const now = deps.now ?? Date.now;
  return {
    get: {
      voices: async (q) => {
        const key = deps.apiKey()?.trim();
        if (!key) return { available: false, reason: "ELEVENLABS_API_KEY is not set" };
        const digest = createHash("sha1").update(key).digest("hex");
        if (
          cache &&
          cache.digest === digest &&
          now() - cache.at < VOICES_TTL_MS &&
          q.get("refresh") !== "1"
        )
          return { available: true, voices: cache.voices, at: cache.at };
        try {
          const list: ElevenLabsVoice[] = sortVoices(
            await listElevenLabsVoices({
              apiKey: key,
              ...(deps.fetch ? { fetch: deps.fetch } : {}),
            }),
          );
          const voices = list.map((v) => ({
            id: v.voice_id,
            name: v.name,
            category: v.category ?? "",
            own: !!v.category && v.category !== "premade",
          }));
          cache = { digest, at: now(), voices };
          return { available: true, voices, at: cache.at };
        } catch (e) {
          const message = (e as Error).message ?? String(e);
          // never let the key travel in a message
          return { available: false, reason: message.split(key).join("…") };
        }
      },
    },
  };
}
