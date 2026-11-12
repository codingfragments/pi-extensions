/**
 * Parse a storyboard duration: a number (ms) or a string like "1.2s", "800ms", "1.5min" or "1:30" (minutes and seconds).
 */
export function parseDuration(value: unknown, field = "duration"): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|min)?\s*$/.exec(value);
    if (m) {
      const n = Number(m[1]);
      return m[2] === "s" ? Math.round(n * 1000) : m[2] === "min" ? Math.round(n * 60_000) : n;
    }
    const mmss = /^\s*(\d+):([0-5]\d)\s*$/.exec(value);
    if (mmss) return (Number(mmss[1]) * 60 + Number(mmss[2])) * 1000;
  }
  throw new Error(
    `${field}: expected a duration like "1.5s", "800ms" or a number of ms, got ${JSON.stringify(value)}`,
  );
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
