// The thumbnails' render queue in the tab (item 19, R3-19): one request at a time (the server renders one at a time too), but
//   - the thumbnails IN VIEW go first (then the rest, in the order they were asked for), so what you look at is ready first;
//   - a thumbnail that left the screen (its component went away, `signal` aborted) is dropped from the queue and, when its request is
//     already out, the request is aborted (the server stops waiting for it too);
//   - `pending()` says how many are waiting or running, for "3 of 24".
// Pure (no DOM), so it is tested on its own.

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function createPreviewQueue() {
  /** @type {{ run: (signal: AbortSignal) => Promise<unknown>, visible: () => boolean, signal: AbortSignal, resolve: (v: unknown) => void, reject: (e: unknown) => void }[]} */
  const waiting = [];
  let running = 0;
  const listeners = new Set();
  const emit = () => {
    for (const l of listeners) l(api.pending());
  };

  function pump() {
    if (running) return;
    for (let i = waiting.length - 1; i >= 0; i--) {
      const t = waiting[i];
      if (t.signal.aborted) {
        waiting.splice(i, 1);
        t.reject(new AbortedError());
      }
    }
    if (!waiting.length) return emit();
    const at = Math.max(
      0,
      waiting.findIndex((t) => t.visible()),
    );
    const [t] = waiting.splice(at, 1);
    running++;
    emit();
    Promise.resolve()
      .then(() => {
        // aborted between being picked and starting: nothing to run
        if (t.signal.aborted) throw new AbortedError();
        return t.run(t.signal);
      })
      .then(t.resolve, t.reject)
      .finally(() => {
        running--;
        pump();
      });
  }

  const api = {
    /** Ask for `run(signal)` to be run in its turn (`first`: before everything waiting, as a click on a clip is); the promise settles with its result (rejects with AbortError when `signal` aborts first). */
    enqueue(run, { signal, visible = () => false, first = false }) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new AbortedError());
        (first ? waiting.unshift.bind(waiting) : waiting.push.bind(waiting))({
          run,
          visible,
          signal,
          resolve,
          reject,
        });
        // an abort while it waits drops it at once (not only when its turn comes)
        signal.addEventListener(
          "abort",
          () => {
            const i = waiting.findIndex((t) => t.resolve === resolve);
            if (i >= 0) {
              waiting.splice(i, 1);
              reject(new AbortedError());
              emit();
            }
          },
          { once: true },
        );
        pump();
      });
    },
    pending: () => waiting.length + running,
    /** Call `fn(n)` whenever the number waiting or running changes. Returns the unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}
