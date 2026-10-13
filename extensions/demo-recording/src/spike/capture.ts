/**
 * S1 capture spike (IMPLEMENTATION_PLAN Q1): compare capture configurations
 * on the fixture with the S1 storyboard and report fps, gaps, CPU, sizes and
 * encode time. Results feed docs/spikes/S1-capture.md.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../config.ts";
import { serveFixture } from "../fixture/server.ts";
import { ffprobe } from "../media/ffmpeg.ts";
import { recordTake } from "../recorder/runner.ts";
import { parseStoryboard } from "../storyboard/parse.ts";
import { ensureProject } from "../workdir/layout.ts";

export interface SpikeConfig {
  label: string;
  viewport: { width: number; height: number; dpr: number };
  maxWidth?: number;
  maxHeight?: number;
}

export const SPIKE_CONFIGS: SpikeConfig[] = [
  { label: "3200x1800 (1600x900 @2x)", viewport: { width: 1600, height: 900, dpr: 2 } },
  {
    label: "2560x1440 (1600x900 @2x, downscaled)",
    viewport: { width: 1600, height: 900, dpr: 2 },
    maxWidth: 2560,
    maxHeight: 1440,
  },
  { label: "1920x1080 (1920x1080 @1x)", viewport: { width: 1920, height: 1080, dpr: 1 } },
];

/** Sum %CPU of Playwright-managed browser processes (macOS/Linux `ps`). */
function browserCpu(): number {
  try {
    const out = execFileSync("ps", ["-A", "-o", "%cpu=,command="], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((l) => l.includes("ms-playwright"))
      .reduce((n, l) => n + (Number.parseFloat(l.trim().split(/\s+/)[0] ?? "0") || 0), 0);
  } catch {
    return Number.NaN;
  }
}

export interface SpikeRow {
  label: string;
  frameSize: string;
  frames: number;
  avgFps: number;
  p95GapMs: number;
  maxGapMs: number;
  avgFrameKB: number;
  framesMB: number;
  browserCpuAvg: number;
  browserCpuMax: number;
  nodeCpuSec: number;
  encodeSec: number;
  rawMB: number;
  rawFps: string;
  takeSec: number;
  clockSkewMs: string;
  /** Continuous-animation window (spinner: Enter press → results visible). */
  animFps: number;
  animMaxGapMs: number;
}

export async function runCaptureSpike(
  storyboardFile: string,
  log: (m: string) => void = console.log,
): Promise<SpikeRow[]> {
  const cfg = resolveConfig();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-spike-"));
  const fixture = await serveFixture(0);
  // Start with ?slow=1 so the run contains a 4 s spinner = continuous animation.
  const storyboard = parseStoryboard(fs.readFileSync(storyboardFile, "utf8"));
  storyboard.start_url = `${storyboard.start_url}${storyboard.start_url.includes("?") ? "&" : "?"}slow=1`;
  const rows: SpikeRow[] = [];
  try {
    for (const c of SPIKE_CONFIGS) {
      const project = ensureProject(root, {
        project: `spike-${rows.length + 1}`,
        appName: "Acme Pulse",
        appUrl: fixture.url,
      });
      const samples: number[] = [];
      const timer = setInterval(() => samples.push(browserCpu()), 500);
      const cpu0 = process.cpuUsage();
      const take = await recordTake({
        projectDir: project.dir,
        storyboard,
        storyboardVersion: 1,
        baseUrl: fixture.url,
        viewport: c.viewport,
        fps: cfg.fps,
        capture: {
          ...(c.maxWidth ? { maxWidth: c.maxWidth } : {}),
          ...(c.maxHeight ? { maxHeight: c.maxHeight } : {}),
        },
        seed: 42,
        encode: false,
      });
      clearInterval(timer);
      const cpu = process.cpuUsage(cpu0);
      const { encodeMaster } = await import("../browser/capture/screencast.ts");
      const { readFileSync } = fs;
      const frames = readFileSync(path.join(take.takeDir, "frames.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const meta = JSON.parse(readFileSync(path.join(take.takeDir, "take.json"), "utf8"));
      const raw = path.join(take.takeDir, "raw.mp4");
      const encodeMs = await encodeMaster(
        take.takeDir,
        { frames, t0: meta.t0, endTs: meta.t0 + take.durationMs },
        raw,
        { fps: cfg.fps },
      );
      const probe = await ffprobe(raw);
      const press = take.events.find((e) => e.type === "press");
      const shown = take.events.find((e) => e.type === "wait-satisfied" && press && e.t > press.t);
      const win =
        press && shown
          ? frames.filter(
              (f: { ts: number }) =>
                f.ts - meta.t0 >= press.t + 400 && f.ts - meta.t0 <= shown.t - 100,
            )
          : [];
      const winGaps = win.slice(1).map((f: { ts: number }, i: number) => f.ts - win[i].ts);
      const winSec = press && shown ? (shown.t - 100 - (press.t + 400)) / 1000 : 0;
      const valid = samples.filter((n) => Number.isFinite(n));
      const row: SpikeRow = {
        label: c.label,
        frameSize: `${take.capture.width}x${take.capture.height}`,
        frames: take.capture.frames,
        avgFps: take.capture.avgFps,
        p95GapMs: take.capture.p95GapMs,
        maxGapMs: take.capture.maxGapMs,
        avgFrameKB: take.capture.avgFrameKB,
        framesMB: +(take.capture.totalBytes / 1024 / 1024).toFixed(1),
        browserCpuAvg: Math.round(valid.reduce((a, b) => a + b, 0) / Math.max(1, valid.length)),
        browserCpuMax: Math.round(Math.max(0, ...valid)),
        nodeCpuSec: +((cpu.user + cpu.system) / 1e6).toFixed(1),
        encodeSec: +(encodeMs / 1000).toFixed(1),
        rawMB: +(fs.statSync(raw).size / 1024 / 1024).toFixed(1),
        rawFps: probe.streams.find((s) => s.codec_type === "video")?.r_frame_rate ?? "?",
        takeSec: +(take.durationMs / 1000).toFixed(1),
        clockSkewMs: `${take.capture.clockSkewMs.min}…${take.capture.clockSkewMs.max}`,
        animFps: winSec > 0 ? +(win.length / winSec).toFixed(1) : 0,
        animMaxGapMs: Math.round(Math.max(0, ...winGaps)),
      };
      rows.push(row);
      log(`${c.label}: ${JSON.stringify(row)}`);
    }
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return rows;
}

export function spikeTable(rows: SpikeRow[]): string {
  const cols: [keyof SpikeRow, string][] = [
    ["label", "Config"],
    ["frameSize", "Frame"],
    ["animFps", "Anim fps"],
    ["animMaxGapMs", "Anim max gap ms"],
    ["avgFps", "Avg fps (incl. static)"],
    ["p95GapMs", "p95 gap ms"],
    ["maxGapMs", "Max gap ms"],
    ["avgFrameKB", "KB/frame"],
    ["framesMB", "Frames MB"],
    ["browserCpuAvg", "Browser CPU % avg"],
    ["browserCpuMax", "max"],
    ["nodeCpuSec", "Node CPU s"],
    ["encodeSec", "Encode s"],
    ["rawMB", "raw.mp4 MB"],
    ["takeSec", "Take s"],
    ["clockSkewMs", "Delivery latency ms"],
  ];
  const head = `| ${cols.map((c) => c[1]).join(" | ")} |`;
  const sep = `|${cols.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c[0]])).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}
