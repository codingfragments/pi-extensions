/**
 * Timestamped notes on a take (item 7c, D-R2-10): what you notice while you watch the raw recording, each pinned to a
 * moment on the take clock and to the scene it falls in. They are review input: nothing is sent as you type. "Request a
 * new take" bundles every open note of the storyboard's takes into the Director's message and marks them sent, so a
 * note is never sent twice. Stored per take in `takes/<take>/notes.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../workdir/versioning.ts";

export interface TakeNote {
  id: string;
  /** Take clock, ms: where in the raw video the note belongs. */
  t: number;
  /** The scene the moment falls in, when known. */
  scene?: string;
  text: string;
  at: string;
  /** Set when a take request carried the note. */
  sent?: { at: string; storyboard: number };
}

export const MAX_NOTE = 1000;
const TAKE_ID = /^take-\d{3,}$/;

const fileOf = (projectDir: string, take: string) => {
  if (!TAKE_ID.test(take)) throw new Error(`"${take}" is not a take id`);
  const dir = path.join(projectDir, "takes", take);
  if (!fs.existsSync(dir)) throw new Error(`there is no ${take} in this project`);
  return path.join(dir, "notes.json");
};

export function readNotes(projectDir: string, take: string): TakeNote[] {
  const file = fileOf(projectDir, take);
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8")) as TakeNote[];
    return Array.isArray(list)
      ? [...list].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
      : [];
  } catch {
    return [];
  }
}

function save(projectDir: string, take: string, list: TakeNote[]): void {
  writeFileAtomic(fileOf(projectDir, take), `${JSON.stringify(list, null, 2)}\n`);
}

function cleanText(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new Error("a note needs text");
  if (t.length > MAX_NOTE) throw new Error(`keep a note to ${MAX_NOTE} characters`);
  return t;
}

export function addNote(
  projectDir: string,
  take: string,
  n: { t: number; scene?: string; text: string },
  now = new Date(),
): TakeNote {
  if (typeof n.t !== "number" || !Number.isFinite(n.t) || n.t < 0)
    throw new Error("a note needs a time (ms, 0 or more)");
  const text = cleanText(n.text);
  const list = readNotes(projectDir, take);
  const next = list.reduce((m, x) => Math.max(m, Number(x.id.replace(/\D/g, "")) || 0), 0) + 1;
  const note: TakeNote = {
    id: `n-${String(next).padStart(3, "0")}`,
    t: Math.round(n.t),
    ...(n.scene ? { scene: n.scene } : {}),
    text,
    at: now.toISOString(),
  };
  save(projectDir, take, [...list, note]);
  return note;
}

export function editNote(projectDir: string, take: string, id: string, text: unknown): TakeNote {
  const list = readNotes(projectDir, take);
  const note = list.find((x) => x.id === id);
  if (!note) throw new Error(`no note ${id} on ${take}`);
  if (note.sent)
    throw new Error("this note was already sent with a take request: it is a record now");
  note.text = cleanText(text);
  save(projectDir, take, list);
  return note;
}

/** Remove a note and hand it back (the panel's Undo puts it back as it was). */
export function deleteNote(projectDir: string, take: string, id: string): TakeNote {
  const list = readNotes(projectDir, take);
  const note = list.find((x) => x.id === id);
  if (!note) throw new Error(`no note ${id} on ${take}`);
  save(
    projectDir,
    take,
    list.filter((x) => x.id !== id),
  );
  return note;
}

/** Put a deleted note back with its own id, time, text and state (no new id: nothing else was renumbered). */
export function restoreNote(projectDir: string, take: string, note: TakeNote): TakeNote {
  const list = readNotes(projectDir, take);
  if (list.some((x) => x.id === note.id)) return list.find((x) => x.id === note.id) as TakeNote;
  const clean: TakeNote = {
    id: String(note.id),
    t: Math.round(note.t),
    ...(note.scene ? { scene: String(note.scene) } : {}),
    text: cleanText(note.text),
    at: String(note.at ?? new Date().toISOString()),
    ...(note.sent ? { sent: note.sent } : {}),
  };
  save(projectDir, take, [...list, clean]);
  return clean;
}

export interface OpenNote extends TakeNote {
  take: string;
}

/** The notes of these takes that no request carried yet, oldest take first. */
export function openNotes(projectDir: string, takes: string[]): OpenNote[] {
  return takes.flatMap((take) =>
    readNotes(projectDir, take)
      .filter((n) => !n.sent)
      .map((n) => ({ ...n, take })),
  );
}

export function markSent(
  projectDir: string,
  notes: OpenNote[],
  storyboard: number,
  now = new Date(),
): void {
  for (const take of new Set(notes.map((n) => n.take))) {
    const ids = new Set(notes.filter((n) => n.take === take).map((n) => n.id));
    const list = readNotes(projectDir, take).map((n) =>
      ids.has(n.id) ? { ...n, sent: { at: now.toISOString(), storyboard } } : n,
    );
    save(projectDir, take, list);
  }
}

const clock = (ms: number) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

/** One line per note for the Director: which take, which moment, which scene, what was noticed. */
export function formatNotes(notes: OpenNote[]): string {
  return notes
    .map(
      (n) =>
        `- ${n.take} ${clock(n.t)}${n.scene ? ` · ${n.scene}` : ""}: ${n.text.replace(/\s*\n\s*/g, " ⏎ ")}`,
    )
    .join("\n");
}
