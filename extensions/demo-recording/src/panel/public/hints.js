// Timing hints in the narration text (Q6, D-QA-5): `[@mark +300ms]` says the narration after the mark starts 300 ms AFTER its event
// (negative: before). Pure text helpers, shared by the Voice screen's nudge controls and the tests. The words and the voice do not
// change when a hint does, so a hint costs no audio.

export const HINT_STEP_MS = 100;
export const HINT_MAX_MS = 3000;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (mark) =>
  new RegExp(
    `\\[@${escapeRe(mark)}(?:[ \\t]+([+\\-\\u2212])(\\d+(?:\\.\\d+)?)[ \\t]*(ms|s))?[ \\t]*\\]`,
  );

/** The hint of `mark` in the text, in ms (0 without one); null when the mark is not in the text. */
export function hintIn(text, mark) {
  const m = token(mark).exec(text);
  if (!m) return null;
  if (!m[1]) return 0;
  const n = Number(m[2]) * (m[3] === "s" ? 1000 : 1);
  return Math.round(m[1] === "+" ? n : -n);
}

/** The text with `mark`'s hint set to `ms` (0 removes it). The same text when the mark is not there. */
export function withHint(text, mark, ms) {
  const v = Math.max(-HINT_MAX_MS, Math.min(HINT_MAX_MS, Math.round(ms)));
  const replacement = v === 0 ? `[@${mark}]` : `[@${mark} ${v < 0 ? "-" : "+"}${Math.abs(v)}ms]`;
  return text.replace(token(mark), replacement);
}

/** In words, for the nudge control. */
export function hintWords(ms) {
  if (!ms) return "starts on the moment";
  return `starts ${Math.abs(ms)} ms ${ms > 0 ? "after" : "before"} the moment`;
}
