/**
 * The previews of the Annotations tab, one at a time (they share Chromium and ffmpeg), but without doing work nobody is waiting for (item 19, R3-19):
 *   - the same still asked for twice is ONE render that both callers share;
 *   - a caller that went away (the tab left the screen: its request was aborted) stops waiting at once, and a render nobody waits for any more is skipped when its turn
 *     comes, instead of holding up the thumbnails of the screen you came back to.
 * A render that has already started is finished (its result is cached on disk and the next ask is instant).
 */

export class PreviewCancelled extends Error {
  constructor() {
    super("cancelled: nobody is waiting for this preview any more");
    this.name = "PreviewCancelled";
  }
}

interface Entry<T> {
  promise: Promise<T>;
  /** Callers still waiting. */
  waiters: number;
  started: boolean;
}

export class PreviewQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Entry<unknown>>();
  readonly stats = { started: 0, shared: 0, skipped: 0, aborted: 0 };

  /** Waiting or running right now. */
  get pending(): number {
    return this.inflight.size;
  }

  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      this.stats.aborted++;
      return Promise.reject(new PreviewCancelled());
    }
    let entry = this.inflight.get(key) as Entry<T> | undefined;
    if (entry) this.stats.shared++;
    else {
      const e: Entry<T> = { waiters: 0, started: false, promise: undefined as never };
      e.promise = this.chain
        .then(() => {
          if (e.waiters === 0) {
            this.stats.skipped++;
            throw new PreviewCancelled();
          }
          e.started = true;
          this.stats.started++;
          return fn();
        })
        .finally(() => {
          if (this.inflight.get(key) === e) this.inflight.delete(key);
        });
      this.chain = e.promise.catch(() => undefined);
      this.inflight.set(key, e);
      entry = e;
    }
    entry.waiters++;
    const mine = entry;
    if (!signal) return mine.promise;
    return new Promise<T>((resolve, reject) => {
      let over = false;
      const onAbort = () => {
        if (over) return;
        over = true;
        mine.waiters--;
        this.stats.aborted++;
        reject(new PreviewCancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      mine.promise.then(
        (v) => {
          if (over) return;
          over = true;
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          if (over) return;
          over = true;
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }
}
