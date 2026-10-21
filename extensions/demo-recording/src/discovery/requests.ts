/**
 * Discovery you start from the Project page (item 10, D1, F1, F5). Discovery is driven by the Director (it opens a browser session
 * and explores), so "Start" and "Enhance" are a REQUEST: your notes, the areas you want covered and the budget you chose, stored in
 * the project, sent to the Director, and read by the session when it opens (so the budget is the one you chose, not only Config's).
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../workdir/versioning.ts";
import type { DiscoveryBudgets } from "./session.ts";

export const PRESETS = ["scout", "quick", "standard", "deep"] as const;
export type Preset = (typeof PRESETS)[number] | "custom";

/** The most a request may ask for (a typo must not start a three-hour session). */
export const BUDGET_CAPS: DiscoveryBudgets = {
  discoveryScreens: 200,
  discoveryActions: 800,
  discoveryMinutes: 120,
};

/**
 * scout is the first look at an app: a survey (the engine's, which does not use the screen budget) and a few deep looks, 0.4 of the standard screens and minutes and a
 * quarter of its actions. quick is half of the standard, deep is double, all within the caps.
 */
export function presetBudgets(
  standard: DiscoveryBudgets,
  preset: (typeof PRESETS)[number],
): DiscoveryBudgets {
  const k = (kind: "screens" | "actions" | "minutes") =>
    preset === "scout"
      ? { screens: 0.4, actions: 0.25, minutes: 0.4 }[kind]
      : preset === "quick"
        ? 0.5
        : preset === "deep"
          ? 2
          : 1;
  const f = (n: number, cap: number, kind: "screens" | "actions" | "minutes") =>
    Math.min(cap, Math.max(1, Math.round(n * k(kind))));
  return {
    discoveryScreens: f(standard.discoveryScreens, BUDGET_CAPS.discoveryScreens, "screens"),
    discoveryActions: f(standard.discoveryActions, BUDGET_CAPS.discoveryActions, "actions"),
    discoveryMinutes: f(standard.discoveryMinutes, BUDGET_CAPS.discoveryMinutes, "minutes"),
  };
}

/** A budget from outside: whole numbers from 1 up to the cap, each named in the error. */
export function checkBudget(b: unknown): DiscoveryBudgets {
  const o = (b ?? {}) as Record<string, unknown>;
  const one = (key: keyof DiscoveryBudgets, label: string) => {
    const n = Number(o[key]);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`${label} must be a whole number of 1 or more`);
    if (n > BUDGET_CAPS[key]) throw new Error(`${label} is at most ${BUDGET_CAPS[key]}`);
    return n;
  };
  return {
    discoveryScreens: one("discoveryScreens", "screens"),
    discoveryActions: one("discoveryActions", "actions"),
    discoveryMinutes: one("discoveryMinutes", "minutes"),
  };
}

export interface DiscoveryRequest {
  id: string;
  at: string;
  mode: "start" | "enhance";
  /** What you want the Director to look at or keep in mind. */
  notes: string;
  /** Areas of the app to cover, one per line in the form. */
  areas: string[];
  budget: DiscoveryBudgets;
  preset: Preset;
  /** Enhance: the session it builds on (the newest one when you did not pick). */
  base?: string;
  /** Show the browser window in front and leave it open when discovery ends (the Start window's switch). */
  headed?: boolean;
  status: "pending" | "started" | "cancelled";
  /** The session that took it. */
  session?: string;
}

const MAX_TEXT = 2000;
const file = (projectDir: string) => path.join(projectDir, "discovery-requests.json");

export function readRequests(projectDir: string): DiscoveryRequest[] {
  try {
    const list = JSON.parse(fs.readFileSync(file(projectDir), "utf8")) as DiscoveryRequest[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const save = (projectDir: string, list: DiscoveryRequest[]) =>
  writeFileAtomic(file(projectDir), `${JSON.stringify(list, null, 2)}\n`);

/** The request waiting for the Director's next session, the newest one. */
export const pendingRequest = (projectDir: string): DiscoveryRequest | undefined =>
  [...readRequests(projectDir)].reverse().find((r) => r.status === "pending");

export function addRequest(
  projectDir: string,
  r: {
    mode: "start" | "enhance";
    notes?: unknown;
    areas?: unknown;
    budget: unknown;
    preset?: unknown;
    base?: string;
    headed?: unknown;
  },
  now = new Date(),
): DiscoveryRequest {
  const notes = typeof r.notes === "string" ? r.notes.trim() : "";
  if (notes.length > MAX_TEXT) throw new Error(`keep the notes to ${MAX_TEXT} characters`);
  const areas = (Array.isArray(r.areas) ? r.areas : [])
    .map((a) => String(a).trim())
    .filter(Boolean)
    .slice(0, 12);
  if (areas.some((a) => a.length > 120))
    throw new Error("an area is a short phrase (120 characters at most)");
  const list = readRequests(projectDir);
  // an earlier request nobody picked up is replaced: there is one thing waiting for the Director at a time
  for (const x of list) if (x.status === "pending") x.status = "cancelled";
  const preset: Preset = (PRESETS as readonly string[]).includes(String(r.preset))
    ? (r.preset as Preset)
    : "custom";
  const req: DiscoveryRequest = {
    id: `dr-${list.length + 1}`,
    at: now.toISOString(),
    mode: r.mode,
    notes,
    areas,
    budget: checkBudget(r.budget),
    preset,
    ...(r.base ? { base: r.base } : {}),
    ...(r.headed === true ? { headed: true } : {}),
    status: "pending",
  };
  save(projectDir, [...list, req]);
  return req;
}

/** The session took the request: it is started, and stays as the record of what was asked. */
export function startRequest(projectDir: string, id: string, session: string): void {
  const list = readRequests(projectDir);
  const r = list.find((x) => x.id === id);
  if (!r) return;
  r.status = "started";
  r.session = session;
  save(projectDir, list);
}

export function cancelRequest(projectDir: string): DiscoveryRequest {
  const list = readRequests(projectDir);
  const r = [...list].reverse().find((x) => x.status === "pending");
  if (!r) throw new Error("no discovery request is waiting for the Director");
  r.status = "cancelled";
  save(projectDir, list);
  return r;
}

/** What the Director is told: what you asked, the budget, and what it builds on. */
export function requestMessage(
  prefix: string,
  p: { slug: string; name: string; url: string },
  r: DiscoveryRequest,
  earlier: { sessions: number; findings: number },
  extra: { briefDraft?: boolean } = {},
): string {
  const b = r.budget;
  const lines = [
    `${prefix} The user ${r.mode === "enhance" ? "asks to ENHANCE the discovery" : "asks to start discovery"} of ${p.name} (${p.url}) for demo project "${p.slug}" from the Project page (request ${r.id}).`,
    `Follow the demo-recording skill: open a discovery session with demo_rec_browser open (it takes this request's budget: ${b.discoveryScreens} screens, ${b.discoveryActions} actions, ${b.discoveryMinutes} minutes${r.preset === "custom" ? "" : `, the ${r.preset} choice`}), explore, record findings, and propose a storyboard based on brief.md.`,
  ];
  lines.push(
    r.preset === "scout"
      ? "This is a SCOUTING run: open, declare your plan, call demo_rec_browser survey ONCE (the engine visits the navigation itself, in seconds, and the pages do not use the screen budget), then go deep on only the few pages that serve the brief (act with steps: [...] walks a route in one call). Write the storyboard proposal from that; the user can enhance the discovery later."
      : "Start with demo_rec_browser survey right after the plan (the engine visits the navigation itself, in seconds, and the pages do not use the screen budget), then spend the budget on the few pages that serve the brief (act with steps: [...] walks a route in one call).",
  );
  if (r.headed)
    lines.push(
      "The user wants to WATCH: the browser window is shown in front and stays open when you close the session. Do not close it early, and do not ask them to open anything.",
    );
  if (extra.briefDraft)
    lines.push(
      "The brief is still a draft (fields marked TODO). Do NOT stop to ask the user about it: explore, and at the end say which brief fields you could now fill in.",
    );
  if (r.notes) lines.push(`Their notes: ${r.notes}`);
  if (r.areas.length)
    lines.push(
      `Areas they want covered (declare them in your plan and cover each): ${r.areas.join("; ")}.`,
    );
  if (r.mode === "enhance")
    lines.push(
      `Build on what exists: ${earlier.sessions} earlier session${earlier.sessions === 1 ? "" : "s"}${r.base ? ` (the newest is ${r.base})` : ""} and ${earlier.findings} finding${earlier.findings === 1 ? "" : "s"}. Read them first (demo_rec_project context and findings), do NOT repeat what is already covered, and say what the new session added.`,
    );
  return lines.join("\n");
}
