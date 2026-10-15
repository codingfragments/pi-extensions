/**
 * Conversational config editing (S5, D: config skill).
 *
 * Layers (lowest → highest): built-in defaults → global
 * `~/.config/demo-recording/config.json` → project `projects/<p>/config.json`
 * → environment (DEMO_REC_*). Writes go to the global or project file:
 *  - only KNOWN keys (unknown and secret-looking keys are refused; API keys
 *    live in the environment only);
 *  - the new file is validated with the real resolver BEFORE anything is
 *    written; the `_comment` docs block is kept;
 *  - every change is shown as a diff first (callers confirm).
 */

import fs from "node:fs";
import path from "node:path";
import {
  type DemoRecConfig,
  configFilePath,
  defaultConfig,
  parseConfigText,
  resolveConfig,
} from "./config.ts";
import { writeFileAtomic } from "./workdir/versioning.ts";

export type Scope = "global" | "project";

/** Settings without a default value (not present in defaultConfig). */
export const OPTIONAL_KEYS = [
  "capture.maxWidth",
  "capture.maxHeight",
  "tts.elevenlabs.stability",
  "tts.elevenlabs.similarity",
  "tts.say.voice",
];

/** One-line docs per key (shown by `show` / `explain`). */
export const CONFIG_DOCS: Record<string, string> = {
  root: "Working directory holding apps/ and projects/ (~ is expanded).",
  "viewport.width": "Browser viewport width in CSS px.",
  "viewport.height": "Browser viewport height in CSS px.",
  "viewport.dpr": "Device pixel ratio for capture (2 → 3200×1800 frames at 1600×900).",
  fps: "Output frame rate.",
  "capture.quality": "Screencast JPEG quality 1..100.",
  "capture.maxWidth": "Optional: downscale capture width (e.g. 2560) on weaker machines.",
  "capture.maxHeight": "Optional: downscale capture height (e.g. 1440).",
  "output.width": "Rendered video width.",
  "output.height": "Rendered video height.",
  panelPort: "Preferred side-panel port (next free port if taken).",
  ttsChain:
    "Voice engines in priority order (elevenlabs | openai | kokoro | say); one engine per video.",
  voiceName:
    "ElevenLabs voice display name (exact, then prefix) or voice id. A project's brief 'Voice:' wins.",
  "improvise.models": "Fast-model chain (provider/id) for live improvised inputs.",
  "improvise.hesitateMs":
    "Max cursor hesitation waiting for an improvised input before the fallback text.",
  "improvise.timeoutMs": "Per-request timeout for improvise models.",
  "recording.maxRetriesPerScene": "Retries per failing scene (0..5).",
  "recording.typoRate": "Typo-and-correct probability per letter (0..0.1).",
  "recording.keepFrames": "Keep raw JPEG frames after encoding (raw.mp4 is the master).",
  "tts.elevenlabs.model": "ElevenLabs model (default eleven_v4).",
  "tts.elevenlabs.fallbackModel":
    "Used when the account rejects the model on the timestamp endpoint.",
  "tts.elevenlabs.stability": "Optional voice stability 0..1.",
  "tts.elevenlabs.similarity": "Optional similarity boost 0..1.",
  "tts.openai.model": "OpenAI TTS model.",
  "tts.openai.voice": "OpenAI voice (alloy, ash, ballad, coral, echo, sage, shimmer, verse …).",
  "tts.openai.instructions": "Tone/delivery instructions for gpt-4o-mini-tts.",
  "tts.kokoro.voice": "Local Kokoro voice (am_michael, am_adam, af_heart, bf_emma …).",
  "tts.say.voice": "Optional macOS say voice (dev only).",
  "align.model": "faster-whisper model for word timings: tiny.en | base.en | small.en | medium.en.",
  brand:
    "Brand package for rendering: built-in 'neutral' or a user brand in <root>/brands/ (see /demo brand list).",
  "annotations.autoSuggest":
    "Suggest annotations automatically after each sync edit (an agent turn). Off: use Re-suggest in the Annotations tab.",
  "render.keepDrafts":
    "How many draft renders keep their video files; older drafts keep only their record (finals are never pruned).",
  "budgets.discoveryScreens": "Max screenshots per discovery session.",
  "budgets.discoveryActions": "Max actions per discovery session.",
  "budgets.discoveryMinutes": "Max minutes per discovery session.",
};

/** Env vars that override keys (highest layer). */
export const ENV_KEYS: Record<string, string> = {
  root: "DEMO_REC_ROOT",
  panelPort: "DEMO_REC_PANEL_PORT",
  ttsChain: "DEMO_REC_TTS_CHAIN",
  voiceName: "DEMO_REC_VOICE",
  "improvise.models": "DEMO_REC_IMPROVISE_MODELS",
  brand: "DEMO_REC_BRAND",
};

const SECRET = /(api[-_]?key|token|secret|password|credential)/i;

function leaves(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    k === "sources"
      ? []
      : v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length
        ? leaves(v, prefix ? `${prefix}.${k}` : k)
        : [prefix ? `${prefix}.${k}` : k],
  );
}

export function knownKeys(): string[] {
  const keys = new Set([...leaves(defaultConfig("~")), ...OPTIONAL_KEYS]);
  keys.delete("tts.say"); // empty object leaf
  return [...keys].sort();
}

export function getPath(obj: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let o = obj;
  for (const k of parts.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object" || Array.isArray(o[k])) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[parts.at(-1) as string] = value;
}

function deletePath(obj: Record<string, unknown>, key: string): boolean {
  const parts = key.split(".");
  let o: Record<string, unknown> | undefined = obj;
  for (const k of parts.slice(0, -1)) {
    o = o?.[k] && typeof o[k] === "object" ? (o[k] as Record<string, unknown>) : undefined;
  }
  const last = parts.at(-1) as string;
  if (!o || !(last in o)) return false;
  delete o[last];
  return true;
}

export interface LayerFiles {
  global: string;
  project?: string;
}

export function layerFiles(env: NodeJS.ProcessEnv, home: string, projectDir?: string): LayerFiles {
  return {
    global: configFilePath(env, home),
    ...(projectDir ? { project: path.join(projectDir, "config.json") } : {}),
  };
}

function readRaw(file: string | undefined): Record<string, unknown> | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  return parseConfigText(fs.readFileSync(file, "utf8"), file);
}

export interface EffectiveEntry {
  key: string;
  value: unknown;
  source: "default" | "global" | "project" | "env" | "unset";
  doc: string;
}

/** Effective value + source for every known key (optionally filtered by prefix). */
export function describeConfig(
  files: LayerFiles,
  env: NodeJS.ProcessEnv,
  home: string,
  prefix = "",
): EffectiveEntry[] {
  const cfg = resolveConfig({
    env,
    home,
    ...(files.project ? { projectConfigFile: files.project } : {}),
  });
  const g = readRaw(files.global);
  const pr = readRaw(files.project);
  return knownKeys()
    .filter((k) => !prefix || k === prefix || k.startsWith(`${prefix}.`))
    .map((key) => {
      const value = getPath(cfg, key);
      const envVar = ENV_KEYS[key];
      const source: EffectiveEntry["source"] =
        envVar && env[envVar]
          ? "env"
          : pr && getPath(pr, key) !== undefined
            ? "project"
            : g && getPath(g, key) !== undefined
              ? "global"
              : value === undefined
                ? "unset"
                : "default";
      return { key, value, source, doc: CONFIG_DOCS[key] ?? "" };
    });
}

export function formatEntries(entries: EffectiveEntry[], files: LayerFiles): string {
  const lines = entries.map(
    (e) =>
      `${e.key} = ${e.value === undefined ? "(not set)" : JSON.stringify(e.value)}   [${e.source}]${e.doc ? `\n    ${e.doc}` : ""}`,
  );
  lines.push(
    "",
    `global file:  ${files.global}`,
    `project file: ${files.project ?? "(no active project)"}`,
  );
  return lines.join("\n");
}

/** Parse a user/agent supplied value: JSON if it parses, else a plain string. */
export function parseValue(raw: string): unknown {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** Minimal line diff (unchanged lines elided). */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // LCS table (config files are small)
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (
      i < a.length &&
      (j >= b.length ||
        ((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number))
    )
      out.push(`- ${a[i++]}`); // deletions before additions
    else out.push(`+ ${b[j++]}`);
  }
  return out.join("\n") || "(no change)";
}

export interface PlannedChange {
  file: string;
  scope: Scope;
  key: string;
  before: unknown;
  after: unknown;
  diff: string;
  newText: string;
  /** Effective value after the change (other layers considered). */
  effective: unknown;
  /** A higher layer (project/env) overrides this write. */
  shadowedBy?: string;
}

/**
 * Plan a set/unset without writing. Throws on unknown or secret keys and on
 * values the resolver rejects (with the resolver's own message).
 */
export function planChange(
  files: LayerFiles,
  scope: Scope,
  key: string,
  value: unknown,
  opts: { env: NodeJS.ProcessEnv; home: string; unset?: boolean },
): PlannedChange {
  if (SECRET.test(key))
    throw new Error(
      `"${key}" looks like a secret — API keys come from the environment only (export it, then restart pi)`,
    );
  if (!knownKeys().includes(key)) {
    const near = knownKeys().filter((k) => k.split(".").at(-1) === key.split(".").at(-1));
    throw new Error(
      `unknown setting "${key}"${near.length ? ` — did you mean ${near.join(" or ")}?` : ""}`,
    );
  }
  const file = scope === "project" ? files.project : files.global;
  if (!file) throw new Error("no active project — use scope global, or /demo open a project first");
  const raw = readRaw(file) ?? {};
  const beforeText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}\n";
  const before = getPath(raw, key);
  const next = structuredClone(raw);
  if (opts.unset) {
    if (!deletePath(next, key)) throw new Error(`"${key}" is not set in the ${scope} config`);
  } else setPath(next, key, value);
  const newText = `${JSON.stringify(next, null, 2)}\n`;
  // Validate with the real resolver, layering exactly as at runtime.
  const projectFile = files.project;
  const read = (f: string) =>
    f === file ? newText : fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined;
  const cfg: DemoRecConfig = resolveConfig({
    env: opts.env,
    home: opts.home,
    readFile: read,
    ...(projectFile ? { projectConfigFile: projectFile } : {}),
  });
  const effective = getPath(cfg, key);
  const envVar = ENV_KEYS[key];
  const shadowedBy =
    envVar && opts.env[envVar]
      ? `env ${envVar}`
      : scope === "global" && projectFile && getPath(readRaw(projectFile) ?? {}, key) !== undefined
        ? `project ${projectFile}`
        : undefined;
  return {
    file,
    scope,
    key,
    before,
    after: opts.unset ? undefined : value,
    diff: lineDiff(beforeText.trimEnd(), newText.trimEnd()),
    newText,
    effective,
    ...(shadowedBy ? { shadowedBy } : {}),
  };
}

export function applyChange(change: PlannedChange): void {
  fs.mkdirSync(path.dirname(change.file), { recursive: true });
  writeFileAtomic(change.file, change.newText);
}

export function formatChange(c: PlannedChange): string {
  return [
    `${c.scope} config: ${c.file}`,
    `${c.key}: ${c.before === undefined ? "(not set)" : JSON.stringify(c.before)} → ${c.after === undefined ? "(removed)" : JSON.stringify(c.after)}`,
    `effective after the change: ${JSON.stringify(c.effective)}`,
    c.shadowedBy
      ? `⚠ overridden by ${c.shadowedBy} — this write won't take effect until that is removed`
      : "",
    "diff:",
    c.diff,
  ]
    .filter(Boolean)
    .join("\n");
}
