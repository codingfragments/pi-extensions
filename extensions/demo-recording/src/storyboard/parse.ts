/**
 * Storyboard YAML → typed Storyboard, with path-precise error messages.
 * (S1 subset; S2 swaps this for a typebox schema with the same output types.)
 */

import { parse as parseYaml } from "yaml";
import { parseDuration } from "../util/duration.ts";
import type { Scene, Step, Storyboard, Target, WaitFor } from "./types.ts";

class StoryboardError extends Error {}

const fail = (path: string, msg: string): never => {
  throw new StoryboardError(`storyboard ${path}: ${msg}`);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function str(o: Obj, key: string, path: string, required = true): string | undefined {
  const v = o[key];
  if (v === undefined) {
    if (required) fail(`${path}.${key}`, "is required");
    return undefined;
  }
  if (typeof v !== "string" || !v.trim())
    return fail(`${path}.${key}`, "must be a non-empty string");
  return v;
}

export function parseTarget(v: unknown, path: string): Target {
  if (!isObj(v))
    return fail(path, "target must be an object like {role, name} | {text} | {label} | {css}");
  const exact = v.exact === undefined ? undefined : Boolean(v.exact);
  if (typeof v.role === "string") {
    const name = str(v, "name", path, false);
    return { role: v.role, ...(name ? { name } : {}), ...(exact !== undefined ? { exact } : {}) };
  }
  if (typeof v.text === "string")
    return { text: v.text, ...(exact !== undefined ? { exact } : {}) };
  if (typeof v.label === "string") return { label: v.label };
  if (typeof v.css === "string") return { css: v.css };
  return fail(path, "target needs one of: role, text, label, css");
}

function parseWaitFor(v: unknown, path: string): WaitFor {
  if (isObj(v) && v.ms !== undefined) return { ms: parseDuration(v.ms, `${path}.ms`) };
  return parseTarget(v, path);
}

const STEP_KINDS = [
  "goto",
  "move",
  "hover",
  "click",
  "type",
  "press",
  "wait",
  "pause",
  "scroll",
  "improvise",
] as const;

function parseStep(v: unknown, path: string): Step {
  if (!isObj(v)) return fail(path, "step must be an object");
  const kind = v.do;
  if (typeof kind !== "string" || !(STEP_KINDS as readonly string[]).includes(kind)) {
    return fail(
      `${path}.do`,
      `must be one of ${STEP_KINDS.join(", ")} (got ${JSON.stringify(kind)})`,
    );
  }
  const base: { mark?: string; dwell?: number; zoom?: boolean; callout?: string } = {};
  const mark = str(v, "mark", path, false);
  if (mark) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(mark))
      fail(`${path}.mark`, "must be kebab-case (a-z, 0-9, -)");
    base.mark = mark;
  }
  if (v.dwell !== undefined) base.dwell = parseDuration(v.dwell, `${path}.dwell`);
  if (v.zoom !== undefined) {
    if (typeof v.zoom !== "boolean") fail(`${path}.zoom`, "must be true or false");
    if (v.zoom) base.zoom = true;
  }
  const callout = str(v, "callout", path, false);
  if (callout) {
    if (callout.length > 60)
      fail(
        `${path}.callout`,
        "keep callouts short (≤ 60 chars) — they mark steps, they don't narrate",
      );
    base.callout = callout;
  }

  switch (kind) {
    case "goto":
      return { ...base, do: "goto", url: str(v, "url", path) as string };
    case "move":
    case "hover":
    case "click":
      return { ...base, do: kind, target: parseTarget(v.target, `${path}.target`) };
    case "type": {
      const text = v.text;
      if (typeof text !== "string" || !text) return fail(`${path}.text`, "is required");
      return {
        ...base,
        do: "type",
        text,
        ...(v.target !== undefined ? { target: parseTarget(v.target, `${path}.target`) } : {}),
        ...(v.clear !== undefined ? { clear: Boolean(v.clear) } : {}),
      };
    }
    case "press":
      return { ...base, do: "press", key: str(v, "key", path) as string };
    case "wait":
      return {
        ...base,
        do: "wait",
        for: parseWaitFor(v.for, `${path}.for`),
        timeout: v.timeout === undefined ? 15000 : parseDuration(v.timeout, `${path}.timeout`),
      };
    case "scroll": {
      if (v.target === undefined && v.dy === undefined)
        return fail(path, "scroll needs a target (scroll into view) or dy (pixels)");
      if (v.dy !== undefined && (typeof v.dy !== "number" || !Number.isFinite(v.dy)))
        return fail(`${path}.dy`, "must be a number of pixels");
      return {
        ...base,
        do: "scroll",
        ...(v.target !== undefined ? { target: parseTarget(v.target, `${path}.target`) } : {}),
        ...(typeof v.dy === "number" ? { dy: v.dy } : {}),
      };
    }
    case "improvise": {
      if (v.kind !== "type")
        return fail(
          `${path}.kind`,
          'only "type" is supported (invent an input from the live screen)',
        );
      const prompt = str(v, "prompt", path) as string;
      const max = v.max_chars === undefined ? 80 : v.max_chars;
      if (typeof max !== "number" || !Number.isInteger(max) || max < 5 || max > 400)
        return fail(`${path}.max_chars`, "must be an integer 5..400");
      return {
        ...base,
        do: "improvise",
        kind: "type",
        target: parseTarget(v.target, `${path}.target`),
        prompt,
        max_chars: max,
        submit: v.submit === undefined ? true : Boolean(v.submit),
      };
    }
    default:
      return { ...base, do: "pause", ms: parseDuration(v.ms, `${path}.ms`) };
  }
}

function parseScene(v: unknown, path: string): Scene {
  if (!isObj(v)) return fail(path, "scene must be an object");
  const id = str(v, "id", path) as string;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`${path}.id`, "must be kebab-case, e.g. 03-search");
  if (!Array.isArray(v.steps) || v.steps.length === 0)
    fail(`${path}.steps`, "must be a non-empty list");
  const scene: Scene = {
    id,
    title: str(v, "title", path) as string,
    steps: (v.steps as unknown[]).map((s, i) => parseStep(s, `${path}.steps[${i}]`)),
  };
  for (const key of ["takeaway", "deep_link", "narration"] as const) {
    const value = str(v, key, path, false);
    if (value) scene[key] = value;
  }
  const screen = str(v, "screen", path, false);
  if (screen) {
    if (!/^\d{8}-\d{6}\/s\d{3,}$/.test(screen))
      fail(`${path}.screen`, 'must be a discovery screen id like "20260612-101233/s007"');
    scene.screen = screen;
  }
  if (v.narration_outline !== undefined) {
    if (
      !Array.isArray(v.narration_outline) ||
      v.narration_outline.some((x) => typeof x !== "string" || !x.trim())
    ) {
      fail(`${path}.narration_outline`, "must be a list of non-empty strings");
    }
    scene.narration_outline = v.narration_outline as string[];
  }
  return scene;
}

/**
 * Parse storyboard YAML. `version` may be omitted when the engine assigns it
 * (`demo_rec_storyboard write` stores the next version and injects it).
 */
export function parseStoryboard(text: string, opts: { version?: number } = {}): Storyboard {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new StoryboardError(`storyboard: invalid YAML (${(err as Error).message})`);
  }
  if (!isObj(raw)) return fail("(root)", "must be a mapping");
  const version = opts.version ?? raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    fail("version", "must be a positive integer");
  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0)
    fail("scenes", "must be a non-empty list");
  const scenes = (raw.scenes as unknown[]).map((s, i) => parseScene(s, `scenes[${i}]`));

  const ids = new Set<string>();
  const marks = new Set<string>();
  scenes.forEach((scene, i) => {
    if (ids.has(scene.id)) fail(`scenes[${i}].id`, `duplicate scene id "${scene.id}"`);
    ids.add(scene.id);
    scene.steps.forEach((step, j) => {
      if (!step.mark) return;
      if (marks.has(step.mark))
        fail(
          `scenes[${i}].steps[${j}].mark`,
          `duplicate mark "${step.mark}" (marks are take-wide anchors)`,
        );
      marks.add(step.mark);
    });
  });

  const app = str(raw, "app", "(root)", false);
  const summary = str(raw, "summary", "(root)", false);
  return {
    version: version as number,
    ...(app ? { app } : {}),
    ...(summary ? { summary } : {}),
    start_url: str(raw, "start_url", "(root)") as string,
    scenes,
  };
}
