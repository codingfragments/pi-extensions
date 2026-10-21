/**
 * Panel routes for ⚙ Config → Settings (S5 part 5b, D41/D48): every setting
 * grouped, with its effective value, source, per-layer values, docs and
 * shadowing; edits go through the same two-phase planChange/applyChange as
 * `demo_rec_config` (diff first, validated by the real resolver). The raw
 * global and project files are shown read-only. API keys are never read or
 * written here — only "set / not set" for the known environment variables.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBrands } from "../brand/brand.ts";
import { effectiveBrand } from "../brand/brand.ts";
import {
  type BatchItem,
  CONFIG_DOCS,
  ENV_KEYS,
  type LayerFiles,
  type Scope,
  applyBatch,
  applyChange,
  describeConfig,
  getPath,
  layerFiles,
  parseValue,
  planBatch,
  planChange,
} from "../config-edit.ts";
import { type DemoRecConfig, defaultConfig } from "../config.ts";
import { envOverrides } from "../env-overrides.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface ConfigRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  /** Re-resolve the runtime config after a write. */
  reloadConfig: () => DemoRecConfig;
  publish: (type: string, data: Record<string, unknown>, project?: string) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export const SETTING_GROUPS: { id: string; label: string; match: (key: string) => boolean }[] = [
  {
    id: "voice",
    label: "Voice (TTS)",
    match: (k) => k === "ttsChain" || k === "voiceName" || k.startsWith("tts."),
  },
  {
    id: "models",
    label: "Models",
    match: (k) => k.startsWith("improvise.") || k.startsWith("align.") || k.startsWith("roles."),
  },
  {
    id: "recording",
    label: "Recording & capture",
    match: (k) =>
      k.startsWith("recording.") || k.startsWith("viewport.") || k.startsWith("capture."),
  },
  {
    id: "output",
    label: "Output & look",
    match: (k) =>
      k.startsWith("output.") || k === "fps" || k === "brand" || k.startsWith("render."),
  },
  { id: "annotations", label: "Annotations", match: (k) => k.startsWith("annotations.") },
  {
    id: "discovery",
    label: "Discovery",
    match: (k) => k.startsWith("budgets.") || k.startsWith("discovery."),
  },
  { id: "general", label: "General", match: () => true },
];

const ENGINES = ["elevenlabs", "openai", "kokoro", "say"];
/** Types for optional keys (no default value to infer from). */
const OPTIONAL_TYPES: Record<string, "number" | "string"> = {
  "capture.maxWidth": "number",
  "capture.maxHeight": "number",
  "tts.elevenlabs.stability": "number",
  "tts.elevenlabs.similarity": "number",
  "tts.say.voice": "string",
};
/** Known environment variables for API keys: only their presence is reported. */
export const API_KEY_VARS = [
  { name: "ELEVENLABS_API_KEY", for: "ElevenLabs voice (TTS)" },
  { name: "OPENAI_API_KEY", for: "OpenAI TTS and model fallbacks" },
];

export interface SettingView {
  key: string;
  label: string;
  doc: string;
  type: "number" | "boolean" | "string" | "list" | "enum" | "engines";
  options?: string[];
  value: unknown;
  source: "default" | "global" | "project" | "env" | "unset";
  layers: { default: unknown; global: unknown; project: unknown };
  envVar?: string;
  envSet?: boolean;
  /** Only settable globally (e.g. root). */
  globalOnly?: boolean;
}

function readJson(file: string | undefined): Record<string, unknown> | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const SECTION_NAMES: Record<string, string> = {
  elevenlabs: "ElevenLabs",
  openai: "OpenAI",
  kokoro: "Kokoro",
  say: "macOS say",
  improvise: "Operator",
  annotationDesigner: "Annotation designer",
  viewport: "Viewport",
  capture: "Capture",
  output: "Output",
  budgets: "Discovery",
  recording: "Recording",
  align: "Alignment",
};
const word = (w: string) =>
  w
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bTts\b/g, "TTS")
    .replace(/\bDpr\b/g, "DPR")
    .replace(/\bFps\b/g, "FPS");
/** "tts.elevenlabs.model" → "ElevenLabs · Model", "voiceName" → "Voice Name", "budgets.discoveryActions" → "Discovery · Actions". */
const pretty = (key: string) => {
  const parts = key.split(".");
  const leaf = word(parts.at(-1) ?? key);
  const section = parts.length >= 2 ? parts.at(-2) : undefined;
  if (!section || section === "tts") return leaf;
  const sec = SECTION_NAMES[section] ?? word(section);
  const rest = leaf.startsWith(`${sec} `)
    ? leaf.slice(sec.length + 1).replace(/^./, (c) => c.toUpperCase())
    : leaf;
  return `${sec} · ${rest}`;
};
/** Most important first inside a group; the rest alphabetical. */
const PRIORITY = [
  "ttsChain",
  "voiceName",
  "tts.elevenlabs.model",
  "tts.elevenlabs.fallbackModel",
  "improvise.models",
  "roles.annotationDesigner.model",
  "brand",
  "output.width",
  "output.height",
  "fps",
  "viewport.width",
  "viewport.height",
  "viewport.dpr",
  "root",
  "panelPort",
];
const rank = (k: string) => {
  const i = PRIORITY.indexOf(k);
  return i < 0 ? PRIORITY.length : i;
};

/** All settings, grouped, with the info the form needs. */
export function settingsView(
  files: LayerFiles,
  env: NodeJS.ProcessEnv,
  home: string,
  root: string,
): { id: string; label: string; settings: SettingView[] }[] {
  const defaults = defaultConfig(home);
  const g = readJson(files.global);
  const pr = readJson(files.project);
  const brands = listBrands(root)
    .filter((b) => !b.error)
    .map((b) => b.name);
  const entries = describeConfig(files, env, home);
  const views: SettingView[] = entries.map((e) => {
    const def = getPath(defaults, e.key);
    const type: SettingView["type"] =
      e.key === "ttsChain"
        ? "engines"
        : e.key === "brand" || e.key === "align.model"
          ? "enum"
          : Array.isArray(def)
            ? "list"
            : typeof def === "number" || OPTIONAL_TYPES[e.key] === "number"
              ? "number"
              : typeof def === "boolean"
                ? "boolean"
                : "string";
    const options =
      e.key === "ttsChain"
        ? ENGINES
        : e.key === "brand"
          ? brands
          : e.key === "align.model"
            ? ["tiny.en", "base.en", "small.en", "medium.en"]
            : undefined;
    const envVar = ENV_KEYS[e.key];
    return {
      key: e.key,
      label: pretty(e.key),
      doc: CONFIG_DOCS[e.key] ?? "",
      type,
      ...(options ? { options } : {}),
      value: e.value,
      source: e.source,
      layers: {
        default: def ?? null,
        global: g ? (getPath(g, e.key) ?? null) : null,
        project: pr ? (getPath(pr, e.key) ?? null) : null,
      },
      ...(envVar ? { envVar, envSet: !!env[envVar] } : {}),
      ...(e.key === "root" ? { globalOnly: true } : {}),
    };
  });
  const used = new Set<string>();
  return SETTING_GROUPS.map((grp) => {
    const settings = views
      .filter((v) => !used.has(v.key) && grp.match(v.key))
      .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
    for (const s of settings) used.add(s.key);
    return { id: grp.id, label: grp.label, settings };
  }).filter((x) => x.settings.length);
}

/** Open a file in the user's default editor (best effort). */
export function openInEditor(file: string): boolean {
  if (process.env.DEMO_REC_NO_OPEN === "1" || process.env.CI) return false;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", ["-t", file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', file]]
        : ["xdg-open", [file]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function configRoutes(deps: ConfigRouteDeps): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const env = () => deps.env ?? process.env;
  const home = () => deps.home ?? os.homedir();
  const files = () => layerFiles(env(), home(), deps.activeProject()?.dir);
  const scopeOf = (body: Record<string, unknown>): Scope =>
    body.scope === "project" ? "project" : "global";
  return {
    get: {
      /** Settings form data + the raw files (read-only) + API key presence. */
      config: () => {
        const f = files();
        const cfg = deps.reloadConfig();
        const raw = (file: string | undefined) =>
          file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
        return {
          project: deps.activeProject()?.slug ?? null,
          files: { global: f.global, project: f.project ?? null },
          raw: { global: raw(f.global), project: raw(f.project) },
          groups: settingsView(f, env(), home(), cfg.root),
          apiKeys: API_KEY_VARS.map((k) => ({ ...k, set: !!env()[k.name] })),
          sources: cfg.sources,
          envOverrides: envOverrides(f, env(), home()),
          // the configured brand does not exist under this root: renders fall back to neutral (R2-8)
          brandMissing: (() => {
            const b = effectiveBrand(cfg.root, cfg.brand);
            return b.fellBackFrom ? { name: b.fellBackFrom, used: b.name, root: cfg.root } : null;
          })(),
        };
      },
    },
    post: {
      /** Two-phase set/unset: without confirm → the diff (+ shadowing); with confirm → write. */
      "config-set": (body) => {
        const key = body.key;
        if (typeof key !== "string" || !key) throw new Error('"key" is required');
        const scope = scopeOf(body);
        if (scope === "project" && key === "root")
          throw new Error('"root" can only be set globally (it decides where projects live)');
        const unset = body.unset === true;
        if (!unset && body.value === undefined)
          throw new Error('"value" is required (or "unset": true)');
        const value = unset
          ? undefined
          : typeof body.value === "string"
            ? parseValue(body.value)
            : body.value;
        const change = planChange(files(), scope, key, value, { env: env(), home: home(), unset });
        if (body.confirm !== true)
          return {
            planned: true,
            file: change.file,
            diff: change.diff,
            effective: change.effective ?? null,
            shadowedBy: change.shadowedBy ?? null,
          };
        applyChange(change);
        deps.reloadConfig();
        const slug = deps.activeProject()?.slug;
        deps.publish(
          "config.changed",
          {
            key,
            scope,
            by: "panel",
            file: change.file,
            before: change.before ?? null,
            after: change.after ?? null,
            effective: change.effective ?? null,
            ...(change.shadowedBy ? { shadowedBy: change.shadowedBy } : {}),
            message: `${key}: ${fmtVal(change.before)} → ${unset ? "unset" : fmtVal(change.after)} (${scope})`,
          },
          slug,
        );
        return { saved: true, file: change.file, effective: change.effective ?? null };
      },
      /**
       * Several changes at once (the panel stages edits and saves them together): without confirm → one diff per
       * file and what each change does; with confirm → one write per file. All of them are validated first; if one
       * is rejected nothing is written and the error names the setting.
       */
      "config-batch": (body) => {
        const raw = body.changes;
        if (!Array.isArray(raw) || !raw.length)
          throw new Error('"changes" must be a non-empty list');
        const items: BatchItem[] = raw.map((c, i) => {
          const o = (c ?? {}) as Record<string, unknown>;
          if (typeof o.key !== "string" || !o.key)
            throw new Error(`change ${i + 1}: "key" is required`);
          const unset = o.unset === true;
          if (!unset && o.value === undefined)
            throw new Error(`${o.key}: "value" is required (or "unset": true)`);
          return {
            key: o.key,
            scope: scopeOf(o),
            unset,
            ...(unset
              ? {}
              : { value: typeof o.value === "string" ? parseValue(o.value) : o.value }),
          };
        });
        const plan = planBatch(files(), items, { env: env(), home: home() });
        if (body.confirm !== true)
          return {
            planned: true,
            files: plan.files.map(({ file, scope, diff }) => ({ file, scope, diff })),
            changes: plan.changes.map((c) => ({
              key: c.key,
              scope: c.scope,
              before: c.before ?? null,
              after: c.after ?? null,
              effective: c.effective ?? null,
              shadowedBy: c.shadowedBy ?? null,
            })),
          };
        applyBatch(plan);
        deps.reloadConfig();
        const slug = deps.activeProject()?.slug;
        const fileOf = (scope: Scope) => plan.files.find((f) => f.scope === scope)?.file;
        for (const c of plan.changes)
          deps.publish(
            "config.changed",
            {
              key: c.key,
              scope: c.scope,
              by: "panel",
              file: fileOf(c.scope),
              before: c.before ?? null,
              after: c.after ?? null,
              effective: c.effective ?? null,
              ...(c.shadowedBy ? { shadowedBy: c.shadowedBy } : {}),
              message: `${c.key}: ${fmtVal(c.before)} → ${c.after === undefined ? "unset" : fmtVal(c.after)} (${c.scope})`,
            },
            slug,
          );
        return { saved: true, count: plan.changes.length, files: plan.files.map((f) => f.file) };
      },
      /** Open the global or project config file in the default editor (created as {} if missing). */
      "config-open": (body) => {
        const f = files();
        const file = scopeOf(body) === "project" ? f.project : f.global;
        if (!file) throw new Error("no active project");
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, "{}\n");
        }
        return { opened: openInEditor(file), file };
      },
      /** Re-read the config files (after editing them by hand). */
      "config-reload": () => {
        const cfg = deps.reloadConfig();
        deps.publish("config.changed", { message: "config reloaded" }, deps.activeProject()?.slug);
        return { sources: cfg.sources };
      },
    },
  };
}

/** A config value for a log line: short JSON, cut at 60 characters (the event keeps it whole). */
function fmtVal(v: unknown): string {
  if (v === undefined) return "unset";
  const j = JSON.stringify(v) ?? String(v);
  return j.length > 60 ? `${j.slice(0, 59)}…` : j;
}
