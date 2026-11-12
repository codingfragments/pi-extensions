/**
 * The speed of this project's voice (item 22, D-R3-25-13): 155 words a minute is a guess until a voice has spoken; after the first synthesis the rate measured on its
 * sections (the aligned words over the audio's length) is used for the word budgets and the speech estimates of the project.
 */

import fs from "node:fs";
import { type VoiceManifest, audioDir, readManifest } from "../tts/synthesize.ts";

/** At least this much speech before a measurement replaces the default. */
export const MIN_MEASURED_SEC = 20;

export function rateOf(
  manifests: VoiceManifest[],
): { wordsPerSecond: number; seconds: number } | undefined {
  let words = 0;
  let seconds = 0;
  for (const m of manifests)
    for (const s of Object.values(m.sections)) {
      const n = s.alignment?.words?.length ?? 0;
      if (!n || !(s.durationSec > 0)) continue;
      words += n;
      seconds += s.durationSec;
    }
  if (seconds < MIN_MEASURED_SEC || !words) return undefined;
  const wps = words / seconds;
  // a voice slower than 90 or faster than 240 wpm is a broken measurement, not a voice
  return wps >= 1.5 && wps <= 4 ? { wordsPerSecond: wps, seconds } : undefined;
}

/** The newest voice's rate: the manifests of the voice used last (a project may change voices). */
export function measuredWordsPerSecond(
  projectDir: string,
): { wordsPerSecond: number; seconds: number } | undefined {
  const dir = audioDir(projectDir);
  if (!fs.existsSync(dir)) return undefined;
  const all = fs
    .readdirSync(dir)
    .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => !!v)
    .map(Number)
    .sort((a, b) => a - b)
    .map((v) => readManifest(projectDir, v))
    .filter((m): m is VoiceManifest => !!m);
  const last = all.at(-1);
  if (!last) return undefined;
  return rateOf(all.filter((m) => m.engine === last.engine && m.voice?.id === last.voice?.id));
}
