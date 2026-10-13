/**
 * Thin ffmpeg/ffprobe wrappers. Failures throw with the tail of stderr so the
 * cause is visible in tool output and job logs.
 */

import { spawn, spawnSync } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  ms: number;
}

export function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (err) => reject(new Error(`${cmd}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, ms: Date.now() - started });
      else {
        const tail = stderr.trim().split("\n").slice(-12).join("\n");
        reject(new Error(`${cmd} exited with ${code}:\n${tail}`));
      }
    });
  });
}

export function ffmpeg(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  return run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], opts);
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

export function hasBinary(name: string): boolean {
  const r = spawnSync(name, ["-version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}
