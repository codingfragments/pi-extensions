/**
 * A bounded retry for the two tests that sometimes fail under full-suite load and pass alone ("resume: an error in
 * scene 3", the 3200x1800 capture test). The cause is not known: this keeps a real failure visible (it must fail
 * every attempt) and makes a flake loud (every failed attempt is printed), instead of hiding it or failing CI at random.
 */

export function retryOnce(fn: () => Promise<void> | void, attempts = 2): () => Promise<void> {
  return async () => {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        await fn();
        if (i > 1) process.stderr.write(`[flaky] passed on attempt ${i} of ${attempts}\n`);
        return;
      } catch (e) {
        last = e;
        const why = String((e as Error)?.message ?? e).split("\n")[0];
        process.stderr.write(`[flaky] attempt ${i} of ${attempts} failed: ${why}\n`);
      }
    }
    throw last;
  };
}
