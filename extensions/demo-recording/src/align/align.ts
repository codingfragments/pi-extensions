/**
 * Map speech timings onto the SCRIPT's words (S4). Two sources:
 *  - provider character alignment (ElevenLabs /with-timestamps): exact, over our text;
 *  - a transcript with word times (Whisper via py/align.py): aligned to the script
 *    at character level (robust to "14.2%" ↔ "14 .2 percent"), then onset-refined.
 * Output: per script word {w, s, e, seg} and the start of every anchored segment.
 */

import type { VoSegment } from "../vo/script.ts";
import type { TimedWord } from "./onset.ts";

export interface ScriptWord {
  w: string;
  /** Segment index within the section. */
  seg: number;
  s: number;
  e: number;
}

export interface SectionAlignment {
  durationSec: number;
  words: ScriptWord[];
  /** Start (s) of each anchored segment, keyed by mark. */
  anchors: Record<string, number>;
  source: "provider" | "transcript";
  /** A provider alignment whose anchors were moved to the audible onsets (P1a Q0c). */
  snapped?: true;
}

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
};

/**
 * Normalize for matching, identically on both sides: lowercase, "%" → percent,
 * "&" → and, number words → digits, then letters/digits only. Whisper writes
 * "6" and "14.2%" where the script says "Six" and "14.2 percent".
 */
export const norm = (s: string) => {
  const w = s.toLowerCase().replace(/%/g, "percent").replace(/&/g, "and");
  const bare = w.replace(/[^\p{L}\p{N}]/gu, "");
  return NUMBER_WORDS[bare] ?? bare;
};

/** Script words with their segment index, in speaking order. */
export function scriptWords(segments: VoSegment[]): { w: string; seg: number }[] {
  return segments.flatMap((seg, i) =>
    seg.text
      .split(/\s+/)
      .filter((w) => norm(w))
      .map((w) => ({ w, seg: i })),
  );
}

function anchorsOf(segments: VoSegment[], words: ScriptWord[]): Record<string, number> {
  const out: Record<string, number> = {};
  segments.forEach((seg, i) => {
    if (!seg.anchor) return;
    const first = words.find((w) => w.seg === i);
    if (first) out[seg.anchor] = first.s;
  });
  return out;
}

/** Fill missing times by linear interpolation between known neighbours. */
function interpolate(times: (number | undefined)[], total: number): number[] {
  const out = [...times];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== undefined) continue;
    let a = i - 1;
    while (a >= 0 && out[a] === undefined) a--;
    let b = i + 1;
    while (b < out.length && out[b] === undefined) b++;
    const ta = a >= 0 ? (out[a] as number) : 0;
    const tb = b < out.length ? (out[b] as number) : total;
    for (let k = a + 1; k < b; k++) out[k] = ta + ((tb - ta) * (k - a)) / (b - a);
    i = b - 1;
  }
  return out as number[];
}

/** From provider character timings over the exact text the section spoke. */
export function fromCharAlignment(
  segments: VoSegment[],
  spokenText: string,
  chars: string[],
  starts: number[],
  ends: number[],
  durationSec: number,
): SectionAlignment {
  const sw = scriptWords(segments);
  // Walk the provider's characters, matching normalized word by word.
  const flat = chars
    .map((c, i) => ({ c: norm(c), s: starts[i] ?? 0, e: ends[i] ?? 0 }))
    .filter((x) => x.c);
  let k = 0;
  const words: ScriptWord[] = [];
  for (const { w, seg } of sw) {
    const target = norm(w);
    let s: number | undefined;
    let e: number | undefined;
    let matched = "";
    while (k < flat.length && matched.length < target.length) {
      const x = flat[k++] as { c: string; s: number; e: number };
      if (s === undefined) s = x.s;
      e = x.e;
      matched += x.c;
    }
    words.push({ w, seg, s: s ?? 0, e: e ?? s ?? 0 });
  }
  void spokenText;
  return { durationSec, words, anchors: anchorsOf(segments, words), source: "provider" };
}

/**
 * Needleman–Wunsch on characters: script chars ↔ transcript chars. Returns,
 * for each script char, the matching transcript char index (or -1).
 */
export function alignChars(a: string, b: string): Int32Array {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const GAP = -1;
  for (let i = 1; i <= n; i++) score[i * W] = i * GAP;
  for (let j = 1; j <= m; j++) score[j] = j * GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = (score[(i - 1) * W + j - 1] as number) + (a[i - 1] === b[j - 1] ? 2 : -1);
      const up = (score[(i - 1) * W + j] as number) + GAP;
      const left = (score[i * W + j - 1] as number) + GAP;
      score[i * W + j] = Math.max(diag, up, left);
    }
  }
  const map = new Int32Array(n).fill(-1);
  // Semi-global: trailing transcript characters are free (extra words after the
  // script, e.g. hallucinated repeats). Start the traceback at the FIRST best
  // column of the last row, so duplicates never pull the script later.
  let best = 0;
  for (let jj = 0; jj <= m; jj++) {
    const v = (score[n * W + jj] as number) - (m - jj) * GAP;
    const b = (score[n * W + best] as number) - (m - best) * GAP;
    if (v > b) best = jj;
  }
  let i = n;
  let j = best;
  while (i > 0 && j > 0) {
    const cur = score[i * W + j] as number;
    if (cur === (score[(i - 1) * W + j - 1] as number) + (a[i - 1] === b[j - 1] ? 2 : -1)) {
      if (a[i - 1] === b[j - 1]) map[i - 1] = j - 1;
      i--;
      j--;
    } else if (cur === (score[(i - 1) * W + j] as number) + GAP) i--;
    else j--;
  }
  return map;
}

/** From a transcript (Whisper words, already onset-refined). */
export function fromTranscript(
  segments: VoSegment[],
  transcript: TimedWord[],
  durationSec: number,
): SectionAlignment {
  const sw = scriptWords(segments);
  // Transcript char string with a time per char (interpolated within its word).
  let tStr = "";
  const tTimes: number[] = [];
  const tWordStart: boolean[] = [];
  const tWordOf: number[] = [];
  transcript.forEach((word, wi) => {
    const c = norm(word.w);
    for (let k = 0; k < c.length; k++) {
      tStr += c[k];
      tTimes.push(word.s + ((word.e - word.s) * k) / Math.max(1, c.length));
      tWordStart.push(k === 0);
      tWordOf.push(wi);
    }
  });
  let sStr = "";
  const sWordStartChar: number[] = [];
  const sWordEndChar: number[] = [];
  for (const { w } of sw) {
    sWordStartChar.push(sStr.length);
    sStr += norm(w);
    sWordEndChar.push(sStr.length - 1);
  }
  const map = alignChars(sStr, tStr);
  const starts: (number | undefined)[] = sw.map((_, i) => {
    for (let c = sWordStartChar[i] as number; c <= (sWordEndChar[i] as number); c++) {
      const j = map[c] as number;
      if (j >= 0) {
        // Prefer the transcript word's own start when we land on its first char.
        if (c === sWordStartChar[i] && tWordStart[j])
          return (transcript[tWordOf[j] as number] as TimedWord).s;
        return tTimes[j];
      }
    }
    return undefined;
  });
  const ends: (number | undefined)[] = sw.map((_, i) => {
    for (let c = sWordEndChar[i] as number; c >= (sWordStartChar[i] as number); c--) {
      const j = map[c] as number;
      if (j >= 0) return (transcript[tWordOf[j] as number] as TimedWord).e;
    }
    return undefined;
  });
  const s = interpolate(starts, durationSec);
  const e = interpolate(ends, durationSec);
  const words: ScriptWord[] = sw.map((x, i) => ({
    w: x.w,
    seg: x.seg,
    s: +(s[i] as number).toFixed(3),
    e: +Math.max(s[i] as number, e[i] as number).toFixed(3),
  }));
  return { durationSec, words, anchors: anchorsOf(segments, words), source: "transcript" };
}
