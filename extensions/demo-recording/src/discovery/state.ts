/**
 * What the Project page says about discovery (item 10, D1): the sessions on disk and how each ended. A session writes
 * `session.json` when it opens (its budgets, the request it took) and when it closes (what it used, whether the budget ran out);
 * older sessions without it are read from their action log, without budgets.
 */

import fs from "node:fs";
import path from "node:path";
import { pendingRequest } from "./requests.ts";

export interface SessionRecord {
  id: string;
  startedAt: string;
  budgets?: { discoveryScreens: number; discoveryActions: number; discoveryMinutes: number };
  request?: string;
  closedAt?: string;
  usage?: { screens: number; actions: number; minutes: number };
  exhausted?: boolean;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  closedAt?: string;
  screens: number;
  actions: number;
  minutes?: number;
  budgets?: SessionRecord["budgets"];
  /** The budget ran out: the Director had to stop exploring. */
  exhausted: boolean;
  request?: string;
  /** No session.json: read from the action log, so no budget and no stop reason. */
  older: boolean;
}

export type DiscoveryStatus = "never" | "running" | "budget" | "done" | "interrupted";

export const sessionsDir = (appDir: string) => path.join(appDir, "discovery");

export function writeSessionRecord(appDir: string, rec: SessionRecord): void {
  const dir = path.join(sessionsDir(appDir), rec.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.json"), `${JSON.stringify(rec, null, 2)}\n`);
}

export function readSessionRecord(appDir: string, id: string): SessionRecord | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(sessionsDir(appDir), id, "session.json"), "utf8"),
    ) as SessionRecord;
  } catch {
    return undefined;
  }
}

function fromLog(dir: string): { screens: number; actions: number; first?: string; last?: string } {
  let screens = 0;
  let actions = 0;
  let first: string | undefined;
  let last: string | undefined;
  try {
    for (const line of fs.readFileSync(path.join(dir, "actions.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { kind?: string; at?: string };
      if (r.kind === "look") screens++;
      if (r.kind === "act") actions++;
      first ??= r.at;
      last = r.at ?? last;
    }
  } catch {
    // an empty or broken log: zeros
  }
  return { screens, actions, ...(first ? { first } : {}), ...(last ? { last } : {}) };
}

/** Every session of the app, oldest first. */
export function listSessions(appDir: string): SessionSummary[] {
  const root = sessionsDir(appDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => fs.statSync(path.join(root, d)).isDirectory())
    .sort()
    .map((id): SessionSummary => {
      const rec = readSessionRecord(appDir, id);
      const log = fromLog(path.join(root, id));
      if (rec)
        return {
          id,
          startedAt: rec.startedAt,
          ...(rec.closedAt ? { closedAt: rec.closedAt } : {}),
          screens: rec.usage?.screens ?? log.screens,
          actions: rec.usage?.actions ?? log.actions,
          ...(rec.usage ? { minutes: rec.usage.minutes } : {}),
          ...(rec.budgets ? { budgets: rec.budgets } : {}),
          exhausted: !!rec.exhausted,
          ...(rec.request ? { request: rec.request } : {}),
          older: false,
        };
      return {
        id,
        startedAt: log.first ?? new Date(0).toISOString(),
        ...(log.last ? { closedAt: log.last } : {}),
        screens: log.screens,
        actions: log.actions,
        exhausted: false,
        older: true,
      };
    });
}

/** Where discovery stands: running now, ran out of budget, done, cut off (no close), or never run. */
export function discoveryStatus(sessions: SessionSummary[], runningId?: string): DiscoveryStatus {
  if (runningId) return "running";
  const last = sessions.at(-1);
  if (!last) return "never";
  if (last.exhausted) return "budget";
  if (!last.older && !last.closedAt) return "interrupted";
  return "done";
}

export { pendingRequest };
