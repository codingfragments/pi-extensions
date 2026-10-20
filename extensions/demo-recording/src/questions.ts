/**
 * Pending questions (item 11, P4, A4; F18; D140 to D143). When the Director needs a decision from you it ASKS: the engine stores a
 * question (who asks, what, 2 to 4 options with a number and a word each) and the Director STOPS. You answer in the panel (and, from 11b, in
 * the chat); whichever place answers, the question is resolved exactly once, and the engine wakes the Director with your answer as a new
 * message. Nothing waits inside a tool: the question lives in the project, so it survives a restart of pi.
 *
 * Only the Director's own asks are questions (the Allow for a take or a voice, and the new questions it asks with `demo_rec_ask`).
 * Approving, Use, replacing a verdict and the other gates stay panel actions: no answer here approves anything.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./workdir/versioning.ts";

/** The cast that can ask (ACTORS.md): model roles, played by the same session model. */
export const ROLES = [
  "Director",
  "Researcher",
  "Storyboard writer",
  "Operator",
  "Voice writer",
  "Annotation designer",
  "Brand designer",
] as const;
export type Role = (typeof ROLES)[number];

export const LIMITS = {
  what: 300,
  why: 300,
  label: 60,
  options: [2, 4] as [number, number],
  /** More than this waiting at once is a Director that does not stop: refuse. */
  pending: 3,
};

export interface QuestionOption {
  /** "1" … "4": what you type in the chat. */
  key: string;
  /** The first word of the label, lower case: the other thing you may type. */
  word: string;
  label: string;
}

export interface Question {
  id: string;
  at: string;
  role: Role;
  what: string;
  why?: string;
  options: QuestionOption[];
  status: "pending" | "answered" | "cancelled";
  answer?: { key: string; word: string; label: string; by: "panel" | "chat"; at: string };
  cancelled?: { why: string; at: string };
}

const file = (projectDir: string) => path.join(projectDir, "questions.json");

export function readQuestions(projectDir: string): Question[] {
  try {
    const list = JSON.parse(fs.readFileSync(file(projectDir), "utf8")) as Question[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const save = (projectDir: string, list: Question[]) =>
  writeFileAtomic(file(projectDir), `${JSON.stringify(list, null, 2)}\n`);

export const pendingQuestions = (projectDir: string): Question[] =>
  readQuestions(projectDir).filter((q) => q.status === "pending");

/** The word you may type for an option: the first letters-only word of its label, lower case. */
export function wordOf(label: string): string {
  const m = /[\p{L}\p{N}][\p{L}\p{N}'-]*/u.exec(label.trim());
  return (m?.[0] ?? "").toLowerCase();
}

const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** Ask: validate, number the options, store. Throws with every problem at once. */
export function askQuestion(
  projectDir: string,
  q: { role?: unknown; what?: unknown; why?: unknown; options?: unknown },
  now = new Date(),
): Question {
  const problems: string[] = [];
  const role = (q.role === undefined || q.role === "" ? "Director" : q.role) as Role;
  if (!(ROLES as readonly string[]).includes(role))
    problems.push(`role must be one of: ${ROLES.join(", ")}`);
  const what = text(q.what);
  if (!what)
    problems.push(
      "what is required: the question, in a sentence the user can answer without any context",
    );
  else if (what.length > LIMITS.what)
    problems.push(`what is ${what.length} characters; keep it to ${LIMITS.what}`);
  const why = text(q.why);
  if (why.length > LIMITS.why)
    problems.push(`why is ${why.length} characters; keep it to ${LIMITS.why}`);
  const raw = Array.isArray(q.options) ? (q.options as { label?: unknown }[]) : [];
  const [min, max] = LIMITS.options;
  if (raw.length < min || raw.length > max)
    problems.push(`give ${min} to ${max} options (you gave ${raw.length})`);
  const labels = raw.map((o) => text(o?.label));
  labels.forEach((l, i) => {
    if (!l) problems.push(`option ${i + 1} has no label`);
    else if (l.length > LIMITS.label)
      problems.push(`option ${i + 1} is ${l.length} characters; keep it to ${LIMITS.label}`);
    else if (!wordOf(l))
      problems.push(`option ${i + 1} ("${l}") needs a word to start with: the user can type it`);
  });
  const words = labels.map(wordOf);
  words.forEach((w, i) => {
    if (w && words.indexOf(w) !== i)
      problems.push(
        `option ${i + 1} starts with "${w}", like option ${words.indexOf(w) + 1}: start each option with a different word, because the user may type it`,
      );
    if (w && /^\d+$/.test(w))
      problems.push(
        `option ${i + 1} starts with a number ("${w}"): numbers are the option keys, start with a word`,
      );
  });
  const list = readQuestions(projectDir);
  const waiting = list.filter((x) => x.status === "pending");
  if (waiting.length >= LIMITS.pending)
    problems.push(
      `${waiting.length} questions are still waiting for the user (${waiting.map((x) => x.id).join(", ")}): wait for them`,
    );
  if (what && waiting.some((x) => x.what.toLowerCase() === what.toLowerCase()))
    problems.push("that question is already waiting for the user: do not ask it twice");
  if (problems.length)
    throw new Error(`question not asked, fix these:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  const n = list.reduce((m, x) => Math.max(m, Number(x.id.replace(/\D/g, "")) || 0), 0) + 1;
  const question: Question = {
    id: `q-${n}`,
    at: now.toISOString(),
    role,
    what,
    ...(why ? { why } : {}),
    options: labels.map((label, i) => ({ key: String(i + 1), word: words[i] as string, label })),
    status: "pending",
  };
  save(projectDir, [...list, question]);
  return question;
}

/** Which option a reply names: its number or its word, exactly (case aside). Anything else is not an answer. */
export function pickOption(q: Question, reply: string): QuestionOption | undefined {
  const r = reply
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  return q.options.find((o) => o.key === r || o.word === r);
}

export type AnswerResult =
  | { ok: true; question: Question }
  | { ok: false; reason: "unknown" | "no-such-option" | "already"; question?: Question };

/** Resolve a question exactly once, from the panel or the chat. A second answer is told where and when the first one came from. */
export function answerQuestion(
  projectDir: string,
  id: string,
  reply: string,
  by: "panel" | "chat",
  now = new Date(),
): AnswerResult {
  const list = readQuestions(projectDir);
  const q = list.find((x) => x.id === id);
  if (!q) return { ok: false, reason: "unknown" };
  if (q.status !== "pending") return { ok: false, reason: "already", question: q };
  const o = pickOption(q, reply);
  if (!o) return { ok: false, reason: "no-such-option", question: q };
  q.status = "answered";
  q.answer = { key: o.key, word: o.word, label: o.label, by, at: now.toISOString() };
  save(projectDir, list);
  return { ok: true, question: q };
}

/** Give up on a question (you dismissed it, or you stopped the run): nobody answered it. */
export function cancelQuestion(
  projectDir: string,
  id: string,
  why: string,
  now = new Date(),
): Question {
  const list = readQuestions(projectDir);
  const q = list.find((x) => x.id === id);
  if (!q) throw new Error(`there is no question ${id}`);
  if (q.status !== "pending") throw new Error(`${id} is already ${q.status}`);
  q.status = "cancelled";
  q.cancelled = { why, at: now.toISOString() };
  save(projectDir, list);
  return q;
}

/** What the Director is told when you answered: the question, the option, and what to do. */
export function answeredMessage(prefix: string, q: Question): string {
  const a = q.answer as NonNullable<Question["answer"]>;
  return `${prefix} The user answered your question ${q.id} ("${q.what}") with ${a.key} · ${a.label} (in ${a.by === "chat" ? "the chat" : "the panel"}). Go on with that. Do not ask it again.`;
}

/** What the Director is told when you dismissed the question without choosing (a quiet note). */
export function dismissedMessage(prefix: string, q: Question): string {
  return `${prefix} The user dismissed your question ${q.id} ("${q.what}") without choosing${q.cancelled?.why ? ` (${q.cancelled.why})` : ""}. Do not ask it again unless they bring it back; carry on without that decision if you can, or say what is blocked.`;
}

/** The questions in the project context: what waits for the user, and the last answers (a fresh Director reads this after a restart). */
export function questionsContext(projectDir: string): string[] {
  const all = readQuestions(projectDir);
  if (!all.length) return [];
  const waiting = all.filter((q) => q.status === "pending");
  const done = all.filter((q) => q.status !== "pending").slice(-3);
  const opts = (q: Question) => q.options.map((o) => `${o.key} ${o.label}`).join(" · ");
  return [
    "",
    `## Questions to the user (${waiting.length} waiting)`,
    ...waiting.map((q) => `- ${q.id} WAITING [${q.role}] ${q.what} — ${opts(q)}`),
    ...done.map((q) =>
      q.status === "answered"
        ? `- ${q.id} answered ${q.answer?.key} · ${q.answer?.label} (${q.answer?.by}): ${q.what}`
        : `- ${q.id} dismissed (${q.cancelled?.why ?? "no reason"}): ${q.what}`,
    ),
  ];
}
