/**
 * Integrity checks (P1a Q1a, D-QA-1): the only hard stops besides a redaction that leaks. They are about the
 * FILES, not the story: the render is missing a file it lists, has no picture or no (or silent) audio, or is
 * much shorter than the edit. None of these is a judgement call, so none can be confirmed: render again.
 */

import fs from "node:fs";
import path from "node:path";
import { ffprobe, run } from "../media/ffmpeg.ts";
import type { RenderRecord } from "../render/store.ts";
import type { QaItem } from "./types.ts";

/** Below this mean level (dBFS) the audio counts as silent. */
export const SILENT_DB = -55;
/** The video may be this much shorter than the edit's total before it counts as truncated (ms). */
export const TRUNCATED_MS = 3000;

/** Every project-relative file a variant lists (full, scenes, poster, transcripts, callouts). */
export function listedFiles(rec: RenderRecord): { variant: string; file: string }[] {
  const out: { variant: string; file: string }[] = [];
  for (const v of rec.variants) {
    const f = v.files as unknown as Record<string, string | string[] | undefined>;
    for (const value of Object.values(f)) {
      for (const rel of Array.isArray(value) ? value : value ? [value] : [])
        out.push({ variant: v.key, file: path.join(v.dir, rel) });
    }
  }
  return out;
}

export async function checkIntegrity(o: {
  projectDir: string;
  rec: RenderRecord;
  /** The video QA runs on. */
  full: string;
  /** The edit's total length (ms) the video should reach. */
  expectedMs: number;
  /** Does the edit have narration at all? A silent edit is allowed to have silent audio. */
  expectsAudio: boolean;
}): Promise<QaItem[]> {
  const hard = (message: string, extra: Partial<QaItem> = {}): QaItem => ({
    id: "",
    check: "media",
    level: "blocking",
    hard: "integrity",
    message,
    ...extra,
  });
  const items: QaItem[] = [];

  // a file the record lists that is gone or empty
  const missing = listedFiles(o.rec).filter(({ file }) => {
    const p = path.join(o.projectDir, file);
    return !fs.existsSync(p) || fs.statSync(p).size === 0;
  });
  if (missing.length)
    items.push(
      hard(
        `${missing.length} file${missing.length === 1 ? "" : "s"} the render lists ${missing.length === 1 ? "is" : "are"} missing or empty: ${missing
          .slice(0, 3)
          .map((m) => path.basename(m.file))
          .join(", ")}${missing.length > 3 ? ", …" : ""}`,
      ),
    );

  let probe: Awaited<ReturnType<typeof ffprobe>>;
  try {
    probe = await ffprobe(o.full);
  } catch (err) {
    items.push(
      hard(
        `the video cannot be read: ${(err as Error).message.split("\n")[0]?.slice(0, 120) ?? "ffprobe failed"}`,
      ),
    );
    return items;
  }
  if (!probe.streams.some((s) => s.codec_type === "video"))
    items.push(hard("the video file has no picture"));

  const durationMs = probe.duration * 1000;
  if (Number.isFinite(durationMs) && durationMs < o.expectedMs - TRUNCATED_MS)
    items.push(
      hard(
        `the video is ${((o.expectedMs - durationMs) / 1000).toFixed(1)} s shorter than the edit (${(durationMs / 1000).toFixed(1)} s of ${(o.expectedMs / 1000).toFixed(1)} s): the render is cut off`,
      ),
    );

  if (o.expectsAudio) {
    if (!probe.streams.some((s) => s.codec_type === "audio")) {
      items.push(hard("the video has no audio track, but the edit has narration"));
    } else {
      const r = await run("ffmpeg", [
        "-hide_banner",
        "-nostats",
        "-i",
        o.full,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ]);
      const mean = /mean_volume: (-?[\d.]+|-inf) dB/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
      if (mean === "-inf" || (mean !== undefined && Number(mean) < SILENT_DB))
        items.push(
          hard(
            `the audio is silent (mean level ${mean === "-inf" ? "−∞" : `${mean} dB`}), but the edit has narration`,
          ),
        );
    }
  }
  return items;
}
