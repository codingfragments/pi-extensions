/**
 * Discovery progress estimate (S3, user request). Discovery is agent-driven,
 * so it combines the director's declared exploration plan (areas) with budget
 * burn. Pure function over a small state object.
 */

export interface AreaState {
  name: string;
  startedAt?: number;
  doneAt?: number;
}

export interface DiscoveryProgressInput {
  startedAt: number;
  now: number;
  areas: AreaState[];
  /** Fractions 0..1 of screens/actions/minutes used. */
  budgetUsed: { screens: number; actions: number; minutes: number };
  budgetMinutes: number;
  storyboardWritten: boolean;
}

export interface DiscoveryProgress {
  /** 0..1 overall, including a final "write storyboard" segment. */
  fraction: number;
  areas: { name: string; status: "done" | "current" | "todo" }[];
  current?: string;
  doneCount: number;
  /** Best estimate of remaining ms; undefined when no plan is declared. */
  etaMs?: number;
  /** Remaining minutes budget (hard upper bound), ms. */
  maxMs: number;
  /** Largest budget fraction used (0..1). */
  budgetFraction: number;
  mode: "plan" | "budget-only";
}

/** Share of the bar reserved for writing the storyboard. */
const WRITE_SHARE = 0.12;
/** Expected time to write the storyboard once exploring is done. */
const WRITE_MS = 90_000;

export function discoveryProgress(i: DiscoveryProgressInput): DiscoveryProgress {
  const elapsed = Math.max(0, i.now - i.startedAt);
  const budgetFraction = Math.min(
    1,
    Math.max(i.budgetUsed.screens, i.budgetUsed.actions, i.budgetUsed.minutes),
  );
  const maxMs = Math.max(0, i.budgetMinutes * 60_000 - elapsed);
  const doneCount = i.areas.filter((a) => a.doneAt !== undefined).length;
  const currentArea = i.areas.find((a) => a.doneAt === undefined);
  const areas = i.areas.map((a) => ({
    name: a.name,
    status:
      a.doneAt !== undefined
        ? ("done" as const)
        : a === currentArea
          ? ("current" as const)
          : ("todo" as const),
  }));

  if (i.storyboardWritten) {
    return {
      fraction: 1,
      areas,
      doneCount,
      etaMs: 0,
      maxMs,
      budgetFraction,
      mode: i.areas.length ? "plan" : "budget-only",
    };
  }
  if (!i.areas.length) {
    return {
      fraction: +Math.min(0.99, budgetFraction).toFixed(4),
      areas,
      doneCount,
      maxMs,
      budgetFraction,
      mode: "budget-only",
    };
  }

  const n = i.areas.length;
  const durations = i.areas
    .filter((a) => a.doneAt !== undefined)
    .map((a) => (a.doneAt as number) - (a.startedAt ?? i.startedAt));
  const avg = durations.length ? durations.reduce((x, y) => x + y, 0) / durations.length : 120_000;
  const remainingAreas = n - doneCount;
  const currentSpent = currentArea?.startedAt !== undefined ? i.now - currentArea.startedAt : 0;
  const etaRaw = Math.max(0, remainingAreas * avg - Math.min(currentSpent, avg * 0.9)) + WRITE_MS;
  const etaMs = Math.round(Math.min(etaRaw, maxMs + WRITE_MS));

  const inCurrent = currentArea ? Math.min(0.9, currentSpent / Math.max(avg, 1)) : 0;
  const exploreFrac = Math.min(1, (doneCount + inCurrent) / n);
  // Budget is a hard floor: running out of budget means we're nearly done.
  const fraction = Math.min(
    0.99,
    Math.max(exploreFrac * (1 - WRITE_SHARE), budgetFraction * (1 - WRITE_SHARE)),
  );
  return {
    fraction: +fraction.toFixed(4),
    areas,
    ...(currentArea ? { current: currentArea.name } : {}),
    doneCount,
    etaMs,
    maxMs,
    budgetFraction,
    mode: "plan",
  };
}

export function formatDiscoveryProgress(p: DiscoveryProgress): string {
  const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60000))} min`;
  if (p.mode === "budget-only")
    return `🔎 discovery · ${Math.round(p.budgetFraction * 100)}% of budget used · max ${mins(p.maxMs)} left`;
  if (p.fraction >= 1) return "🔎 discovery done · storyboard written";
  return (
    `🔎 ${Math.round(p.fraction * 100)}% · area ${Math.min(p.doneCount + 1, p.areas.length)}/${p.areas.length}` +
    `${p.current ? ` · ${p.current}` : " · writing storyboard"} · ~${mins(p.etaMs ?? 0)} left (budget max ${mins(p.maxMs)})`
  );
}
