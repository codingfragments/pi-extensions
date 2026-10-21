/**
 * CDP screencast capture (D2) → JPEG frames + frames.jsonl, then a CFR master
 * via the ffmpeg concat demuxer with exact per-frame durations.
 *
 * Clock: frame `metadata.timestamp` is wall-clock epoch seconds (measured
 * within ~15 ms of Node's Date.now() in the S1 spike), so frames and engine
 * events share one time base: `t = epochMs - t0`. Video time 0 == t0.
 *
 * Chrome only emits frames on screen damage; a static screen produces none.
 * Durations are therefore derived from the next frame's timestamp, which makes
 * static stretches cost nothing while preserving exact timing.
 */

import fs from "node:fs";
import path from "node:path";
import type { CDPSession } from "playwright";
import { ffmpeg } from "../../media/ffmpeg.ts";

export interface FrameRecord {
  index: number;
  file: string;
  /** Epoch ms (from CDP metadata, falling back to receive time). */
  ts: number;
  bytes: number;
}

export interface CaptureStats {
  frames: number;
  durationMs: number;
  avgFps: number;
  /** Max inter-frame gap while frames were flowing (ms). */
  maxGapMs: number;
  /** p95 inter-frame gap (ms). */
  p95GapMs: number;
  totalBytes: number;
  avgFrameKB: number;
  width?: number;
  height?: number;
  /** Browser-vs-node clock skew samples (ms, receive - frame timestamp). */
  clockSkewMs: { min: number; max: number };
}

export interface CaptureResult {
  t0: number;
  endTs: number;
  frames: FrameRecord[];
  stats: CaptureStats;
}

export interface ScreencastOptions {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** File name prefix (one per take segment so resumed segments never collide). */
  prefix?: string;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
}

function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1] ?? 0;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return undefined;
}

export class Screencast {
  private readonly cdp: CDPSession;
  private readonly dir: string;
  private readonly opts: ScreencastOptions;
  private frames: FrameRecord[] = [];
  private writes: Promise<void>[] = [];
  private skew: number[] = [];
  private size: { width: number; height: number } | undefined;

  /** JPEG frame size of the first frame (device pixels). */
  get frameSize(): { width: number; height: number } | undefined {
    return this.size;
  }
  private t0 = 0;
  private running = false;
  private readonly onFrame = (event: ScreencastFrameEvent) => this.handle(event);

  constructor(cdp: CDPSession, framesDir: string, opts: ScreencastOptions = {}) {
    this.cdp = cdp;
    this.dir = framesDir;
    this.opts = opts;
  }

  private handle(event: ScreencastFrameEvent): void {
    // Ack first: Chrome withholds the next frame until the previous one is acked.
    this.cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    if (!this.running) return;
    const received = Date.now();
    const ts = event.metadata.timestamp ? event.metadata.timestamp * 1000 : received;
    if (event.metadata.timestamp) this.skew.push(received - ts);
    const index = this.frames.length + 1;
    const file = `${this.opts.prefix ?? ""}${String(index).padStart(6, "0")}.jpg`;
    const buf = Buffer.from(event.data, "base64");
    if (!this.size) this.size = jpegSize(buf);
    this.frames.push({ index, file, ts, bytes: buf.length });
    this.writes.push(fs.promises.writeFile(path.join(this.dir, file), buf));
  }

  /** Start capturing; returns t0 (epoch ms) — the take's time origin. */
  async start(): Promise<number> {
    fs.mkdirSync(this.dir, { recursive: true });
    this.cdp.on("Page.screencastFrame", this.onFrame);
    this.running = true;
    this.t0 = Date.now();
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.opts.quality ?? 92,
      everyNthFrame: 1,
      ...(this.opts.maxWidth ? { maxWidth: this.opts.maxWidth } : {}),
      ...(this.opts.maxHeight ? { maxHeight: this.opts.maxHeight } : {}),
    });
    return this.t0;
  }

  /** The newest frame file written so far (for the diagnosis of a stalled step). */
  lastFrameFile(): string | undefined {
    return this.frames.at(-1)?.file;
  }

  /** `bounded`: a browser that does not answer must not hold the stop (and with it the whole take) for ever. */
  async stop(bounded = true): Promise<CaptureResult> {
    const endTs = Date.now();
    this.running = false;
    const limit = <T>(p: Promise<T>) =>
      bounded ? Promise.race([p, new Promise<void>((r) => setTimeout(r, 5000))]) : p;
    await limit(this.cdp.send("Page.stopScreencast").catch(() => {}));
    this.cdp.off("Page.screencastFrame", this.onFrame);
    await limit(Promise.all(this.writes));
    // Frames can arrive marginally out of order; keep them sorted by timestamp.
    const frames = this.frames.filter((f) => f.ts <= endTs + 50).sort((a, b) => a.ts - b.ts);
    if (frames.length === 0) throw new Error("screencast produced no frames");
    // frames.jsonl is written by the runner (it merges resumed segments).
    return {
      t0: this.t0,
      endTs,
      frames,
      stats: computeStats(frames, this.t0, endTs, this.skew, this.size),
    };
  }
}

export function computeStats(
  frames: FrameRecord[],
  t0: number,
  endTs: number,
  skew: number[] = [],
  size?: { width: number; height: number },
): CaptureStats {
  const gaps = frames.slice(1).map((f, i) => f.ts - (frames[i] as FrameRecord).ts);
  const sorted = [...gaps].sort((a, b) => a - b);
  const totalBytes = frames.reduce((n, f) => n + f.bytes, 0);
  const durationMs = endTs - t0;
  return {
    frames: frames.length,
    durationMs,
    avgFps: +(frames.length / (durationMs / 1000)).toFixed(1),
    maxGapMs: Math.round(sorted.at(-1) ?? 0),
    p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    totalBytes,
    avgFrameKB: Math.round(totalBytes / frames.length / 1024),
    ...(size ?? {}),
    clockSkewMs: skew.length
      ? { min: Math.round(Math.min(...skew)), max: Math.round(Math.max(...skew)) }
      : { min: 0, max: 0 },
  };
}

export interface CfrRun {
  file: string;
  /** Number of consecutive output frames showing this source frame. */
  count: number;
}

/**
 * Map VFR source frames onto a CFR timeline, exact by construction:
 * output frame k (time t0 + k/fps) shows the latest source frame with
 * ts ≤ t0 + k/fps (the first source frame before any has arrived).
 * Consecutive repeats are run-length encoded. Total = floor((endTs-t0)·fps/1000).
 */
export function cfrSchedule(
  frames: Pick<FrameRecord, "file" | "ts">[],
  t0: number,
  endTs: number,
  fps: number,
): CfrRun[] {
  if (!frames.length) throw new Error("no frames");
  const total = Math.max(1, Math.floor(((endTs - t0) * fps) / 1000));
  const runs: CfrRun[] = [];
  let src = 0;
  for (let k = 0; k < total; k++) {
    const t = t0 + (k * 1000) / fps;
    while (src + 1 < frames.length && (frames[src + 1] as { ts: number }).ts <= t) src++;
    const file = (frames[src] as { file: string }).file;
    const last = runs.at(-1);
    if (last && last.file === file) last.count++;
    else runs.push({ file, count: 1 });
  }
  return runs;
}

const quote = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;

/** ffconcat script for a CFR schedule (durations are exact multiples of 1/fps). */
export function buildConcatScript(runs: CfrRun[], fps: number): string {
  const lines = ["ffconcat version 1.0"];
  for (const r of runs)
    lines.push(`file ${quote(r.file)}`, `duration ${(r.count / fps).toFixed(6)}`);
  // The concat demuxer ignores the last entry's duration unless the file is
  // repeated; the repeat is cut off by -frames:v in encodeMaster.
  lines.push(`file ${quote((runs.at(-1) as CfrRun).file)}`);
  return `${lines.join("\n")}\n`;
}

export interface EncodeOptions {
  fps: number;
  crf?: number;
  preset?: string;
}

/** Encode frames into a CFR H.264 master at capture resolution. Returns encode ms. */
export async function encodeMaster(
  takeDir: string,
  capture: Pick<CaptureResult, "frames" | "t0" | "endTs">,
  out: string,
  opts: EncodeOptions,
): Promise<number> {
  const framesDir = path.join(takeDir, "frames");
  const script = path.join(framesDir, "frames.ffconcat");
  const runs = cfrSchedule(capture.frames, capture.t0, capture.endTs, opts.fps);
  const total = runs.reduce((n, r) => n + r.count, 0);
  fs.writeFileSync(script, buildConcatScript(runs, opts.fps));
  const { ms } = await ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    script,
    "-fps_mode",
    "cfr",
    "-r",
    String(opts.fps),
    "-frames:v",
    String(total),
    "-c:v",
    "libx264",
    "-preset",
    opts.preset ?? "veryfast",
    "-crf",
    String(opts.crf ?? 16),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  ]);
  return ms;
}
