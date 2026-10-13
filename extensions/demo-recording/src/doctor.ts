/**
 * Prerequisite checks (`/demo doctor`, `cli.ts doctor`).
 *
 * All probes are injectable so tests run without real binaries or keys.
 * API keys are checked for presence only — values are never read into output.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DemoRecConfig } from "./config.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorProbes {
  /** Run a command; returns undefined if it can't be executed. */
  run: (cmd: string, args: string[]) => { status: number | null; stdout: string } | undefined;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  chromiumPath: () => Promise<string | undefined>;
  exists: (p: string) => boolean;
  /** Free bytes on the filesystem holding `p`, or undefined if unknown. */
  freeBytes: (p: string) => number | undefined;
  /** Ensure the root exists and is writable; throws otherwise. */
  ensureWritable: (dir: string) => void;
}

const GiB = 1024 ** 3;

function defaultRun(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 });
  if (r.error) return undefined;
  return { status: r.status, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function defaultChromiumPath(): Promise<string | undefined> {
  try {
    const { chromium } = await import("playwright");
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

export const defaultProbes: DoctorProbes = {
  run: defaultRun,
  env: process.env,
  nodeVersion: process.versions.node,
  chromiumPath: defaultChromiumPath,
  exists: (p) => fs.existsSync(p),
  freeBytes: (p) => {
    try {
      const s = fs.statfsSync(nearestExisting(p));
      return s.bavail * s.bsize;
    } catch {
      return undefined;
    }
  },
  ensureWritable: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  },
};

function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? "";
}

export async function runDoctor(
  cfg: DemoRecConfig,
  overrides: Partial<DoctorProbes> = {},
): Promise<CheckResult[]> {
  const p: DoctorProbes = { ...defaultProbes, ...overrides };
  const results: CheckResult[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    results.push({ name, status, detail });

  const major = Number(p.nodeVersion.split(".")[0]);
  add(
    "node",
    major >= 22 ? "pass" : "fail",
    `v${p.nodeVersion}${major >= 22 ? "" : " (need ≥ 22)"}`,
  );

  const ffmpeg = p.run("ffmpeg", ["-hide_banner", "-version"]);
  if (!ffmpeg || ffmpeg.status !== 0) {
    add("ffmpeg", "fail", "not found on PATH — install with `brew install ffmpeg`");
  } else {
    const encoders = p.run("ffmpeg", ["-hide_banner", "-encoders"]);
    const x264 = encoders?.stdout.includes("libx264") ?? false;
    add(
      "ffmpeg",
      x264 ? "pass" : "fail",
      `${firstLine(ffmpeg.stdout)}${x264 ? "" : " — missing libx264 encoder"}`,
    );
  }
  const ffprobe = p.run("ffprobe", ["-hide_banner", "-version"]);
  add(
    "ffprobe",
    ffprobe?.status === 0 ? "pass" : "fail",
    ffprobe?.status === 0 ? firstLine(ffprobe.stdout) : "not found on PATH (ships with ffmpeg)",
  );

  const uv = p.run("uv", ["--version"]);
  add(
    "uv",
    uv?.status === 0 ? "pass" : "warn",
    uv?.status === 0
      ? firstLine(uv.stdout)
      : "not found — needed for word timings (Whisper) and the local Kokoro voice: `brew install uv`",
  );

  const chromium = await p.chromiumPath();
  if (chromium && p.exists(chromium)) add("chromium", "pass", chromium);
  else
    add(
      "chromium",
      "fail",
      "Playwright Chromium not installed — run `npx playwright install chromium`",
    );

  add(
    "ELEVENLABS_API_KEY",
    p.env.ELEVENLABS_API_KEY ? "pass" : cfg.ttsChain[0] === "elevenlabs" ? "warn" : "pass",
    p.env.ELEVENLABS_API_KEY ? "set" : "not set — primary TTS unavailable, chain will fall back",
  );
  add(
    "OPENAI_API_KEY",
    p.env.OPENAI_API_KEY ? "pass" : "warn",
    p.env.OPENAI_API_KEY ? "set" : "not set — OpenAI TTS fallback unavailable (optional)",
  );
  add(
    "voice",
    cfg.voiceName ? "pass" : "warn",
    cfg.voiceName
      ? `"${cfg.voiceName}" (resolved by name in S4)`
      : "no default voiceName configured — set per brief or in config",
  );

  try {
    p.ensureWritable(cfg.root);
    add("workdir", "pass", cfg.root);
  } catch (err) {
    add("workdir", "fail", `${cfg.root} not writable: ${(err as Error).message}`);
  }
  const free = p.freeBytes(cfg.root);
  if (free === undefined) add("disk", "warn", "could not determine free space");
  else
    add(
      "disk",
      free >= 5 * GiB ? "pass" : "warn",
      `${(free / GiB).toFixed(1)} GiB free${free >= 5 * GiB ? "" : " (recommend ≥ 5 GiB; frames are large)"}`,
    );

  return results;
}

export function formatDoctor(results: CheckResult[]): string {
  const icon: Record<CheckStatus, string> = { pass: "✔", warn: "⚠", fail: "✖" };
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `${icon[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push(
    "",
    fails
      ? `${fails} failing, ${warns} warning(s)`
      : `all required checks pass (${warns} warning(s))`,
  );
  return lines.join("\n");
}
