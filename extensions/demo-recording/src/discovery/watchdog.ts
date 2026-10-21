/**
 * A deadline for one browser call. A frozen Chromium does not fail a call, it never answers it: the tool call then stays open for ever and takes the whole session
 * with it (a real session lost 26 minutes this way). `withDeadline` ends the wait; what to do about the browser is the caller's business.
 */

export class CallStalledError extends Error {
  readonly call: string;
  readonly afterMs: number;
  readonly aborted: boolean;
  constructor(call: string, afterMs: number, aborted = false) {
    super(
      aborted
        ? `${call} was stopped (aborted) after ${Math.round(afterMs / 1000)} s`
        : `${call} did not answer within ${Math.round(afterMs / 1000)} s`,
    );
    this.call = call;
    this.afterMs = afterMs;
    this.aborted = aborted;
  }
}

/** Run `fn`, but stop waiting after `ms` (0 = no deadline) or when `signal` aborts. The call itself keeps running; its late result or failure is ignored. */
export async function withDeadline<T>(
  call: string,
  ms: number,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!(ms > 0) && !signal) return fn();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    if (ms > 0) timer = setTimeout(() => reject(new CallStalledError(call, ms)), ms);
    if (signal) {
      onAbort = () => reject(new CallStalledError(call, Date.now() - started, true));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  stop.catch(() => undefined);
  const running = fn();
  running.catch(() => undefined); // a call that outlives its deadline must not become an unhandled rejection
  try {
    return await Promise.race([running, stop]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** How long a call may take: the base deadline, longer for what is slow on purpose. */
export function deadlineFor(
  baseMs: number,
  act?: { action: string; ms?: number; text?: string },
): number {
  if (!(baseMs > 0)) return 0;
  if (!act) return baseMs;
  switch (act.action) {
    case "goto":
    case "back":
      return baseMs * 2;
    case "wait":
      return baseMs + Math.min(act.ms ?? 1000, 20_000);
    case "type":
      return baseMs + (act.text?.length ?? 0) * 60;
    default:
      return baseMs;
  }
}
