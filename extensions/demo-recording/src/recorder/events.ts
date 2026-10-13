/**
 * Take event log (`events.jsonl`, IMPLEMENTATION_PLAN §3.3).
 * `t` = ms since the take's t0, on the screencast clock (epoch ms).
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
  private readonly file: string;
  readonly events: TakeEvent[] = [];
  private readonly listener: ((e: TakeEvent) => void) | undefined;

  constructor(file: string, listener?: (e: TakeEvent) => void) {
    this.file = file;
    this.listener = listener;
    fs.writeFileSync(file, "");
  }

  setOrigin(t0: number): void {
    this.t0 = t0;
  }

  log(type: string, fields: Omit<TakeEvent, "t" | "type"> = {}, at = Date.now()): TakeEvent {
    const event: TakeEvent = { t: Math.round(at - this.t0), type, ...fields };
    this.events.push(event);
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.listener?.(event);
    return event;
  }
}

export function readEvents(file: string): TakeEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TakeEvent);
}
