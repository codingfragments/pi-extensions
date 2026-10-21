/**
 * "Forget the discovery so far": a project can set aside everything its discovery has found and start again. Nothing is deleted. A reset leaves a record with a time
 * (`discovery-reset.json`); from then on the project does not see sessions that began before it, discovery findings made before it, nor the report and requests (those are
 * moved aside by the reset itself). The sessions live with the app, so other projects of the same app keep theirs. A leaf module: it reads one small file.
 */

import fs from "node:fs";
import path from "node:path";

export interface ResetRecord {
  at: string;
  /** What was set aside, for the history and the confirmation. */
  sessions: number;
  findings: number;
  reportVersions: number;
  requests: number;
  inputs: number;
  /** Where the report and the requests went. */
  setAside: string[];
}

const file = (projectDir: string) => path.join(projectDir, "discovery-reset.json");

export function readResets(projectDir: string): ResetRecord[] {
  try {
    const list = JSON.parse(fs.readFileSync(file(projectDir), "utf8")) as ResetRecord[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function appendReset(projectDir: string, rec: ResetRecord): void {
  fs.writeFileSync(
    file(projectDir),
    `${JSON.stringify([...readResets(projectDir), rec], null, 2)}\n`,
  );
}

/** The time of the latest reset: what began before it is forgotten. Undefined when the discovery was never reset. */
export function discoveryCutoff(projectDir: string): string | undefined {
  return readResets(projectDir).at(-1)?.at;
}
