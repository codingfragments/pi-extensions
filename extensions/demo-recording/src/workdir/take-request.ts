/**
 * What the Recording tab's "Request a new take" asked for besides the take itself: today, whether to show the browser window (a real browser sometimes shows what a
 * hidden one hides). The Director records the take with demo_rec_record; this file is how the choice reaches that call even if the Director forgets to pass it on.
 * Consumed when the take starts.
 */

import fs from "node:fs";
import path from "node:path";

export interface TakeRequest {
  storyboard: number;
  headed: boolean;
  at: string;
}

const file = (projectDir: string) => path.join(projectDir, "take-request.json");

export function writeTakeRequest(
  projectDir: string,
  r: Omit<TakeRequest, "at">,
  now = new Date(),
): void {
  fs.writeFileSync(
    file(projectDir),
    `${JSON.stringify({ ...r, at: now.toISOString() }, null, 2)}\n`,
  );
}

export function readTakeRequest(projectDir: string, storyboard?: number): TakeRequest | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(file(projectDir), "utf8")) as TakeRequest;
    return storyboard === undefined || r.storyboard === storyboard ? r : undefined;
  } catch {
    return undefined;
  }
}

export function clearTakeRequest(projectDir: string): void {
  fs.rmSync(file(projectDir), { force: true });
}
