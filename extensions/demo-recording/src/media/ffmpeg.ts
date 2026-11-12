/**
 * Thin ffmpeg/ffprobe wrappers. Failures throw with the tail of stderr so the
 * cause is visible in tool output and job logs.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { BoundedRunError, defaultTimeoutMs, guardChild } from "../util/bounded.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  ms: number;
}

export interface RunOptions {
  cwd?: string;
  /** Kill the command after this long, in ms (default: by command, see util/bounded.ts; 0 = never). */
  timeoutMs?: number;
  /** Kill the command when this aborts. */
  signal?: AbortSignal;
  /** ffmpeg only: how far the output is (`-progress pipe:1`, about twice a second). */
  onProgress?: (p: FfmpegProgress) => void;
}

export interface FfmpegProgress {
  /** Output time reached, in ms. */
  outTimeMs: number;
  /** How fast it runs, in x real time (null while ffmpeg does not know yet). */
  speed: number | null;
  /** ffmpeg said `progress=end`. */
  end: boolean;
}

/**
 * Reads the `key=value` lines of `-progress pipe:1`. A block ends with `progress=continue|end`; `out_time_us` (microseconds; `out_time_ms` is the same number, a long-standing
 * misnomer) and `speed=1.23x` are what is kept. Returns one function: feed it text as it arrives.
 */
export function progressParser(onProgress: (p: FfmpegProgress) => void): (chunk: string) => void {
  let rest = "";
  let outUs: number | undefined;
  let speed: number | null = null;
  return (chunk) => {
    rest += chunk;
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (key === "out_time_us" || key === "out_time_ms") {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) outUs = n;
      } else if (key === "speed") {
        const n = Number.parseFloat(value);
        speed = Number.isFinite(n) && n > 0 ? n : null;
      } else if (key === "progress") {
        if (outUs !== undefined)
          onProgress({ outTimeMs: outUs / 1000, speed, end: value === "end" });
      }
    }
  };
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // a command that does not finish is diagnosed and killed with everything it started (util/bounded.ts), and the error says so
    const stopWatch = guardChild(child, {
      label: path.basename(cmd),
      cmd,
      args,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      timeoutMs: opts.timeoutMs ?? defaultTimeoutMs(cmd),
      ...(opts.signal ? { signal: opts.signal } : {}),
      stderrTail: () => stderr,
    });
    const feed = opts.onProgress ? progressParser(opts.onProgress) : undefined;
    child.stdout.on("data", (c) => {
      if (feed) feed(String(c));
      else stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (err) => {
      stopWatch();
      reject(err instanceof BoundedRunError ? err : new Error(`${cmd}: ${err.message}`));
    });
    child.on("close", (code) => {
      stopWatch();
      if (code === 0) resolve({ stdout, stderr, ms: Date.now() - started });
      else {
        const tail = stderr.trim().split("\n").slice(-12).join("\n");
        reject(new Error(`${cmd} exited with ${code}:\n${tail}`));
      }
    });
  });
}

export function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      // the progress goes to stdout (the output is a file): about twice a second, parsed by `progressParser`
      ...(opts.onProgress ? ["-progress", "pipe:1", "-nostats"] : []),
      ...args,
    ],
    opts,
  );
}

export interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
}

export interface Probe {
  duration: number;
  streams: ProbeStream[];
}

export async function ffprobe(file: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate",
    "-of",
    "json",
    file,
  ]);
  const json = JSON.parse(stdout) as { format: { duration: string }; streams: ProbeStream[] };
  return { duration: Number(json.format.duration), streams: json.streams };
}

/** Is `name` on PATH and runnable? (ffmpeg uses -version, most tools --version.) */
export function hasBinary(name: string): boolean {
  for (const flag of ["--version", "-version"]) {
    const r = spawnSync(name, [flag], { stdio: "ignore" });
    if (r.error) return false;
    if (r.status === 0) return true;
  }
  return false;
}
