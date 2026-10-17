/**
 * Environment overrides in effect (P1a, F12): what `DEMO_REC_*` variables change, what they hide,
 * and which test switches are on. One list, used by `/demo doctor`, the notice when a project opens,
 * the panel's Config screen and `/api/state`.
 *
 * Why: in the first real run a variable set for a test silently won over the user's config file,
 * and nothing said so.
 */

import { ENV_KEYS, type LayerFiles, getPath } from "./config-edit.ts";
import { type DemoRecConfig, resolveConfig } from "./config.ts";

export interface EnvOverride {
  variable: string;
  /** The setting it overrides, or what the switch does. */
  what: string;
  /** What it is set to (never a key: these are settings and switches only). */
  value: string;
  /** The value that would apply without it (from the files or the defaults), when it differs. */
  hides?: string;
  /** A test switch: it silently removes behaviour, so it is warned about more strongly. */
  strong: boolean;
}

/** Variables that are switches, not settings. */
const SWITCHES: { variable: string; what: string; strong: boolean }[] = [
  {
    variable: "DEMO_REC_CONFIG",
    what: "the config file is read from here instead of ~/.config/demo-recording/config.json",
    strong: false,
  },
  {
    variable: "DEMO_REC_NO_OPEN",
    what: "the panel is never opened in your browser",
    strong: true,
  },
  {
    variable: "DEMO_REC_NO_VOICE_LIST",
    what: "the voice picker never lists your ElevenLabs voices",
    strong: true,
  },
];

const show = (v: unknown): string =>
  v === undefined || v === null || v === ""
    ? "(not set)"
    : typeof v === "string"
      ? v
      : JSON.stringify(v);

/** Every override in effect, settings first, then switches. */
export function envOverrides(
  files: LayerFiles,
  env: NodeJS.ProcessEnv,
  home: string,
): EnvOverride[] {
  const out: EnvOverride[] = [];
  const set = Object.entries(ENV_KEYS).filter(([, variable]) => env[variable]);
  if (set.length) {
    const withEnv = resolveConfig({
      env,
      home,
      ...(files.project ? { projectConfigFile: files.project } : {}),
    });
    // the same, with the setting variables removed: what the files and defaults would give
    const bare: NodeJS.ProcessEnv = { ...env };
    for (const variable of Object.values(ENV_KEYS)) Reflect.deleteProperty(bare, variable);
    const without = resolveConfig({
      env: bare,
      home,
      ...(files.project ? { projectConfigFile: files.project } : {}),
    });
    for (const [key, variable] of set) {
      const now = show(getPath(withEnv as DemoRecConfig, key));
      const then = show(getPath(without as DemoRecConfig, key));
      out.push({
        variable,
        what: key,
        value: now,
        ...(then !== now ? { hides: then } : {}),
        strong: false,
      });
    }
  }
  for (const s of SWITCHES) {
    const value = env[s.variable];
    if (value) out.push({ variable: s.variable, what: s.what, value, strong: s.strong });
  }
  return out;
}

/** One line per override, for chat and the doctor. */
export function formatOverride(o: EnvOverride): string {
  return o.variable === "DEMO_REC_CONFIG" || o.strong
    ? `${o.variable}=${o.value}: ${o.what}${o.strong ? " (a test switch)" : ""}`
    : `${o.variable}=${o.value}: overrides ${o.what}${o.hides !== undefined ? `, hiding ${o.hides}` : " (same as the file or default)"}`;
}

/** The notice shown when a project opens; undefined when nothing is overridden. */
export function envNotice(list: EnvOverride[]): string | undefined {
  if (!list.length) return undefined;
  return [
    `⚠ ${list.length} environment override(s) in effect, they win over your config file:`,
    ...list.map((o) => `  ${o.strong ? "‼" : "•"} ${formatOverride(o)}`),
    "  (/demo doctor lists them too; unset a variable to get the file's value back)",
  ].join("\n");
}
