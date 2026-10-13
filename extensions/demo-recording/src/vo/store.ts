/**
 * Voice-over persistence: `projects/<p>/vo/script.vN.md`, immutable, validated
 * against the take analysis before a version is consumed.
 */

import fs from "node:fs";
import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import { latestVersion, listVersions, writeNextVersion } from "../workdir/versioning.ts";
import { type ValidatedVo, parseVo, validateVo } from "./script.ts";

export const voDir = (projectDir: string) => path.join(projectDir, "vo");

export interface StoredVo {
  version: number;
  file: string;
  text: string;
  validated: ValidatedVo;
}

export function voVersions(projectDir: string): number[] {
  return listVersions(voDir(projectDir), "script.v", ".md");
}

function validate(projectDir: string, text: string): ValidatedVo {
  const script = parseVo(text);
  const takeDir = path.join(projectDir, "takes", script.take);
  const analysis = readAnalysis(takeDir);
  if (!analysis)
    throw new Error(`${script.take} has not been analyzed — run demo_rec_take analyze first`);
  return validateVo(script, analysis, path.join(takeDir, "dom"));
}

export function readVo(projectDir: string, version?: number): StoredVo | undefined {
  const v = version ?? latestVersion(voDir(projectDir), "script.v", ".md");
  if (v === undefined) return undefined;
  const file = path.join(voDir(projectDir), `script.v${v}.md`);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  return { version: v, file, text, validated: validate(projectDir, text) };
}

/** Validate, then store as the next version. Errors never consume a version. */
export function writeVo(projectDir: string, text: string): StoredVo {
  const normalized = `${text.trim()}\n`;
  const validated = validate(projectDir, normalized);
  const errors = validated.issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new Error(
      `voice-over not stored — fix these:\n${errors.map((e) => `- ${e.section}: ${e.message}`).join("\n")}`,
    );
  }
  const stored = writeNextVersion(voDir(projectDir), "script.v", ".md", normalized);
  return { version: stored.version, file: stored.file, text: normalized, validated };
}

/** Replace one section's body (panel inline edit) and store as a new version. */
export function editVoSection(
  projectDir: string,
  version: number,
  key: string,
  body: string,
): StoredVo {
  const current = readVo(projectDir, version);
  if (!current) throw new Error(`voice-over v${version} does not exist`);
  const lines = current.text.split("\n");
  const start = lines.findIndex(
    (l) =>
      l.startsWith("## ") &&
      l
        .slice(3)
        .split(/\s+—\s+|\s+-\s+/)[0]
        ?.trim() === key,
  );
  if (start < 0) throw new Error(`section "${key}" is not in v${version}`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const next = [...lines.slice(0, start + 1), body.trim(), "", ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return writeVo(projectDir, next);
}
