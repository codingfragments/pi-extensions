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
export function writeVo(
  projectDir: string,
  text: string,
  opts: { base?: number; panelEdit?: boolean } = {},
): StoredVo {
  const normalized = `${text.trim()}\n`;
  const validated = validate(projectDir, normalized);
  const errors = validated.issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new Error(
      `voice-over not stored — fix these:\n${errors.map((e) => `- ${e.section}: ${e.message}`).join("\n")}`,
    );
  }
  const stored = writeNextVersion(voDir(projectDir), "script.v", ".md", normalized);
  // A pending panel direction (D82/D83) is consumed by the next written version.
  const pending = opts.panelEdit ? undefined : readPendingDirection(projectDir);
  const base = opts.base ?? pending?.base;
  if (base !== undefined || pending)
    writeVoMeta(projectDir, stored.version, {
      ...(base !== undefined ? { base } : {}),
      ...(pending ? { direction: pending.direction } : {}),
    });
  if (pending) clearPendingDirection(projectDir);
  return { version: stored.version, file: stored.file, text: normalized, validated };
}

/** The script text with one section's body replaced (pure). Throws when the section is not in it. */
export function replaceVoSection(
  text: string,
  key: string,
  body: string,
  label = "this version",
): string {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) =>
      l.startsWith("## ") &&
      l
        .slice(3)
        .split(/\s+—\s+|\s+-\s+/)[0]
        ?.trim() === key,
  );
  if (start < 0) throw new Error(`section "${key}" is not in ${label}`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start + 1), body.trim(), "", ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
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
  return writeVo(projectDir, replaceVoSection(current.text, key, body, `v${version}`), {
    base: version,
    panelEdit: true,
  });
}

/**
 * What a version was drafted from (D83): `vo/script.vN.meta.json`. Written
 * when the agent rewrites the script after a panel direction (the pending
 * direction names the base) or when the tool is given a base.
 */
export interface VoMeta {
  base?: number;
  direction?: VoDirection;
}

/** A panel direction for the next version (D82). */
export interface VoDirection {
  stance?: string;
  tone?: string;
  length?: string;
  focus?: string;
  notes?: string;
}

const metaFile = (projectDir: string, v: number) =>
  path.join(voDir(projectDir), `script.v${v}.meta.json`);
const pendingFile = (projectDir: string) => path.join(voDir(projectDir), "direction.pending.json");

export function readVoMeta(projectDir: string, v: number): VoMeta | undefined {
  const f = metaFile(projectDir, v);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as VoMeta) : undefined;
}

export function writeVoMeta(projectDir: string, v: number, meta: VoMeta): void {
  fs.writeFileSync(metaFile(projectDir, v), `${JSON.stringify(meta, null, 2)}\n`);
}

/** The direction the panel sent, waiting for the agent's next version. */
export function readPendingDirection(
  projectDir: string,
): { base: number; direction: VoDirection; at: string } | undefined {
  const f = pendingFile(projectDir);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined;
}

export function writePendingDirection(
  projectDir: string,
  base: number,
  direction: VoDirection,
): void {
  fs.mkdirSync(voDir(projectDir), { recursive: true });
  fs.writeFileSync(
    pendingFile(projectDir),
    `${JSON.stringify({ base, direction, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

export function clearPendingDirection(projectDir: string): void {
  fs.rmSync(pendingFile(projectDir), { force: true });
}
