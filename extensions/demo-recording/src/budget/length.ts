/**
 * The length budget of a demo (item 22, R3-25, decisions D-R3-25-1 to -15). ONE target length, a window around it from the configured tolerances (default −15 % / +10 %),
 * and two explicit limits that override one side each ("no shorter than", "no longer than"). It is measured against the FINAL video (title card included, the dead time
 * the edit cuts taken off), and it means "hit it", not "stay under it".
 *
 * Where it comes from, in order: the brief's `Target length` (one number; an old range "3–5 min" reads as its midpoint with the range's edges as floor and ceiling),
 * then `No shorter than` / `No longer than`, then the depth's default when the brief says nothing. A limit without a target is not a plan: `needsTarget` says so and the
 * Director asks. A floor above the ceiling is not guessed either: `conflict` says so.
 */

export interface Tolerance {
  /** How far under the target still fits, in percent (default 15). */
  underPct: number;
  /** How far over the target still fits, in percent (default 10). */
  overPct: number;
}

export const DEFAULT_TOLERANCE: Tolerance = { underPct: 15, overPct: 10 };

export type LengthSource = "brief" | "range" | "depth" | "tolerance" | "limit";

export interface LengthBudget {
  targetSec: number;
  floorSec: number;
  ceilingSec: number;
  /** Where each number came from: the brief's target, an old range's midpoint and edges, the depth default, the tolerance, or an explicit limit. */
  source: { target: LengthSource; floor: LengthSource; ceiling: LengthSource };
  /** "no shorter than 12, no longer than 10": asked back, never guessed. */
  conflict?: string;
}

export type LengthVerdict = "short" | "fits" | "long";

/** A length like "10 min", "90 s", "2:30", "12.5 min", "3–5 min" (a range). Seconds; undefined when it is not one. */
export function parseLength(
  v: string | undefined,
): { kind: "single"; sec: number } | { kind: "range"; lo: number; hi: number } | undefined {
  if (!v) return undefined;
  const s = v
    .toLowerCase()
    .replace(/total|about|approx\.?|around|roughly|~/g, "")
    .trim();
  const unitMin = /\bmin/.test(s) || /\bminutes?\b/.test(s);
  const unitHour = /\bh(ours?|rs?)?\b/.test(s) && !unitMin;
  const nums = [...s.matchAll(/(\d+(?::\d{2})?(?:[.,]\d+)?)/g)].map((m) => {
    const t = m[1] as string;
    if (t.includes(":")) {
      const [mm, ss] = t.split(":").map(Number);
      return (mm as number) * 60 + (ss as number);
    }
    const n = Number(t.replace(",", "."));
    return unitHour ? n * 3600 : unitMin ? n * 60 : n;
  });
  if (!nums.length) return undefined;
  const a = Math.round(nums[0] as number);
  const b = Math.round(nums[1] ?? a);
  if (a <= 0 || b <= 0) return undefined;
  if (a === b) return { kind: "single", sec: a };
  return { kind: "range", lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** One length for a limit field ("No shorter than 9 min"): the single value, or for a range its first number. */
const limitOf = (v: string | undefined) => {
  const p = parseLength(v);
  return p ? (p.kind === "single" ? p.sec : p.lo) : undefined;
};

export function lengthBudget(
  fields: { length?: string; noShorterThan?: string; noLongerThan?: string },
  opts: { tolerance?: Tolerance; depthDefault?: [number, number] } = {},
): LengthBudget | undefined {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const t = parseLength(fields.length);
  let targetSec: number | undefined;
  let floorSec: number | undefined;
  let ceilingSec: number | undefined;
  const source: LengthBudget["source"] = {
    target: "brief",
    floor: "tolerance",
    ceiling: "tolerance",
  };
  if (t?.kind === "single") targetSec = t.sec;
  else if (t?.kind === "range") {
    targetSec = Math.round((t.lo + t.hi) / 2);
    floorSec = t.lo;
    ceilingSec = t.hi;
    source.target = "range";
    source.floor = "range";
    source.ceiling = "range";
  } else if (opts.depthDefault) {
    const [lo, hi] = opts.depthDefault;
    targetSec = Math.round((lo + hi) / 2);
    floorSec = lo;
    ceilingSec = hi;
    source.target = "depth";
    source.floor = "depth";
    source.ceiling = "depth";
  }
  if (targetSec === undefined) return undefined;
  floorSec ??= Math.round(targetSec * (1 - tol.underPct / 100));
  ceilingSec ??= Math.round(targetSec * (1 + tol.overPct / 100));
  const floor = limitOf(fields.noShorterThan);
  const ceiling = limitOf(fields.noLongerThan);
  if (floor !== undefined) {
    floorSec = floor;
    source.floor = "limit";
  }
  if (ceiling !== undefined) {
    ceilingSec = ceiling;
    source.ceiling = "limit";
  }
  const b: LengthBudget = { targetSec, floorSec, ceilingSec, source };
  if (floorSec > ceilingSec)
    b.conflict = `the floor (${clock(floorSec)}) is above the ceiling (${clock(ceilingSec)})`;
  else if (targetSec < floorSec || targetSec > ceilingSec)
    b.conflict = `the target (${clock(targetSec)}) is outside its own limits (${clock(floorSec)} to ${clock(ceilingSec)})`;
  return b;
}

/** Only limits and no target: the Director must ask what to aim for (D-R3-25-3). */
export function needsTarget(fields: {
  length?: string;
  noShorterThan?: string;
  noLongerThan?: string;
}): boolean {
  return (
    !parseLength(fields.length) &&
    (!!limitOf(fields.noShorterThan) || !!limitOf(fields.noLongerThan))
  );
}

export function lengthVerdict(sec: number, b: LengthBudget): LengthVerdict {
  if (sec < b.floorSec) return "short";
  if (sec > b.ceilingSec) return "long";
  return "fits";
}

/** 605 → "10:05". */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

/** "10:00 (8:30 to 11:00)" */
export function budgetWords(b: LengthBudget): string {
  return `${clock(b.targetSec)} (${clock(b.floorSec)} to ${clock(b.ceilingSec)})`;
}

/** "projected 6:10 for a target of 10:00 (8:30 to 11:00): 2:20 short" */
export function againstBudget(sec: number, b: LengthBudget, what = "projected"): string {
  const v = lengthVerdict(sec, b);
  const gap =
    v === "short"
      ? `: ${clock(b.floorSec - sec)} short of the floor`
      : v === "long"
        ? `: ${clock(sec - b.ceilingSec)} over the ceiling`
        : ": fits";
  return `${what} ${clock(sec)} for a target of ${budgetWords(b)}${gap}`;
}

/**
 * A direction in the user's words that names a length (chat or a review): the Director must write it into the brief in the same turn (D-R3-25-2), or ask when it is only a
 * limit (D-R3-25-3). Returns what it says, for the note to the Director; undefined when it names no length.
 */
export function lengthDirection(
  text: string,
): { floor?: number; ceiling?: number; target?: number } | undefined {
  const t = text.toLowerCase();
  const len = String.raw`(\d+(?::\d{2})?(?:[.,]\d+)?\s*(?:min(?:utes?)?|m\b|s(?:ec(?:onds?)?)?\b|h(?:ours?)?\b)?)`;
  const out: { floor?: number; ceiling?: number; target?: number } = {};
  const sec = (s: string) => {
    const p = parseLength(/\d\s*$/.test(s.trim()) ? `${s} min` : s.replace(/\bm\b/, "min"));
    return p ? (p.kind === "single" ? p.sec : p.lo) : undefined;
  };
  const floor = new RegExp(
    String.raw`(?:no|not)\s+shorter\s+than\s+${len}|at\s+least\s+${len}|minimum\s+(?:of\s+)?${len}`,
  ).exec(t);
  const ceiling = new RegExp(
    String.raw`(?:no|not)\s+longer\s+than\s+${len}|at\s+most\s+${len}|maximum\s+(?:of\s+)?${len}|under\s+${len}`,
  ).exec(t);
  const target = new RegExp(
    String.raw`(?:aim\s+for|target(?:\s+length)?(?:\s+of|:)?|about|around|roughly|make\s+it)\s+${len}|${len}\s+(?:demo|video|overview|budget|recording)`,
  ).exec(t);
  const pick = (m: RegExpExecArray | null) =>
    m ? sec(m.slice(1).find((x) => x) ?? "") : undefined;
  const f = pick(floor);
  const c = pick(ceiling);
  const g = pick(target);
  if (f !== undefined) out.floor = f;
  if (c !== undefined) out.ceiling = c;
  if (g !== undefined) out.target = g;
  return Object.keys(out).length ? out : undefined;
}
