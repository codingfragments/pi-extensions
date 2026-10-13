/**
 * macOS `say` TTS — dev/CI engine only (D12: smoke tests, never production).
 * S4 wraps this behind the provider interface with word timestamps via the
 * whisper alignment pass.
 */

import fs from "node:fs";
import path from "node:path";
import { ffprobe, run } from "../media/ffmpeg.ts";

export interface SayOptions {
  voice?: string;
  /** Words per minute (say default ≈ 175). */
  rate?: number;
}

export function sayAvailable(): boolean {
  return process.platform === "darwin" && fs.existsSync("/usr/bin/say");
}

/** Synthesize `text` to a 44.1 kHz 16-bit mono WAV. Returns the audio duration in seconds. */
export async function sayToWav(text: string, out: string, opts: SayOptions = {}): Promise<number> {
  if (!sayAvailable()) throw new Error("macOS `say` is not available on this platform");
  if (!text.trim()) throw new Error("say: empty text");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ["--file-format=WAVE", "--data-format=LEI16@44100", "-o", out];
  if (opts.voice) args.push("-v", opts.voice);
  if (opts.rate) args.push("-r", String(opts.rate));
  // Pass the text via a file so arbitrary punctuation/quotes are safe.
  const textFile = `${out}.txt`;
  fs.writeFileSync(textFile, text);
  args.push("-f", textFile);
  await run("say", args);
  return (await ffprobe(out)).duration;
}
