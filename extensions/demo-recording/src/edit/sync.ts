/**
 * Sync solver (D11, S4): bend the VIDEO to the NARRATION.
 *
 * Per scene, sync points pair a take event with its narration time: the
 * scene start ↔ audio 0, every [@mark] anchor ↔ its word start, the scene end
 * ↔ the narration end (+ a short tail). Between consecutive sync points the
 * video span is reshaped to the audio span by editing atomic intervals:
 *
 *   kind        cut              speed            freeze
 *   protected   never            1.0 only         never     (typing, clicks)
 *   dead        yes (keep beat)  —                never     (spinners)
 *   stream      never            ≤ 1.3            never     (answer streaming in)
 *   motion      never            ≤ 1.15           never     (in-app video, animation)
 *   static      last resort      0.85 … 1.6       yes       (dwell, reading)
 *
 * Too much video: cut dead time first, then speed up, then trim static.
 * Too little:     slow static down, then freeze a settled static frame.
 * Whatever can't be absorbed is reported as drift (and audio never overlaps).
 * Pure: no I/O. All times in ms unless noted.
 */

export type IntervalKind = "protected" | "dead" | "stream" | "motion" | "static";

export interface Range {
  start: number;
  end: number;
}

export interface Interval extends Range {
  kind: IntervalKind;
}

export const LIMITS = {
  speedMax: { static: 1.6, stream: 1.3, motion: 1.15, protected: 1, dead: 1 } as Record<
    IntervalKind,
    number
  >,
  speedMin: 0.85,
  /** Spinner time kept on screen so the viewer sees that something happened. */
  deadBeatMs: 400,
  /** Never trim a static interval below this. */
  staticMinMs: 200,
  /** Freeze no earlier than this after the span's sync event (let it settle). */
  settleMs: 350,
  /** Narration tail after the last word before the scene ends. */
  tailMs: 600,
};

export type Piece =
  | { src: [number, number]; speed: number; kind: IntervalKind }
  | { freeze: { at: number; dur: number } };

export interface SceneInput {
  id: string;
  start: number;
  end: number;
  protected: Range[];
  dead: Range[];
  stream: Range[];
  motion: Range[];
  /** Anchor events in take time, keyed by mark. */
  events: Record<string, number>;
  /** Narration: section duration (ms) and anchor offsets (ms) from section start. */
  audioMs: number;
  anchors: Record<string, number>;
  /**
   * Timing hints (Q6, D-QA-5): ms the narration after an anchor should start AFTER its event (negative: before). Default 0 = on the event.
   * Only anchors that exist are used.
   */
  hints?: Record<string, number>;
}

export interface AnchorResult {
  mark: string;
  /** Take time of the event. */
  event: number;
  /** Output time of the event (ms from scene output start). */
  out: number;
  /** Output time the anchored narration starts. */
  audioAt: number;
  /** audioAt − out − hint: how far the narration is from where it was meant to start. Positive = late. */
  drift: number;
  /** The timing hint, ms (0 when none): where the narration was meant to start relative to the event. */
  hint: number;
}

export interface AudioPiece {
  /** Offsets in the section audio (ms). */
  src: [number, number];
  /** Output time (ms from scene output start). */
  at: number;
}

export interface SceneEdit {
  id: string;
  pieces: Piece[];
  audio: AudioPiece[];
  anchors: AnchorResult[];
  durationMs: number;
  /**
   * cutMs/frozenMs/spedMs/slowedMs: what the editor did. silenceMs: pauses in the
   * narration where the video couldn't be shortened (typing, in-app video) —
   * anchors stay in sync, the narrator waits. residualMs: worst anchor drift.
   */
  stats: {
    cutMs: number;
    frozenMs: number;
    spedMs: number;
    slowedMs: number;
    silenceMs: number;
    residualMs: number;
    /** Time added at the END of the scene so the narration fits (slowed dwell + held end frame). */
    stretchMs: number;
    /** Part of that hold over moving content (animation/video/streaming): a visible stop. */
    overrunMs: number;
  };
}

const PRIORITY: Exclude<IntervalKind, "static">[] = ["protected", "dead", "stream", "motion"];

/** Split [start, end] into labelled intervals (precedence protected > dead > stream > motion > static). */
export function classify(
  span: Range,
  ranges: Partial<Record<Exclude<IntervalKind, "static">, Range[]>>,
): Interval[] {
  const cuts = new Set<number>([span.start, span.end]);
  for (const k of PRIORITY)
    for (const r of ranges[k] ?? []) {
      if (r.end > span.start && r.start < span.end) {
        cuts.add(Math.max(span.start, r.start));
        cuts.add(Math.min(span.end, r.end));
      }
    }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as number;
    const b = points[i + 1] as number;
    if (b - a < 1) continue;
    const mid = (a + b) / 2;
    const kind =
      PRIORITY.find((k) => (ranges[k] ?? []).some((r) => r.start <= mid && mid < r.end)) ??
      "static";
    const last = out.at(-1);
    if (last && last.kind === kind && last.end === a) last.end = b;
    else out.push({ start: a, end: b, kind });
  }
  return out;
}

interface Work {
  iv: Interval;
  /** Kept source ranges (cuts remove parts). */
  keep: Range;
  speed: number;
  freeze?: { at: number; dur: number };
}

const outLen = (w: Work) => (w.keep.end - w.keep.start) / w.speed + (w.freeze?.dur ?? 0);

/** Reshape one span to `target` ms. Returns pieces + the residual (actual − target). */
export function solveSpan(
  intervals: Interval[],
  target: number,
  syncEvent: number,
  opts: { preferEnd?: boolean } = {},
): { work: Work[]; residual: number; stats: SceneEdit["stats"] } {
  const work: Work[] = intervals.map((iv) => ({
    iv,
    keep: { start: iv.start, end: iv.end },
    speed: 1,
  }));
  const stats = {
    cutMs: 0,
    frozenMs: 0,
    spedMs: 0,
    slowedMs: 0,
    silenceMs: 0,
    residualMs: 0,
    stretchMs: 0,
    overrunMs: 0,
  };
  const total = () => work.reduce((n, w) => n + outLen(w), 0);
  let diff = total() - target;

  if (diff > 0) {
    // 1. cut dead time (keep a short beat)
    for (const w of work) {
      if (diff <= 0) break;
      if (w.iv.kind !== "dead") continue;
      const cut = Math.min(diff, Math.max(0, w.keep.end - w.keep.start - LIMITS.deadBeatMs));
      w.keep.end -= cut;
      stats.cutMs += cut;
      diff -= cut;
    }
    // 2. speed up (proportionally to each interval's headroom)
    if (diff > 0) {
      const flex = work.filter((w) => LIMITS.speedMax[w.iv.kind] > 1);
      const maxGain = flex.reduce(
        (n, w) => n + (w.keep.end - w.keep.start) * (1 - 1 / LIMITS.speedMax[w.iv.kind]),
        0,
      );
      if (maxGain > 0) {
        const f = Math.min(1, diff / maxGain);
        for (const w of flex) {
          const cap = LIMITS.speedMax[w.iv.kind];
          w.speed = 1 / (1 - f * (1 - 1 / cap));
          stats.spedMs += w.keep.end - w.keep.start;
        }
        diff = total() - target;
      }
    }
    // 3. trim static (largest first; trim the END, just before the next event)
    if (diff > 0.5) {
      for (const w of [...work]
        .filter((x) => x.iv.kind === "static")
        .sort((a, b) => b.keep.end - b.keep.start - (a.keep.end - a.keep.start))) {
        if (diff <= 0.5) break;
        const room = Math.max(0, w.keep.end - w.keep.start - LIMITS.staticMinMs);
        const cutSrc = Math.min(room, diff * w.speed);
        w.keep.end -= cutSrc;
        stats.cutMs += cutSrc;
        diff = total() - target;
      }
    }
  } else if (diff < 0) {
    let need = -diff;
    // 1. slow static dwell down (≥ 0.85×)
    const statics = work.filter((w) => w.iv.kind === "static");
    const maxGain = statics.reduce(
      (n, w) => n + (w.keep.end - w.keep.start) * (1 / LIMITS.speedMin - 1),
      0,
    );
    if (maxGain > 0) {
      const f = Math.min(1, need / maxGain);
      for (const w of statics) {
        w.speed = 1 / (1 + f * (1 / LIMITS.speedMin - 1));
        stats.slowedMs += w.keep.end - w.keep.start;
      }
      need = target - total();
    }
    // 2. freeze a settled static frame (after the span's event has landed)
    if (need > 0.5) {
      const candidates = statics.filter(
        (w) => w.keep.end - Math.max(w.keep.start, syncEvent + LIMITS.settleMs) > 1000 / 30,
      );
      // End of a scene: let the action play out, then hold its final settled frame.
      const endStatic = opts.preferEnd ? work.at(-1) : undefined;
      const w = endStatic?.iv.kind === "static" ? endStatic : (candidates[0] ?? statics.at(-1));
      if (w) {
        const at =
          w === endStatic
            ? Math.max(w.keep.start, w.keep.end - 1000 / 30)
            : Math.min(w.keep.end - 1000 / 30, Math.max(w.keep.start, syncEvent + LIMITS.settleMs));
        w.freeze = { at, dur: need };
        stats.frozenMs += need;
        need = 0;
      } else {
        // No static frame in the span (e.g. all typing): hold the span's FIRST
        // frame instead — before the action starts, nothing is moving yet —
        // unless the span opens on independent motion.
        const first = work[0];
        if (
          first &&
          first.iv.kind !== "motion" &&
          first.iv.kind !== "stream" &&
          first.iv.kind !== "dead"
        ) {
          first.freeze = { at: first.keep.start, dur: need };
          stats.frozenMs += need;
          need = 0;
        }
      }
    }
    diff = total() - target;
  }
  stats.residualMs = Math.round(diff);
  return { work, residual: diff, stats };
}

function toPieces(work: Work[]): Piece[] {
  const out: Piece[] = [];
  for (const w of work) {
    // A freeze splits the interval at the frozen frame.
    const parts: Range[] = w.freeze
      ? [
          { start: w.keep.start, end: w.freeze.at },
          { start: w.freeze.at, end: w.keep.end },
        ]
      : [w.keep];
    parts.forEach((r, i) => {
      if (r.end - r.start >= 1)
        out.push({
          src: [Math.round(r.start), Math.round(r.end)],
          speed: +w.speed.toFixed(4),
          kind: w.iv.kind,
        });
      if (i === 0 && w.freeze)
        out.push({ freeze: { at: Math.round(w.freeze.at), dur: Math.round(w.freeze.dur) } });
    });
  }
  return out;
}

/** Output time of take time `t` inside a solved span starting at output `offset`. */
function mapTime(work: Work[], t: number, offset: number): number {
  let o = offset;
  for (const w of work) {
    if (t < w.iv.start) break;
    const freezeBefore = w.freeze && w.freeze.at <= Math.min(t, w.keep.end) ? w.freeze.dur : 0;
    if (t >= w.iv.end) {
      o += outLen(w);
      continue;
    }
    const inside = Math.max(0, Math.min(t, w.keep.end) - w.keep.start);
    return o + inside / w.speed + freezeBefore;
  }
  return o;
}

export function solveScene(s: SceneInput): SceneEdit {
  // Sync points: start, anchors (in event order, only those present on both sides), end.
  const anchored = Object.keys(s.anchors)
    .filter((m) => s.events[m] !== undefined && s.events[m] >= s.start && s.events[m] <= s.end)
    .map((m) => ({
      mark: m,
      v: s.events[m] as number,
      a: s.anchors[m] as number,
      h: s.hints?.[m] ?? 0,
    }))
    .sort((x, y) => x.v - y.v);
  // The narration after an anchor starts `h` after its event, so the video span before the event is paired with the audio
  // coordinate `a − h`; the end follows the last hint.
  const points = [
    { mark: "", v: s.start, a: 0, h: 0 },
    ...anchored.map((x) => ({ ...x, a: x.a - x.h })),
    {
      mark: "",
      v: s.end,
      a: s.audioMs + LIMITS.tailMs - (anchored.at(-1)?.h ?? 0),
      h: 0,
    },
  ];
  const ranges = { protected: s.protected, dead: s.dead, stream: s.stream, motion: s.motion };

  const pieces: Piece[] = [];
  const anchors: AnchorResult[] = [];
  const stats = {
    cutMs: 0,
    frozenMs: 0,
    spedMs: 0,
    slowedMs: 0,
    silenceMs: 0,
    residualMs: 0,
    stretchMs: 0,
    overrunMs: 0,
  };
  let out = 0;
  for (let k = 0; k + 1 < points.length; k++) {
    const p0 = points[k] as (typeof points)[number];
    const p1 = points[k + 1] as (typeof points)[number];
    // Target = the narration's span, corrected for drift accumulated so far
    // (so one span that couldn't absorb its delta doesn't shift all later ones).
    const target = Math.max(0, p1.a - out);
    const intervals = classify({ start: p0.v, end: p1.v }, ranges);
    const last = k + 2 === points.length;
    const solved = solveSpan(intervals, target, p0.v, { preferEnd: last });
    if (last) {
      const natural = intervals.reduce((n, iv) => n + (iv.end - iv.start), 0);
      const added = solved.work.reduce((n, w) => n + outLen(w), 0) - natural;
      if (added > 0) stats.stretchMs += added;
    }
    for (const key of Object.keys(stats) as (keyof typeof stats)[])
      if (key !== "residualMs") stats[key] += solved.stats[key];
    pieces.push(...toPieces(solved.work));
    const spanOut = solved.work.reduce((n, w) => n + outLen(w), 0);
    out += spanOut;
    if (p1.mark)
      anchors.push({
        mark: p1.mark,
        event: p1.v,
        out: Math.round(mapTime(solved.work, p1.v, out - spanOut)),
        audioAt: 0,
        drift: 0,
        hint: p1.h,
      });
  }

  // Audio: split the section at anchors; each piece starts at its event's output
  // time, or right after the previous piece (narration never overlaps itself).
  const audio: AudioPiece[] = [];
  const cutsA = [0, ...anchored.map((a) => a.a), s.audioMs];
  let prevEnd = 0;
  for (let i = 0; i + 1 < cutsA.length; i++) {
    const src: [number, number] = [
      Math.round(cutsA[i] as number),
      Math.round(cutsA[i + 1] as number),
    ];
    const anchor = i > 0 ? anchors[i - 1] : undefined;
    const at = Math.round(Math.max(prevEnd, anchor ? anchor.out + anchor.hint : 0, 0));
    if (at > prevEnd + 1) stats.silenceMs += at - prevEnd;
    if (anchor) {
      anchor.audioAt = at;
      anchor.drift = at - anchor.out - anchor.hint;
    }
    audio.push({ src, at });
    prevEnd = at + (src[1] - src[0]);
  }
  const durationMs = Math.round(Math.max(out, prevEnd + LIMITS.tailMs));
  if (durationMs > out + 1) {
    // Narration ran past the video: hold the last frame (audio is never cut).
    const hold = durationMs - Math.round(out);
    pieces.push({ freeze: { at: Math.max(s.start, s.end - 34), dur: hold } });
    stats.frozenMs += hold;
    stats.stretchMs += hold;
    // Holding a frame that is still moving (in-app video, animation, a streamed
    // answer) is a visible stop: that part is an overrun, not a gentle stretch.
    const tail = Math.max(s.start, s.end - 300);
    const moving = [...s.motion, ...s.stream].some((r) => r.start < s.end && r.end > tail);
    if (moving) stats.overrunMs += hold;
  }
  stats.residualMs = Math.round(anchors.reduce((n, a) => Math.max(n, Math.abs(a.drift)), 0));
  return { id: s.id, pieces, audio, anchors, durationMs, stats };
}
