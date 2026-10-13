/**
 * Energy envelope + onset refinement for synthesized speech (S4, Q4).
 *
 * Whisper word timestamps drift EARLY after pauses (it absorbs part of the
 * preceding silence into the next word): measured −180…−300 ms in the S4
 * spike. TTS audio is clean, so the true onset is simply where energy rises:
 * after a pause, snap the word start to the first loud frame near Whisper's
 * estimate. Inside continuous speech Whisper's times are kept.
 */

import { spawn } from "node:child_process";

export const ENV_HZ = 100; // 10 ms frames

/** RMS envelope (dBFS per 10 ms frame) of any audio file, via ffmpeg. */
export function envelope(file: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`ffmpeg envelope failed: ${stderr.trim().split("\n").at(-1)}`));
      const pcm = Buffer.concat(chunks);
      const per = 16000 / ENV_HZ;
      const out: number[] = [];
      for (let f = 0; f * per * 2 + per * 2 <= pcm.length; f++) {
        let sum = 0;
        for (let i = 0; i < per; i++) {
          const v = pcm.readInt16LE((f * per + i) * 2) / 32768;
          sum += v * v;
        }
        out.push(10 * Math.log10(sum / per + 1e-12));
      }
      resolve(out);
    });
  });
}

export interface TimedWord {
  w: string;
  s: number;
  e: number;
}

/**
 * Refine word starts using the envelope. A word "follows a pause" when the
 * audio just before Whisper's start is quiet; then its start moves to the
 * first frame above `onDb` within [s − 0.15 s, s + 0.5 s].
 */
export function refineOnsets(
  words: TimedWord[],
  env: number[],
  opts: { onDb?: number; quietDb?: number } = {},
): TimedWord[] {
  const peak = Math.max(...env);
  const onDb = opts.onDb ?? peak - 32;
  const quietDb = opts.quietDb ?? peak - 42;
  const frame = (t: number) => Math.max(0, Math.min(env.length - 1, Math.round(t * ENV_HZ)));
  const out: TimedWord[] = [];
  words.forEach((word, i) => {
    const prevEnd = i > 0 ? (out[i - 1] as TimedWord).e : 0;
    // Look for a pause (≥ 120 ms quiet) between the previous word and well into
    // this one: Whisper sometimes swallows a whole pause into the next word.
    const from = frame(Math.max(prevEnd - 0.05, 0));
    const to = frame(Math.min(word.e - 0.05, word.s + 1.0));
    let quietRun = 0;
    let afterPause = -1;
    for (let f = from; f <= to; f++) {
      const loud = (env[f] as number) >= onDb;
      if ((env[f] as number) < quietDb) quietRun++;
      else if (loud) {
        if (quietRun >= 12 || (i === 0 && f === from)) {
          afterPause = f; // first loud frame AFTER the quiet stretch
          break;
        }
        quietRun = 0;
      }
    }
    if (afterPause < 0) {
      out.push(word);
      return;
    }
    const s = Math.min(afterPause / ENV_HZ, word.e - 0.05);
    // Only move forward past Whisper's estimate, or back by ≤ 150 ms.
    out.push(s >= word.s - 0.15 ? { ...word, s: +s.toFixed(3) } : word);
  });
  return out;
}

/**
 * Drop recognized words that sit in silence (Whisper hallucinations: repeats
 * of the prompt squeezed into the trailing quiet). A real word has at least a
 * few frames of energy within its span.
 */
export function dropSilentWords(
  words: TimedWord[],
  env: number[],
  opts: { onDb?: number } = {},
): TimedWord[] {
  const peak = Math.max(...env);
  const onDb = opts.onDb ?? peak - 32;
  return words.filter((w) => {
    const a = Math.max(0, Math.floor(w.s * ENV_HZ) - 2);
    const b = Math.min(env.length - 1, Math.ceil(w.e * ENV_HZ) + 2);
    let loud = 0;
    for (let f = a; f <= b; f++) if ((env[f] as number) >= onDb) loud++;
    return loud >= 3;
  });
}

/**
 * Anchors start a clause, so they normally follow a pause. If an anchor time
 * falls inside (or just before) a quiet stretch, snap it to the first onset
 * after that stretch (within +0.8 s). Safety net for mis-recognized words.
 */
export function snapToOnset(
  t: number,
  env: number[],
  opts: { onDb?: number; quietDb?: number } = {},
): number {
  const peak = Math.max(...env);
  const onDb = opts.onDb ?? peak - 32;
  const quietDb = opts.quietDb ?? peak - 42;
  const f0 = Math.max(0, Math.round(t * ENV_HZ));
  if ((env[f0] as number) >= onDb) return t; // already in speech
  let quiet = 0;
  for (let f = Math.max(0, f0 - 15); f <= Math.min(env.length - 1, f0 + 80); f++) {
    if ((env[f] as number) < quietDb) quiet++;
    else if ((env[f] as number) >= onDb) {
      if (quiet >= 12 && f >= f0) return +(f / ENV_HZ).toFixed(3);
      if (f >= f0) return t;
      quiet = 0;
    }
  }
  return t;
}
