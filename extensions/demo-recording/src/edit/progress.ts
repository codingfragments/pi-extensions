/**
 * The progress of a render that is several ffmpeg calls (R3-21): the bar used to move only between the pieces (the scenes and the full video) and stood still inside each,
 * and the biggest piece is the last one. Now each piece reports how far it is (ffmpeg's own `-progress`), the pieces are weighted by their LENGTH (a scene is short, the full
 * video is all of them plus the title), and the label says "42 % · about 1 min left".
 */

/** How long is left, in words that do not pretend to be exact. */
export function etaWords(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 8) return "a few seconds left";
  if (sec < 60) return `about ${Math.ceil(sec / 5) * 5} s left`;
  const min = Math.round(sec / 60);
  return `about ${min} min left`;
}

export interface CutProgress {
  /** Milliseconds of output finished and the total over all pieces: `done / total` is the bar. */
  done: number;
  total: number;
  /** The text the panel shows. */
  label: string;
  /** Whole percent, 0 to 100. */
  percent: number;
  etaSec?: number;
}

export class PieceProgress {
  private readonly total: number;
  private readonly lengthsMs: number[];
  private readonly emit: (p: CutProgress) => void;
  private readonly opts: { throttleMs?: number; now?: () => number };
  private lastAt = 0;

  constructor(
    lengthsMs: number[],
    emit: (p: CutProgress) => void,
    opts: { throttleMs?: number; now?: () => number } = {},
  ) {
    this.lengthsMs = lengthsMs;
    this.emit = emit;
    this.opts = opts;
    this.total = Math.max(
      1,
      lengthsMs.reduce((a, b) => a + b, 0),
    );
  }

  /** Piece `i` (named `label`) is `fraction` done; `speed` is ffmpeg's x real time when it is known. Updates inside a piece are throttled; its start and end are not. */
  at(i: number, label: string, fraction: number, speed?: number | null): void {
    const f = Math.max(0, Math.min(1, fraction));
    const edge = f === 0 || f === 1;
    const now = (this.opts.now ?? Date.now)();
    if (!edge && now - this.lastAt < (this.opts.throttleMs ?? 400)) return;
    this.lastAt = now;
    const before = this.lengthsMs.slice(0, i).reduce((a, b) => a + b, 0);
    const done = before + f * (this.lengthsMs[i] ?? 0);
    const percent = Math.min(100, Math.floor((done / this.total) * 100));
    const etaSec = speed && speed > 0 ? (this.total - done) / 1000 / speed : undefined;
    const eta = etaSec !== undefined && f > 0 && percent < 100 ? etaWords(etaSec) : "";
    this.emit({
      done,
      total: this.total,
      percent,
      ...(etaSec !== undefined ? { etaSec } : {}),
      label: `${label} · ${percent} %${eta ? ` · ${eta}` : ""}`,
    });
  }

  /** All the pieces are done. */
  finish(label: string): void {
    this.lastAt = 0;
    this.emit({ done: this.total, total: this.total, percent: 100, label });
  }
}
