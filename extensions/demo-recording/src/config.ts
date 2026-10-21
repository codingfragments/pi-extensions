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
  /**
   * Roles that may run as a separate model call (S5 part 12, D85–D90; docs/ACTORS.md).
   * Unset = the Director plays the role on the session model. The Operator's model is
   * `improvise.models`; the Cutter and the QA reviewer are engine roles (no model).
   */
  roles: { annotationDesigner?: { model: string[] } };
  /** Live input generation for `improvise` steps (S3): model chain, hesitation budget. */
  improvise: { models: string[]; hesitateMs: number; timeoutMs: number };
  /** Recording behaviour (S3): retries per scene, typo rate (0 = none). */
  recording: { maxRetriesPerScene: number; typoRate: number; keepFrames: boolean };
  /** Voice engines (S4). The chain order is `ttsChain`; keys come from the environment. */
  tts: {
    elevenlabs: { model: string; fallbackModel: string; stability?: number; similarity?: number };
    openai: { model: string; voice: string; instructions: string };
    kokoro: { voice: string };
    say: { voice?: string };
    /**
     * Cost estimate before synthesis (D84): money per 1,000 billing units —
     * ElevenLabs credits (flash/turbo models: 0.5 per character), characters
     * for the others. Defaults are list prices (check your plan).
     */
    pricePer1kChars: { elevenlabs: number; openai: number; kokoro: number; say: number };
    currency: string;
  };
  /** Word-timing alignment for engines without provider timings (S4, Q4). */
  align: { model: string };
  /** Brand package used for rendering (S5): built-in `neutral` or a user brand in <root>/brands/. */
  brand: string;
  /** Annotations stage (S5 part 8): suggest automatically after the sync edit (D53). */
  /** Annotations: auto-suggest after the sync edit, and the zoom limits (zooms per minute of the demo and per scene; item 12b). */
  annotations: { autoSuggest: boolean; zoomsPerMinute: number; zoomsPerScene: number };
  /** Render stage (S5 part 9): how many drafts keep their video files (D64). */
  render: { keepDrafts: number };
  /** Discovery budgets (S2). */
  budgets: { discoveryScreens: number; discoveryActions: number; discoveryMinutes: number };
  /** Discovery behaviour: how often a quiet session says it is alive (seconds; 0 = never). */
  discovery: { heartbeatSec: number };
  /** Where the resolved config came from, for `/demo status` and doctor. */
  sources: string[];
}

/** The roles the config can move to a separate model call, and why the others can't. */
export const SEPARABLE_ROLES = ["annotationDesigner"] as const;
const NOT_SEPARABLE: Record<string, string> = {
  director: "the Director is the session model itself (pick it in pi)",
  researcher: "discovery is a multi-step tool loop with the browser — the Director plays it",
  storyboardWriter: "writing the storyboard needs the discovery context — the Director plays it",
  operator: 'its model is "improvise.models"',
  voiceWriter: "not separable yet (the direction loop needs the Director's context)",
  cutter: "an engine role: deterministic, no model",
  brandDesigner: "the Director plays it (the brand skill needs a conversation with you)",
  qa: "an engine role: deterministic checks, no model (D69)",
  privacyOfficer:
    "its scan is an engine step; the designer's judgement is part of the Annotation designer",
};

/** "provider/id" or a list of them → a non-empty list. */
export function parseModelChain(v: unknown, field: string): string[] {
  const list =
    typeof v === "string"
      ? v
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : v;
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.some((m) => typeof m !== "string" || !/^[^/\s]+\/\S+$/.test(m))
  )
    throw new Error(
      `demo-recording config: "${field}" must be "provider/id" or a non-empty list of them`,
    );
  return list as string[];
}

function parseRoles(raw: unknown): DemoRecConfig["roles"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error('demo-recording config: "roles" must be an object');
  const out: DemoRecConfig["roles"] = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (name.startsWith("_")) continue;
    if (!(SEPARABLE_ROLES as readonly string[]).includes(name))
      throw new Error(
        `demo-recording config: "roles.${name}" ${NOT_SEPARABLE[name] ? `can't run separately: ${NOT_SEPARABLE[name]}` : `is not a role (separable: ${SEPARABLE_ROLES.join(", ")})`}`,
      );
    const m = (v as Record<string, unknown> | undefined)?.model;
    if (m !== undefined)
      out.annotationDesigner = { model: parseModelChain(m, `roles.${name}.model`) };
  }
  return out;
}

export interface ResolveInput {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (file: string) => string | undefined;
  /** Per-project overrides (`projects/<p>/config.json`), applied after the global file. */
  projectConfigFile?: string;
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
    roles: {},
    improvise: {
      models: ["anthropic/claude-haiku-4-5", "openai/gpt-5.4-mini"],
      hesitateMs: 3000,
      timeoutMs: 6000,
    },
    recording: { maxRetriesPerScene: 2, typoRate: 0, keepFrames: false },
    tts: {
      elevenlabs: { model: "eleven_v4", fallbackModel: "eleven_multilingual_v2" },
      openai: {
        model: "gpt-4o-mini-tts",
        voice: "ash",
        instructions:
          "Expert product guide: calm, confident, conversational; crisp on numbers; no hype.",
      },
      kokoro: { voice: "am_michael" },
      say: {},
      // ElevenLabs Creator ≈ $22 / 100k credits; OpenAI gpt-4o-mini-tts ≈ $0.015/min ≈ tts-1's $15 / 1M chars.
      pricePer1kChars: { elevenlabs: 0.22, openai: 0.015, kokoro: 0, say: 0 },
      currency: "$",
    },
    align: { model: "base.en" },
    brand: "neutral",
    annotations: { autoSuggest: true, zoomsPerMinute: 1.5, zoomsPerScene: 1 },
    render: { keepDrafts: 3 },
    budgets: { discoveryScreens: 40, discoveryActions: 150, discoveryMinutes: 20 },
    discovery: { heartbeatSec: 30 },
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
  if (raw.roles !== undefined) cfg.roles = parseRoles(raw.roles);
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
  const tts = raw.tts as Record<string, Record<string, unknown> | undefined> | undefined;
  if (tts !== undefined) {
    const str = (v: unknown, field: string) => {
      if (typeof v !== "string" || !v.trim())
        throw new Error(`demo-recording config: "${field}" must be a non-empty string`);
      return v.trim();
    };
    const unit = (v: unknown, field: string) => {
      if (typeof v !== "number" || v < 0 || v > 1)
        throw new Error(`demo-recording config: "${field}" must be 0..1`);
      return v;
    };
    const el = tts.elevenlabs;
    if (el?.model !== undefined) cfg.tts.elevenlabs.model = str(el.model, "tts.elevenlabs.model");
    if (el?.fallbackModel !== undefined)
      cfg.tts.elevenlabs.fallbackModel = str(el.fallbackModel, "tts.elevenlabs.fallbackModel");
    if (el?.stability !== undefined)
      cfg.tts.elevenlabs.stability = unit(el.stability, "tts.elevenlabs.stability");
    if (el?.similarity !== undefined)
      cfg.tts.elevenlabs.similarity = unit(el.similarity, "tts.elevenlabs.similarity");
    const oa = tts.openai;
    if (oa?.model !== undefined) cfg.tts.openai.model = str(oa.model, "tts.openai.model");
    if (oa?.voice !== undefined) cfg.tts.openai.voice = str(oa.voice, "tts.openai.voice");
    if (oa?.instructions !== undefined)
      cfg.tts.openai.instructions = str(oa.instructions, "tts.openai.instructions");
    if (tts.kokoro?.voice !== undefined)
      cfg.tts.kokoro.voice = str(tts.kokoro.voice, "tts.kokoro.voice");
    if (tts.say?.voice !== undefined) cfg.tts.say.voice = str(tts.say.voice, "tts.say.voice");
    const pr = tts.pricePer1kChars as Record<string, unknown> | undefined;
    if (pr !== undefined)
      for (const k of ["elevenlabs", "openai", "kokoro", "say"] as const) {
        if (pr[k] === undefined) continue;
        if (typeof pr[k] !== "number" || (pr[k] as number) < 0 || (pr[k] as number) > 100)
          throw new Error(
            `demo-recording config: "tts.pricePer1kChars.${k}" must be a number 0..100 (money per 1,000 characters/credits)`,
          );
        cfg.tts.pricePer1kChars[k] = pr[k] as number;
      }
    const cur = (raw.tts as Record<string, unknown>).currency;
    if (cur !== undefined) {
      if (typeof cur !== "string" || !cur.trim() || cur.length > 4)
        throw new Error(
          'demo-recording config: "tts.currency" must be a short symbol like "$" or "€"',
        );
      cfg.tts.currency = cur.trim();
    }
  }
  const al = raw.align as Record<string, unknown> | undefined;
  if (al?.model !== undefined) {
    if (
      typeof al.model !== "string" ||
      !/^(tiny|base|small|medium)(\.en)?$|^large-v3(-turbo)?$/.test(al.model)
    ) {
      throw new Error(
        'demo-recording config: "align.model" must be a faster-whisper model like base.en or small.en',
      );
    }
    cfg.align.model = al.model;
  }
  if (raw.brand !== undefined) {
    if (typeof raw.brand !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(raw.brand)) {
      throw new Error(
        'demo-recording config: "brand" must be a brand name like "neutral" (lowercase, digits, dashes)',
      );
    }
    cfg.brand = raw.brand;
  }
  const an = raw.annotations as Record<string, unknown> | undefined;
  if (an !== undefined) {
    if (an.autoSuggest !== undefined) {
      if (typeof an.autoSuggest !== "boolean")
        throw new Error('demo-recording config: "annotations.autoSuggest" must be true or false');
      cfg.annotations.autoSuggest = an.autoSuggest;
    }
    for (const [key, max, whole] of [
      ["zoomsPerMinute", 20, false],
      ["zoomsPerScene", 5, true],
    ] as const) {
      const v = an[key];
      if (v === undefined) continue;
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < 0 ||
        v > max ||
        (whole && !Number.isInteger(v))
      )
        throw new Error(
          `demo-recording config: "annotations.${key}" must be ${whole ? "a whole number" : "a number"} from 0 to ${max} (0 = no zooms)`,
        );
      cfg.annotations[key] = v;
    }
  }
  const rd = raw.render as Record<string, unknown> | undefined;
  if (rd !== undefined && rd.keepDrafts !== undefined) {
    if (
      !Number.isInteger(rd.keepDrafts) ||
      (rd.keepDrafts as number) < 0 ||
      (rd.keepDrafts as number) > 100
    )
      throw new Error('demo-recording config: "render.keepDrafts" must be a whole number 0..100');
    cfg.render.keepDrafts = rd.keepDrafts as number;
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
  const dc = raw.discovery as Record<string, unknown> | undefined;
  if (dc !== undefined && dc.heartbeatSec !== undefined) {
    const v = dc.heartbeatSec;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 300)
      throw new Error(
        'demo-recording config: "discovery.heartbeatSec" must be a whole number of seconds from 0 to 300 (0 = no heartbeat)',
      );
    cfg.discovery.heartbeatSec = v;
  }
}

/** Parse a config file's text into an object (hard error on malformed JSON). */
export function parseConfigText(text: string, file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`demo-recording config: ${file} is not valid JSON (${(err as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`demo-recording config: ${file} must contain a JSON object`);
  }
  return raw as Record<string, unknown>;
}

export function resolveConfig(input: ResolveInput = {}): DemoRecConfig {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const readFile = input.readFile ?? readFileIfExists;
  const cfg = defaultConfig(home);

  for (const file of [configFilePath(env, home), input.projectConfigFile].filter(
    (f): f is string => !!f,
  )) {
    const text = readFile(file);
    if (text === undefined) continue;
    applyFile(cfg, parseConfigText(text, file), home);
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
  if (env.DEMO_REC_ANNOTATION_MODEL?.trim()) {
    cfg.roles = {
      ...cfg.roles,
      annotationDesigner: {
        model: parseModelChain(env.DEMO_REC_ANNOTATION_MODEL, "DEMO_REC_ANNOTATION_MODEL"),
      },
    };
    envSources.push("DEMO_REC_ANNOTATION_MODEL");
  }
  if (env.DEMO_REC_BRAND) {
    cfg.brand = env.DEMO_REC_BRAND.trim();
    envSources.push("DEMO_REC_BRAND");
  }
  if (env.DEMO_REC_VOICE) {
    cfg.voiceName = env.DEMO_REC_VOICE;
    envSources.push("DEMO_REC_VOICE");
  }
  if (envSources.length) cfg.sources.push(`env(${envSources.join(",")})`);
  return cfg;
}
