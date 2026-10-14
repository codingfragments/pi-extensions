/**
 * Project input log (`inputs.jsonl`, S5 part 3, D42/D43): every directional
 * input that shaped the project, so the project's memory survives the chat.
 *
 * Append-only. An entry is never edited or deleted; "mark outdated" appends a
 * mark line (`{"mark": id, ...}`) and readers fold marks onto their entries.
 * The agent reads the non-outdated entries (`demo_rec_project context`); the
 * panel's Project context view shows all of them.
 */

import fs from "node:fs";
import path from "node:path";
import type { Stage } from "./stages.ts";

export const INPUT_FILE = "inputs.jsonl";

export type InputSource = "command" | "panel" | "chat" | "agent";
export type InputKind = "brief" | "direction" | "review" | "nudge" | "asset" | "source";
/** A stage, or one of the pre-stage areas. */
export type InputStage = Stage | "brief" | "discovery" | "project";

export const INPUT_SOURCES: readonly InputSource[] = ["command", "panel", "chat", "agent"];
export const INPUT_KINDS: readonly InputKind[] = [
  "brief",
  "direction",
  "review",
  "nudge",
  "asset",
  "source",
];
export const INPUT_STAGES: readonly InputStage[] = [
  "project",
  "brief",
  "discovery",
  "storyboard",
  "recording",
  "vo",
  "annotations",
  "render",
];

export interface InputEntry {
  id: string;
  at: string;
  stage: InputStage;
  version?: number;
  source: InputSource;
  kind: InputKind;
  text: string;
  /** Project-relative files or URLs this input refers to. */
  refs?: string[];
  outdated?: { at: string; reason: string };
}

interface MarkLine {
  mark: string;
  at: string;
  outdated: boolean;
  reason?: string;
}

const MAX_TEXT = 4000;

function lines(projectDir: string): (InputEntry | MarkLine)[] {
  const file = path.join(projectDir, INPUT_FILE);
  if (!fs.existsSync(file)) return [];
  const out: (InputEntry | MarkLine)[] = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as InputEntry | MarkLine);
    } catch {
      // A torn last line (crash mid-write) must not hide the rest of the log.
    }
  }
  return out;
}

function append(projectDir: string, line: InputEntry | MarkLine): void {
  const file = path.join(projectDir, INPUT_FILE);
  // After a torn last line (crash mid-write), start on a fresh line so the new
  // entry isn't glued onto the broken one.
  let sep = "";
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      fs.closeSync(fd);
      if (last[0] !== 0x0a) sep = "\n";
    }
  }
  fs.appendFileSync(file, `${sep}${JSON.stringify(line)}\n`);
}

/** All entries, oldest first, with marks applied. */
export function readInputs(
  projectDir: string,
  opts: { includeOutdated?: boolean } = {},
): InputEntry[] {
  const entries = new Map<string, InputEntry>();
  for (const l of lines(projectDir)) {
    if ("mark" in l) {
      const e = entries.get(l.mark);
      if (!e) continue;
      if (l.outdated) e.outdated = { at: l.at, reason: l.reason ?? "" };
      else {
        const { outdated: _drop, ...rest } = e;
        entries.set(l.mark, rest);
      }
    } else entries.set(l.id, { ...l });
  }
  const all = [...entries.values()];
  return opts.includeOutdated ? all : all.filter((e) => !e.outdated);
}

export interface NewInput {
  stage: InputStage;
  version?: number;
  source: InputSource;
  kind: InputKind;
  text: string;
  refs?: string[];
  /** Override the timestamp (migration of older notes). */
  at?: string;
}

/** Record one input. Empty text is ignored (returns undefined). */
export function recordInput(
  projectDir: string,
  input: NewInput,
  now = new Date(),
): InputEntry | undefined {
  const text = input.text.trim();
  if (!text) return undefined;
  if (!INPUT_STAGES.includes(input.stage)) throw new Error(`unknown input stage "${input.stage}"`);
  if (!INPUT_SOURCES.includes(input.source))
    throw new Error(`unknown input source "${input.source}"`);
  if (!INPUT_KINDS.includes(input.kind)) throw new Error(`unknown input kind "${input.kind}"`);
  const n = lines(projectDir).filter((l) => !("mark" in l)).length + 1;
  const entry: InputEntry = {
    id: `in-${String(n).padStart(4, "0")}`,
    at: input.at ?? now.toISOString(),
    stage: input.stage,
    ...(input.version !== undefined ? { version: input.version } : {}),
    source: input.source,
    kind: input.kind,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    ...(input.refs?.length ? { refs: input.refs } : {}),
  };
  append(projectDir, entry);
  return entry;
}

/** Mark an entry outdated (with a reason) or restore it. Never edits the entry itself. */
export function markInput(
  projectDir: string,
  id: string,
  outdated: boolean,
  reason = "",
  now = new Date(),
): InputEntry {
  const e = readInputs(projectDir, { includeOutdated: true }).find((x) => x.id === id);
  if (!e) throw new Error(`no input ${id} in this project`);
  if (outdated && !reason.trim()) throw new Error("marking an input outdated needs a reason");
  append(projectDir, {
    mark: id,
    at: now.toISOString(),
    outdated,
    ...(outdated ? { reason: reason.trim() } : {}),
  });
  return readInputs(projectDir, { includeOutdated: true }).find((x) => x.id === id) as InputEntry;
}

/** The project's memory for the agent: non-outdated entries, newest first, grouped by stage. */
export function formatInputs(entries: InputEntry[], opts: { max?: number } = {}): string {
  if (!entries.length) return "(no recorded inputs yet)";
  const order: InputStage[] = [...INPUT_STAGES];
  const newest = [...entries].reverse().slice(0, opts.max ?? 200);
  const out: string[] = [];
  for (const stage of order) {
    const group = newest.filter((e) => e.stage === stage);
    if (!group.length) continue;
    out.push(`[${stage}]`);
    for (const e of group)
      out.push(
        `- ${e.id} ${e.at.slice(0, 16).replace("T", " ")} ${e.kind}/${e.source}${e.version !== undefined ? ` v${e.version}` : ""}: ${e.text.replace(/\s*\n\s*/g, " ⏎ ")}${e.refs?.length ? ` (refs: ${e.refs.join(", ")})` : ""}${e.outdated ? ` [OUTDATED: ${e.outdated.reason}]` : ""}`,
      );
  }
  return out.join("\n");
}
