/**
 * Typed engine event bus. Engine modules publish; the panel (ws) and the pi
 * session subscribe. A bounded ring buffer lets late subscribers (a panel
 * opened mid-run) replay recent history.
 */

export interface BusEvent {
  /** Monotonic sequence number, unique per bus instance. */
  seq: number;
  /** ISO timestamp. */
  at: string;
  /** Dotted event type, e.g. `project.created`, `job.progress`, `doctor.result`. */
  type: string;
  project?: string;
  data?: Record<string, unknown>;
}

export type BusListener = (event: BusEvent) => void;

export class EventBus {
  private seq = 0;
  private readonly history: BusEvent[] = [];
  private readonly listeners = new Set<BusListener>();

  private readonly capacity: number;

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  publish(type: string, data?: Record<string, unknown>, project?: string): BusEvent {
    const event: BusEvent = { seq: ++this.seq, at: new Date().toISOString(), type };
    if (project) event.project = project;
    if (data) event.data = data;
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the engine.
      }
    }
    return event;
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The sequence number of the newest event (0 before the first). */
  get lastSeq(): number {
    return this.seq;
  }

  /** Events with seq greater than `afterSeq` (default: all retained). */
  recent(afterSeq = 0): BusEvent[] {
    return this.history.filter((e) => e.seq > afterSeq);
  }
}
