/**
 * Measured discovery progress (item 10, D3; F6, F8). Discovery is driven by the Director, which declares the areas of the app it
 * means to explore and says when each is done. A flag is a claim, so progress is MEASURED from what the session did: every look
 * and action in the action log is attributed to an area, and the counts say what was actually seen.
 *
 * Attribution (decided with the user): route hints from the plan first (an area may name routes such as /search: the longest route
 * that prefixes the page's path wins), otherwise the area the Director is working on (the first not done), otherwise "unassigned".
 * Pure over the log, so it works live, for a closed session and for sessions from before this existed.
 */

import type { AreaStatus, DiscoveryProgress } from "./progress.ts";

export interface LogRecord {
  at?: string;
  kind?: string;
  screen?: string;
  url?: string;
  areas?: string[];
  routes?: Record<string, string[]>;
  area?: string;
  why?: string;
}

export interface AreaMeasure {
  name: string;
  routes: string[];
  status: AreaStatus;
  /** Looks (screens seen) attributed to it. */
  looks: number;
  /** Actions attributed to it. */
  acts: number;
  firstAt?: string;
  lastAt?: string;
  /** The Director said it was done. */
  markedDone: boolean;
  /** Dropped on purpose, and why. */
  droppedWhy?: string;
}

export interface Measure {
  /** Areas were declared. */
  planned: boolean;
  areas: AreaMeasure[];
  /** Looks and actions that no area claimed. */
  unassigned: { looks: number; acts: number };
  /** The time of the last look or action. */
  lastActivityAt?: string;
}

const pageOf = (url: string | undefined): { path: string; hash: string } => {
  if (!url) return { path: "", hash: "" };
  try {
    const u = new URL(url);
    return { path: u.pathname || "/", hash: u.hash };
  } catch {
    const [path = "", hash = ""] = url.split("#");
    return { path: path.split("?")[0] || "/", hash: hash ? `#${hash}` : "" };
  }
};

/**
 * Does a page fall under `route`? "/search" claims "/search" and "/search/x", never "/searching"; "/" claims only the home page
 * (not a hash route of it); a route with a hash ("/#/search") is matched against the page's path and hash, for apps that route
 * with the hash.
 */
export function routeClaims(route: string, path: string, hash = ""): boolean {
  const r = route.trim();
  if (!r.startsWith("/")) return false;
  if (r === "/") return path === "/" && (hash === "" || hash === "#" || hash === "#/");
  const base = r.replace(/\/+$/, "");
  const page = r.includes("#") ? `${path === "/" ? "/" : path.replace(/\/+$/, "")}${hash}` : path;
  return page === base || page.startsWith(`${base}/`);
}

interface Work extends AreaMeasure {
  done: boolean;
  dropped: boolean;
}

export function measureAreas(records: LogRecord[]): Measure {
  let areas: Work[] = [];
  let planned = false;
  const unassigned = { looks: 0, acts: 0 };
  let lastActivityAt: string | undefined;
  const current = () => areas.find((a) => !a.done && !a.dropped);
  /** What happened before any plan: it waits, and is attributed by route when the first plan arrives (the plan comes right after the first look). */
  const pre: LogRecord[] = [];
  const place = (r: LogRecord, useCurrent: boolean) => {
    const { path, hash } = pageOf(r.url);
    // the longest route that claims the page; else (after the plan) the area being worked on
    let hit: Work | undefined;
    let best = -1;
    for (const a of areas) {
      if (a.dropped) continue;
      for (const route of a.routes)
        if (routeClaims(route, path, hash) && route.length > best) {
          best = route.length;
          hit = a;
        }
    }
    const area = hit ?? (useCurrent ? current() : undefined);
    if (area) {
      if (r.kind === "look") area.looks++;
      else area.acts++;
      if (r.at) {
        area.firstAt ??= r.at;
        area.lastAt = r.at;
      }
    } else unassigned[r.kind === "look" ? "looks" : "acts"]++;
  };
  for (const r of records) {
    if (r.kind === "plan" && Array.isArray(r.areas)) {
      const first = !planned;
      planned = true;
      const keep = new Map(areas.map((a) => [a.name, a]));
      areas = r.areas.map((name) => {
        const old = keep.get(name);
        const routes = (r.routes?.[name] ?? old?.routes ?? []).filter((x) => typeof x === "string");
        return old
          ? { ...old, routes }
          : {
              name,
              routes,
              status: "todo",
              looks: 0,
              acts: 0,
              markedDone: false,
              done: false,
              dropped: false,
            };
      });
      if (first) for (const x of pre.splice(0)) place(x, false);
    } else if (r.kind === "area-done" || r.kind === "area-dropped") {
      const a = areas.find((x) => x.name.toLowerCase() === String(r.area ?? "").toLowerCase());
      if (!a) continue;
      if (r.kind === "area-done") {
        a.done = true;
        a.markedDone = true;
      } else {
        a.dropped = true;
        a.droppedWhy = String(r.why ?? "").trim() || "no reason given";
      }
    } else if (r.kind === "look" || r.kind === "act") {
      if (r.at) lastActivityAt = r.at;
      if (!planned) pre.push(r);
      else place(r, true);
    }
  }
  const now = current();
  const out: AreaMeasure[] = areas.map((a) => {
    const seen = a.looks + a.acts > 0;
    const status: AreaStatus = a.dropped
      ? "dropped"
      : a.done
        ? seen
          ? "done"
          : "done-empty"
        : a === now
          ? "current"
          : seen
            ? "seen"
            : "todo";
    const { done: _d, dropped: _x, ...rest } = a;
    return { ...rest, status };
  });
  return { planned, areas: out, unassigned, ...(lastActivityAt ? { lastActivityAt } : {}) };
}

/** An area the engine saw: at least one look attributed to it. Marking it done never makes it covered; seeing it does. */
export const covered = (a: AreaMeasure): boolean => a.looks >= 1;

/** The declared areas nobody saw and nobody dropped: what the storyboard must not be written without. */
export const uncoveredAreas = (m: Measure): AreaMeasure[] =>
  m.areas.filter((a) => a.status !== "dropped" && !covered(a));

/** How much of the exploring is done, from what was seen: a done area that was seen counts 1, the one in hand counts by its activity. */
const WRITE_SHARE = 0.12;
const FULL_AT = 12; // looks + actions in the current area that count as "about done" (a guess, shown as a bar, never as a claim)

export function measuredProgress(
  m: Measure,
  i: {
    startedAt: number;
    now: number;
    budgetUsed: { screens: number; actions: number; minutes: number };
    budgetMinutes: number;
    storyboardWritten: boolean;
  },
): DiscoveryProgress {
  const budgetFraction = Math.min(
    1,
    Math.max(i.budgetUsed.screens, i.budgetUsed.actions, i.budgetUsed.minutes),
  );
  const maxMs = Math.max(0, i.budgetMinutes * 60_000 - Math.max(0, i.now - i.startedAt));
  const areas = m.areas.map((a) => ({
    name: a.name,
    status: a.status,
    looks: a.looks,
    acts: a.acts,
  }));
  const counted = m.areas.filter((a) => a.status !== "dropped");
  const doneCount = counted.filter((a) => a.status === "done").length;
  const current = m.areas.find((a) => a.status === "current");
  const base = {
    areas,
    doneCount,
    maxMs,
    budgetFraction,
    ...(current ? { current: current.name } : {}),
  };
  if (i.storyboardWritten)
    return { ...base, fraction: 1, etaMs: 0, mode: m.planned ? "plan" : "budget-only" };
  if (!m.planned || !counted.length)
    return { ...base, fraction: +Math.min(0.99, budgetFraction).toFixed(4), mode: "budget-only" };
  const share = (a: AreaMeasure) =>
    a.status === "done"
      ? 1
      : a.status === "done-empty"
        ? 0
        : Math.min(0.9, (a.looks + a.acts) / FULL_AT);
  const explore = counted.reduce((n, a) => n + share(a), 0) / counted.length;
  const fraction = Math.min(
    0.99,
    Math.max(explore * (1 - WRITE_SHARE), budgetFraction * (1 - WRITE_SHARE)),
  );
  return { ...base, fraction: +fraction.toFixed(4), mode: "plan" };
}
