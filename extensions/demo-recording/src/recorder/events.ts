/**
 * Take event log (`events.jsonl`, IMPLEMENTATION_PLAN §3.3).
 * `t` = ms since the take's t0, on the screencast clock (epoch ms).
 *
 * With resume (S3) a take is stitched from segments; `setOrigin(t0, offset)`
 * maps a segment's epoch clock onto the take timeline, and `discardFrom(t)`
 * moves a failed attempt's events out of the take (into attempts.jsonl).
 */

import fs from "node:fs";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TakeEvent {
  t: number;
  type: string;
  scene?: string;
  step?: number;
  mark?: string;
  box?: Box;
  data?: Record<string, unknown>;
}

export class EventLog {
  private t0 = 0;
  private offset = 0;
  private readonly file: string;
  events: TakeEvent[] = [];
  private readonly listener: ((e: TakeEvent) => void) | undefined;

  constructor(file: string, listener?: (e: TakeEvent) => void) {
    this.file = file;
    this.listener = listener;
    fs.writeFileSync(file, "");
  }

  /** Map epoch `t0` (segment start) to take time `offset`. */
  setOrigin(t0: number, offset = 0): void {
    this.t0 = t0;
    this.offset = offset;
  }

  /** Take time for an epoch timestamp on the current segment. */
  toTake(at: number): number {
    return Math.round(at - this.t0 + this.offset);
  }

  log(type: string, fields: Omit<TakeEvent, "t" | "type"> = {}, at = Date.now()): TakeEvent {
    const event: TakeEvent = { t: this.toTake(at), type, ...fields };
    this.events.push(event);
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.listener?.(event);
    return event;
  }

  /**
   * Remove `from` and every event logged after it (a failed attempt); returns
   * them. Position-based, not time-based: the previous scene's scene-end can
   * share the same millisecond as the failed scene-start.
   */
  discardFrom(from: TakeEvent): TakeEvent[] {
    const i = this.events.indexOf(from);
    if (i < 0) return [];
    const dropped = this.events.slice(i);
    this.events = this.events.slice(0, i);
    fs.writeFileSync(this.file, this.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    return dropped;
  }
}

export function readEvents(file: string): TakeEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TakeEvent);
}
