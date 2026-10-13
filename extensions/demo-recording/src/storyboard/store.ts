/**
 * Storyboard persistence: `projects/<p>/storyboard/vN.yaml`, immutable.
 * The engine assigns N; the stored YAML is rewritten with `version: N` while
 * preserving the author's comments and layout (yaml Document API).
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { latestVersion, listVersions, writeNextVersion } from "../workdir/versioning.ts";
import { type StoryboardDiff, diffStoryboards } from "./diff.ts";
import { parseStoryboard } from "./parse.ts";
import type { Storyboard } from "./types.ts";

export const storyboardDir = (projectDir: string) => path.join(projectDir, "storyboard");

export interface StoredStoryboard {
  version: number;
  file: string;
  text: string;
  storyboard: Storyboard;
}

export function storyboardVersions(projectDir: string): number[] {
  return listVersions(storyboardDir(projectDir), "v", ".yaml");
}

export function readStoryboard(projectDir: string, version?: number): StoredStoryboard | undefined {
  const v = version ?? latestVersion(storyboardDir(projectDir), "v", ".yaml");
  if (v === undefined) return undefined;
  const file = path.join(storyboardDir(projectDir), `v${v}.yaml`);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  return { version: v, file, text, storyboard: parseStoryboard(text, { version: v }) };
}

/** Set/replace the top-level `version:` in YAML text, keeping comments. */
export function withVersion(text: string, version: number): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`storyboard: invalid YAML (${doc.errors[0]?.message})`);
  doc.set("version", version);
  return doc.toString();
}

export interface WriteResult extends StoredStoryboard {
  diff?: StoryboardDiff;
}

/**
 * Validate and store YAML as the next version. Validation happens before
 * anything is written, so an invalid storyboard never consumes a version.
 */
export function writeStoryboard(projectDir: string, yamlText: string): WriteResult {
  const dir = storyboardDir(projectDir);
  const next = (latestVersion(dir, "v", ".yaml") ?? 0) + 1;
  parseStoryboard(yamlText, { version: next }); // throws with a precise path on error
  const previous = readStoryboard(projectDir);
  const stored = writeNextVersion(dir, "v", ".yaml", withVersion(yamlText, next));
  const text = fs.readFileSync(stored.file, "utf8");
  const storyboard = parseStoryboard(text, { version: stored.version });
  const result: WriteResult = { version: stored.version, file: stored.file, text, storyboard };
  if (previous) result.diff = diffStoryboards(previous.storyboard, storyboard);
  return result;
}
