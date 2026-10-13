/**
 * Configuration resolution (S0).
 *
 * Precedence (lowest → highest): built-in defaults → config file → environment.
 *
 * Config file: `$DEMO_REC_CONFIG`, else `~/.config/demo-recording/config.json`.
 * The file is optional; a malformed file is a hard error (silently ignoring a
 * typo in e.g. the root directory would scatter recordings somewhere else).
 *
 * The resolver is a pure function over injected env/home/readFile so tests can
 * exercise precedence without touching the real home directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TtsEngine = "elevenlabs" | "openai" | "kokoro" | "say";

export interface DemoRecConfig {
  /** Working directory root holding `apps/` and `projects/`. */
  root: string;
  /** Capture viewport in CSS pixels plus device scale factor (D15). */
  viewport: { width: number; height: number; dpr: number };
  /** Render frame rate (D15). */
  fps: number;
  /**
   * Screencast capture (D2). Default: full device pixels (viewport × dpr).
   * Set maxWidth/maxHeight (e.g. 2560×1440) to downscale on weaker machines
   * (docs/spikes/S1-capture.md).
   */
  capture: { quality: number; maxWidth?: number; maxHeight?: number };
  /** Render output size (D15). */
  output: { width: number; height: number };
  /** Preferred panel port; the next free port is used if taken. */
  panelPort: number;
  /** TTS provider chain in priority order (D12). */
  ttsChain: TtsEngine[];
  /** ElevenLabs voice, resolved by name (D12). Empty = ask at brief time. */
  voiceName: string;
  /** Live input generation for `improvise` steps (S3): model chain, hesitation budget. */
  improvise: { models: string[]; hesitateMs: number; timeoutMs: number };
  /** Recording behaviour (S3): retries per scene, typo rate (0 = none). */
  recording: { maxRetriesPerScene: number; typoRate: number; keepFrames: boolean };
  /** Discovery budgets (S2). */
  budgets: { discoveryScreens: number; discoveryActions: number; discoveryMinutes: number };
  /** Where the resolved config came from, for `/demo status` and doctor. */
  sources: string[];
}

export interface ResolveInput {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (file: string) => string | undefined;
}

const TTS_ENGINES: readonly TtsEngine[] = ["elevenlabs", "openai", "kokoro", "say"];

export function defaultConfig(home: string): DemoRecConfig {
  return {
    root: path.join(home, "DemoRecordings"),
    viewport: { width: 1600, height: 900, dpr: 2 },
    fps: 30,
    capture: { quality: 92 },
    output: { width: 1920, height: 1080 },
    panelPort: 3777,
    ttsChain: ["elevenlabs", "openai", "kokoro"],
    voiceName: "",
    improvise: {
      models: ["anthropic/claude-haiku-4-5", "openai/gpt-5.4-mini"],
      hesitateMs: 3000,
      timeoutMs: 6000,
    },
    recording: { maxRetriesPerScene: 2, typoRate: 0, keepFrames: false },
    budgets: { discoveryScreens: 40, discoveryActions: 150, discoveryMinutes: 20 },
    sources: ["defaults"],
  };
}

export function configFilePath(env: NodeJS.ProcessEnv, home: string): string {
  return env.DEMO_REC_CONFIG || path.join(home, ".config", "demo-recording", "config.json");
}

function readFileIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function positiveInt(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `demo-recording config: "${field}" must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function parseChain(value: unknown, field: string): TtsEngine[] {
  const list = typeof value === "string" ? value.split(",").map((s) => s.trim()) : value;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`demo-recording config: "${field}" must be a non-empty list of TTS engines`);
  }
  for (const item of list) {
    if (!TTS_ENGINES.includes(item as TtsEngine)) {
      throw new Error(
        `demo-recording config: unknown TTS engine "${item}" in "${field}" (known: ${TTS_ENGINES.join(", ")})`,
      );
    }
  }
  return list as TtsEngine[];
}

/** Apply a parsed (untrusted) object onto a config, validating each known field. */
function applyFile(cfg: DemoRecConfig, raw: Record<string, unknown>, home: string): void {
  if (raw.root !== undefined) {
    if (typeof raw.root !== "string" || !raw.root)
      throw new Error('demo-recording config: "root" must be a string');
    cfg.root = path.resolve(expandHome(raw.root, home));
  }
  const vp = raw.viewport as Record<string, unknown> | undefined;
  if (vp !== undefined) {
    if (vp.width !== undefined) cfg.viewport.width = positiveInt(vp.width, "viewport.width");
    if (vp.height !== undefined) cfg.viewport.height = positiveInt(vp.height, "viewport.height");
    if (vp.dpr !== undefined) cfg.viewport.dpr = positiveInt(vp.dpr, "viewport.dpr");
  }
  const out = raw.output as Record<string, unknown> | undefined;
  if (out !== undefined) {
    if (out.width !== undefined) cfg.output.width = positiveInt(out.width, "output.width");
    if (out.height !== undefined) cfg.output.height = positiveInt(out.height, "output.height");
  }
  if (raw.fps !== undefined) cfg.fps = positiveInt(raw.fps, "fps");
  const cap = raw.capture as Record<string, unknown> | undefined;
  if (cap !== undefined) {
    if (cap.quality !== undefined) {
      const q = positiveInt(cap.quality, "capture.quality");
      if (q > 100) throw new Error('demo-recording config: "capture.quality" must be 1..100');
      cfg.capture.quality = q;
    }
    if (cap.maxWidth !== undefined)
      cfg.capture.maxWidth = positiveInt(cap.maxWidth, "capture.maxWidth");
    if (cap.maxHeight !== undefined)
      cfg.capture.maxHeight = positiveInt(cap.maxHeight, "capture.maxHeight");
  }
  if (raw.panelPort !== undefined) cfg.panelPort = positiveInt(raw.panelPort, "panelPort");
  if (raw.ttsChain !== undefined) cfg.ttsChain = parseChain(raw.ttsChain, "ttsChain");
  if (raw.voiceName !== undefined) {
    if (typeof raw.voiceName !== "string")
      throw new Error('demo-recording config: "voiceName" must be a string');
    cfg.voiceName = raw.voiceName;
  }
  const imp = raw.improvise as Record<string, unknown> | undefined;
  if (imp !== undefined) {
    if (imp.models !== undefined) {
      if (
        !Array.isArray(imp.models) ||
        !imp.models.length ||
        imp.models.some((m) => typeof m !== "string" || !/^[^/]+\/.+$/.test(m))
      ) {
        throw new Error(
          'demo-recording config: "improvise.models" must be a non-empty list of "provider/id"',
        );
      }
      cfg.improvise.models = imp.models as string[];
    }
    if (imp.hesitateMs !== undefined)
      cfg.improvise.hesitateMs = positiveInt(imp.hesitateMs, "improvise.hesitateMs");
    if (imp.timeoutMs !== undefined)
      cfg.improvise.timeoutMs = positiveInt(imp.timeoutMs, "improvise.timeoutMs");
  }
  const rec = raw.recording as Record<string, unknown> | undefined;
  if (rec !== undefined) {
    if (rec.maxRetriesPerScene !== undefined) {
      const n = rec.maxRetriesPerScene;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 5)
        throw new Error('demo-recording config: "recording.maxRetriesPerScene" must be 0..5');
      cfg.recording.maxRetriesPerScene = n;
    }
    if (rec.typoRate !== undefined) {
      const r = rec.typoRate;
      if (typeof r !== "number" || r < 0 || r > 0.1)
        throw new Error('demo-recording config: "recording.typoRate" must be 0..0.1');
      cfg.recording.typoRate = r;
    }
    if (rec.keepFrames !== undefined) cfg.recording.keepFrames = rec.keepFrames === true;
  }
  const b = raw.budgets as Record<string, unknown> | undefined;
  if (b !== undefined) {
    if (b.discoveryScreens !== undefined)
      cfg.budgets.discoveryScreens = positiveInt(b.discoveryScreens, "budgets.discoveryScreens");
    if (b.discoveryActions !== undefined)
      cfg.budgets.discoveryActions = positiveInt(b.discoveryActions, "budgets.discoveryActions");
    if (b.discoveryMinutes !== undefined)
      cfg.budgets.discoveryMinutes = positiveInt(b.discoveryMinutes, "budgets.discoveryMinutes");
  }
}

export function resolveConfig(input: ResolveInput = {}): DemoRecConfig {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const readFile = input.readFile ?? readFileIfExists;
  const cfg = defaultConfig(home);

  const file = configFilePath(env, home);
  const text = readFile(file);
  if (text !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `demo-recording config: ${file} is not valid JSON (${(err as Error).message})`,
      );
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`demo-recording config: ${file} must contain a JSON object`);
    }
    applyFile(cfg, raw as Record<string, unknown>, home);
    cfg.sources.push(file);
  }

  const envSources: string[] = [];
  if (env.DEMO_REC_ROOT) {
    cfg.root = path.resolve(expandHome(env.DEMO_REC_ROOT, home));
    envSources.push("DEMO_REC_ROOT");
  }
  if (env.DEMO_REC_PANEL_PORT) {
    cfg.panelPort = positiveInt(env.DEMO_REC_PANEL_PORT, "DEMO_REC_PANEL_PORT");
    envSources.push("DEMO_REC_PANEL_PORT");
  }
  if (env.DEMO_REC_TTS_CHAIN) {
    cfg.ttsChain = parseChain(env.DEMO_REC_TTS_CHAIN, "DEMO_REC_TTS_CHAIN");
    envSources.push("DEMO_REC_TTS_CHAIN");
  }
  if (env.DEMO_REC_IMPROVISE_MODELS) {
    cfg.improvise.models = env.DEMO_REC_IMPROVISE_MODELS.split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    envSources.push("DEMO_REC_IMPROVISE_MODELS");
  }
  if (env.DEMO_REC_VOICE) {
    cfg.voiceName = env.DEMO_REC_VOICE;
    envSources.push("DEMO_REC_VOICE");
  }
  if (envSources.length) cfg.sources.push(`env(${envSources.join(",")})`);
  return cfg;
}
