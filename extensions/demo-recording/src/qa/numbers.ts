/**
 * Values in narration (S5 part 10, D71): numbers — written ("14.2%", "$310K",
 * "1,284") or spoken ("fourteen point two percent", "three hundred forty one")
 * — and names (capitalised words that aren't a sentence start), normalised so
 * they can be looked up in page text.
 */

export interface SpokenValue {
  kind: "number" | "name";
  /** As said (the words). */
  said: string;
  /** Normalised: "14.2", "310", "litware bank". */
  value: string;
  /** Index of the first word in the segment's word list. */
  wordIndex: number;
}

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const MARKERS = new Set([
  "percent",
  "per",
  "points",
  "point",
  "k",
  "m",
  "thousand",
  "million",
  "billion",
  "dollars",
  "euros",
]);

const clean = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%]+$/gu, "");
const isNumWord = (w: string) => w in UNITS || w in TENS || w === "hundred";

/** Canonical number text: "14.20" → "14.2", "1,284" → "1284", "310" stays. */
export function canonNumber(n: string): string {
  const t = n.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return t;
  return t.includes(".") ? t.replace(/\.?0+$/, "") : String(Number(t));
}

/**
 * Parse a run of spoken number words from `words[i]`: integer part (with
 * hundreds/tens), optional "point d d …". Returns the value and how many
 * words it used, or undefined.
 */
export function parseSpoken(
  words: string[],
  i: number,
): { value: string; used: number; scaled: boolean } | undefined {
  let j = i;
  let total = 0;
  let cur = 0;
  let any = false;
  while (j < words.length) {
    const w = clean(words[j] as string);
    if (w in UNITS) cur += UNITS[w] as number;
    else if (w in TENS) cur += TENS[w] as number;
    else if (w === "hundred" && any) cur *= 100;
    else if (w === "and" && any && isNumWord(clean(words[j + 1] ?? ""))) {
      j++;
      continue;
    } else break;
    any = true;
    j++;
  }
  if (!any) return undefined;
  total += cur;
  let text = String(total);
  if (clean(words[j] ?? "") === "point") {
    const digits: string[] = [];
    let k = j + 1;
    while (
      k < words.length &&
      clean(words[k] as string) in UNITS &&
      (UNITS[clean(words[k] as string)] as number) < 10
    ) {
      digits.push(String(UNITS[clean(words[k] as string)]));
      k++;
    }
    if (digits.length) {
      text = `${total}.${digits.join("")}`;
      j = k;
    }
  }
  const next = clean(words[j] ?? "");
  const scaled = next in SCALES && next !== "hundred";
  if (scaled) j++;
  return { value: canonNumber(text), used: j - i, scaled };
}

const STOP_NAMES = new Set(["i", "i'll", "i'm", "i've", "i'd", "ok", "okay"]);

/** Values in a segment's words. Sentence starts are not names; small spoken numbers in prose aren't values. */
export function spokenValues(words: string[]): SpokenValue[] {
  const out: SpokenValue[] = [];
  let sentenceStart = true;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i] as string;
    const w = clean(raw);
    // Written numbers: "14.2%", "$310K", "1,284", "3.1"
    const m = /^[$€£]?(\d[\d,]*(?:\.\d+)?)%?[kmb]?$/i.exec(raw.replace(/[.,;:!?)"”’]+$/, ""));
    if (m) {
      out.push({ kind: "number", said: raw, value: canonNumber(m[1] as string), wordIndex: i });
    } else if (isNumWord(w)) {
      const p = parseSpoken(words, i);
      if (p) {
        const after = clean(words[i + p.used] ?? "");
        const decimal = p.value.includes(".");
        // "two questions" isn't a value; "three point one percent", "fourteen percent", "341 accounts" are.
        if (decimal || p.scaled || MARKERS.has(after) || Number(p.value) >= 13) {
          out.push({
            kind: "number",
            said: words.slice(i, i + p.used).join(" "),
            value: p.value,
            wordIndex: i,
          });
          i += p.used - 1;
          sentenceStart = /[.!?]$/.test(words[i] as string);
          continue;
        }
      }
    } else if (/^[A-Z]/.test(raw) && !sentenceStart && !STOP_NAMES.has(w)) {
      // A run of capitalised words: "Litware Bank", "EMEA", "North America"
      let k = i;
      const parts: string[] = [];
      while (k < words.length && /^[A-Z]/.test(words[k] as string)) {
        parts.push(words[k] as string);
        if (/[.!?,;:]$/.test(words[k] as string)) {
          k++;
          break;
        }
        k++;
      }
      out.push({
        kind: "name",
        said: parts.join(" ").replace(/[.!?,;:"”’]+$/, ""),
        value: parts.map(clean).join(" "),
        wordIndex: i,
      });
      sentenceStart = /[.!?]$/.test(parts.at(-1) ?? "");
      i = k - 1;
      continue;
    }
    sentenceStart = /[.!?]["”’)]?$/.test(raw);
  }
  return out;
}

/** Normalised page text for lookups: lowercase, single spaces. */
export const pageNorm = (t: string) => t.toLowerCase().replace(/\s+/g, " ");

/** Does the page text contain this value? Numbers match as a whole number token (14.2 ≠ 114.2, ≠ 14.25). */
export function pageHas(page: string, v: SpokenValue): boolean {
  if (v.kind === "name") return pageNorm(page).includes(v.value);
  const plain = page.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const esc = v.value.replace(/\./g, "\\.");
  const re = new RegExp(`(?<![\\d.])${esc}(?:\\.0+)?(?![\\d]|\\.\\d)`);
  return re.test(plain);
}
