/**
 * The storyboard is not written over areas nobody saw (item 10, D3; F6). The areas the Director declared in its plan are checked
 * against what the engine MEASURED in the latest discovery session (measure.ts): an area with no look attributed to it is
 * uncovered unless it was dropped on purpose with a reason. Reads the session's action log, so it works after the session closed.
 */

import fs from "node:fs";
import path from "node:path";
import { type LogRecord, type Measure, measureAreas, uncoveredAreas } from "./measure.ts";
import { listSessions, sessionsDir } from "./state.ts";

const logFile = (appDir: string, id: string) => path.join(sessionsDir(appDir), id, "actions.jsonl");

export function readLog(appDir: string, id: string): LogRecord[] {
  try {
    return fs
      .readFileSync(logFile(appDir, id), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as LogRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** What a session saw, per area, from its log (a closed session, or one that is still running). */
export const measureSession = (appDir: string, id: string): Measure =>
  measureAreas(readLog(appDir, id));

/** Drop declared areas of a session on purpose: one record each, with the reason, so it is shown and kept. */
export function dropInLog(
  appDir: string,
  id: string,
  drops: { area: string; why: string }[],
): void {
  const m = measureSession(appDir, id);
  for (const d of drops) {
    const a = m.areas.find((x) => x.name.toLowerCase() === d.area.trim().toLowerCase());
    if (!a)
      throw new Error(
        `"${d.area}" is not a declared area: ${m.areas.map((x) => x.name).join(", ") || "none"}`,
      );
    if (!d.why.trim()) throw new Error(`say why "${a.name}" is left out (a reason is required)`);
    fs.appendFileSync(
      logFile(appDir, id),
      `${JSON.stringify({ at: new Date().toISOString(), kind: "area-dropped", area: a.name, why: d.why.trim().slice(0, 240) })}\n`,
    );
  }
}

export interface CoverageProblem {
  session: string;
  uncovered: { name: string; status: string; looks: number; acts: number }[];
}

/** A storyboard written since the session started has already been through this: do not ask again for every revision. */
function writtenSince(projectDir: string, startedAt: string): boolean {
  const dir = path.join(projectDir, "storyboard");
  if (!fs.existsSync(dir)) return false;
  const t = Date.parse(startedAt);
  return fs
    .readdirSync(dir)
    .filter((f) => /^v\d+\.yaml$/.test(f))
    .some((f) => fs.statSync(path.join(dir, f)).mtimeMs >= t);
}

/** The areas of the latest discovery session that nobody saw and nobody dropped, when no storyboard was written since it began. */
export function coverageProblem(projectDir: string, appDir: string): CoverageProblem | undefined {
  const last = listSessions(appDir).at(-1);
  if (!last) return undefined;
  const m = measureSession(appDir, last.id);
  if (!m.planned) return undefined;
  const missed = uncoveredAreas(m);
  if (!missed.length) return undefined;
  if (writtenSince(projectDir, last.startedAt)) return undefined;
  return {
    session: last.id,
    uncovered: missed.map((a) => ({
      name: a.name,
      status: a.status,
      looks: a.looks,
      acts: a.acts,
    })),
  };
}

/** What the Director is told when the storyboard is refused. */
export function coverageMessage(c: CoverageProblem): string {
  const list = c.uncovered
    .map(
      (a) =>
        `- ${a.name}${a.status === "done-empty" ? " (you marked it done, but nothing was seen there)" : a.looks + a.acts ? ` (${a.acts} action${a.acts === 1 ? "" : "s"}, no look)` : " (nothing seen)"}`,
    )
    .join("\n");
  return `storyboard not written: ${c.uncovered.length} area${c.uncovered.length === 1 ? "" : "s"} you declared in discovery session ${c.session} ${c.uncovered.length === 1 ? "was" : "were"} never seen:\n${list}\nExplore ${c.uncovered.length === 1 ? "it" : "them"} first (demo_rec_browser open, then look; declare routes with the plan so the pages are counted), or leave ${c.uncovered.length === 1 ? "it" : "each"} out on purpose by passing skipAreas: [{ area, why }] with this write. Nothing else changes.`;
}
