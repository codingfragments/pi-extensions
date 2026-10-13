/**
 * Human typing model (S3, D1): log-normal inter-key delays, longer pauses at
 * word boundaries and after punctuation, short bursts on common bigrams, and
 * an optional (default off) typo-and-correct rate. Pure planning function so
 * it is unit-testable; `typeHuman` executes a plan.
 */

import type { Page } from "playwright";
import { sleep } from "../../util/duration.ts";
import type { Rng } from "../../util/rng.ts";

export interface TypingOptions {
  /** Median ms between keys (≈ 60 wpm at 90 ms with word pauses). */
  medianMs?: number;
  /** Log-normal sigma (spread). */
  sigma?: number;
  /** Probability per letter of a neighbor-key typo that gets corrected. */
  typoRate?: number;
}

export type KeyAction =
  | { kind: "char"; ch: string; delay: number }
  | { kind: "backspace"; delay: number };

const NEIGHBORS: Record<string, string> = {
  a: "s",
  s: "d",
  d: "f",
  f: "g",
  g: "h",
  h: "j",
  j: "k",
  k: "l",
  l: "k",
  q: "w",
  w: "e",
  e: "r",
  r: "t",
  t: "y",
  y: "u",
  u: "i",
  i: "o",
  o: "p",
  p: "o",
  z: "x",
  x: "c",
  c: "v",
  v: "b",
  b: "n",
  n: "m",
  m: "n",
};
const FAST_BIGRAMS = new Set([
  "th",
  "he",
  "in",
  "er",
  "an",
  "re",
  "on",
  "at",
  "en",
  "nd",
  "ti",
  "es",
  "or",
  "te",
  "ed",
  "is",
  "it",
  "ng",
]);

/** Box-Muller normal → log-normal around `median`. */
function logNormal(rng: Rng, median: number, sigma: number): number {
  const u1 = Math.max(1e-9, rng.next());
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return median * Math.exp(sigma * z);
}

export function planTyping(text: string, rng: Rng, opts: TypingOptions = {}): KeyAction[] {
  const median = opts.medianMs ?? 90;
  const sigma = opts.sigma ?? 0.35;
  const typoRate = opts.typoRate ?? 0;
  const actions: KeyAction[] = [];
  let prev = "";
  for (const ch of text) {
    let delay = logNormal(rng, median, sigma);
    if (prev === " ") delay += rng.range(60, 160); // start of a new word
    if (/[.,;:!?]/.test(prev)) delay += rng.range(120, 260);
    if (FAST_BIGRAMS.has(`${prev}${ch}`.toLowerCase())) delay *= 0.7;
    if (/[A-Z]/.test(ch)) delay += rng.range(30, 80); // shift
    delay = Math.round(Math.min(600, Math.max(25, delay)));

    const lower = ch.toLowerCase();
    if (typoRate > 0 && NEIGHBORS[lower] && rng.next() < typoRate) {
      actions.push({ kind: "char", ch: NEIGHBORS[lower] as string, delay });
      actions.push({ kind: "backspace", delay: Math.round(rng.range(180, 320)) }); // notice, then fix
      actions.push({ kind: "char", ch, delay: Math.round(rng.range(80, 140)) });
    } else {
      actions.push({ kind: "char", ch, delay });
    }
    prev = ch;
  }
  return actions;
}

/** Expected typing duration (ms) — used by the progress estimator. */
export function expectedTypingMs(text: string, opts: TypingOptions = {}): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(text.length * (opts.medianMs ?? 90) * 1.06 + Math.max(0, words - 1) * 110);
}

export async function typeHuman(
  page: Page,
  text: string,
  rng: Rng,
  opts: TypingOptions = {},
  fast = false,
): Promise<void> {
  if (fast) {
    await page.keyboard.insertText(text);
    return;
  }
  for (const a of planTyping(text, rng, opts)) {
    await sleep(a.delay);
    if (a.kind === "backspace") await page.keyboard.press("Backspace");
    else await page.keyboard.type(a.ch);
  }
}
