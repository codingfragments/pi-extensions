/**
 * "Mostly reads the screen" (item 23 PR 4, R3-24, D-R3-24-3 and -8): a voice-over section that lists what the viewer can already see instead of saying what it means.
 * Three signals, each with its reason; any one of them is a warning in the write and makes the section "needs your eyes" in the Voice tab. It never blocks.
 *   - numbers: more than two numbers in a section (the rule is one proof number per scene);
 *   - labels: a run of on-screen labels (three or more short sentences in a row, or a list of four or more items, that are mostly words on the page);
 *   - reading: most of the section's words are on the page and it has no word that explains (so, because, which, means, points to, …).
 * Calibrated on run 3: the screen-reading v1 and the rewritten v4 of the same take.
 */

import { spokenValues } from "../qa/numbers.ts";

/** Above this share of a section's content words found on the page, a section without any explaining word reads the screen. */
export const READING_OVERLAP = 0.6;
/** More numbers than this in one section is a list of values, not one proof. */
export const MAX_NUMBERS = 2;

const STOP = new Set(
  "the a an and or of to in on at for with by from as is are was were be been it its this that these those there here than then so but if not no yes you your we our they their them he she his her i me my mine us all any each one two also only just very more most less few some such into over under about after before while when where what which who whom why how can could should would will shall may might must do does did done has have had having get gets got".split(
    " ",
  ),
);

/** Words that explain: a section with one of these is interpreting, not only listing. */
const EXPLAIN =
  /\b(so|because|which|means?|meaning|points? to|shows? that|tells? you|the (?:catch|point|gap|limit|value|question|answer|bet|choice)|i see|my view|i would|i'd|you can|you don't|without|instead|rather|overstates?|understates?|matters?|why|therefore|that is|is where)\b/i;

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, " ")
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);

const contentWords = (t: string) =>
  words(t).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d/.test(w));

export interface ScreenReading {
  /** Which signals fired, with the reason in words. Empty: the section explains. */
  signals: { kind: "numbers" | "labels" | "reading"; why: string }[];
  numbers: number;
  /** Share of the content words that are on the page (0..1). */
  overlap: number;
  explains: boolean;
}

export function readsTheScreen(text: string, pageText: string): ScreenReading {
  const page = new Set(words(pageText));
  const cw = contentWords(text);
  const onPage = cw.filter((w) => page.has(w)).length;
  const overlap = cw.length ? onPage / cw.length : 0;
  const explains = EXPLAIN.test(text);
  const numbers = spokenValues(text.split(/\s+/)).filter((v) => v.kind === "number").length;
  const signals: ScreenReading["signals"] = [];
  if (numbers > MAX_NUMBERS)
    signals.push({
      kind: "numbers",
      why: `${numbers} numbers: keep the one that proves the point and say what it implies`,
    });
  // a run of labels: short sentences in a row, or a long list, mostly made of words on the page
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let run = 0;
  let longest = 0;
  for (const s of sentences) {
    const sw = contentWords(s);
    const short = words(s).length <= 6;
    const mostlyPage = sw.length > 0 && sw.filter((w) => page.has(w)).length / sw.length >= 0.5;
    run = short && mostlyPage && !EXPLAIN.test(s) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const listItems = Math.max(
    0,
    ...sentences.map((s) => {
      const items = s.split(/,\s*|\s+and\s+/).filter((x) => x.trim());
      const shortItems = items.filter((x) => words(x).length <= 4);
      return items.length >= 4 && shortItems.length >= 4 && !EXPLAIN.test(s)
        ? shortItems.length
        : 0;
    }),
  );
  if (longest >= 3)
    signals.push({
      kind: "labels",
      why: `${longest} short label-like sentences in a row: say what they mean together`,
    });
  else if (listItems >= 4)
    signals.push({
      kind: "labels",
      why: `a list of ${listItems} on-screen items: name one and explain it`,
    });
  if (cw.length >= 8 && overlap >= READING_OVERLAP && !explains)
    signals.push({
      kind: "reading",
      why: `${Math.round(overlap * 100)} % of its words are on the page and nothing says what it means`,
    });
  return { signals, numbers, overlap, explains };
}

/** The warning line for a section. */
export function readingWarning(r: ScreenReading): string {
  return `reads the screen (${r.signals.map((s) => s.why).join("; ")}): say what it means for the viewer instead of what they can see`;
}
