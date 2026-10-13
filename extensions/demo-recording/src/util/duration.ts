/**
 * Parse a storyboard duration: a number (ms) or a string like "1.2s", "800ms".
 */
export function parseDuration(value: unknown, field = "duration"): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/.exec(value);
    if (m) {
      const n = Number(m[1]);
      return m[2] === "s" ? Math.round(n * 1000) : n;
    }
  }
  throw new Error(
    `${field}: expected a duration like "1.5s", "800ms" or a number of ms, got ${JSON.stringify(value)}`,
  );
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
