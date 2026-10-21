/**
 * Forget the discovery of a project and start again (the Discovery group's "Forget…"). Everything is SET ASIDE, nothing is deleted:
 *  - the sessions stay with the app (other projects of it keep theirs), the project simply stops seeing the ones before the reset (discovery-cutoff.ts);
 *  - its discovery findings before the reset are hidden the same way (findings.ts);
 *  - the report folder and the request list are moved next to where they were, with the time in their name;
 *  - the discovery entries of the project's history are marked outdated with the reason, so the Director's memory no longer carries them.
 * Refused while a session is open or the Director has been asked and not answered (take the request back first).
 */

import fs from "node:fs";
import path from "node:path";
import { type ResetRecord, appendReset } from "../workdir/discovery-cutoff.ts";
import { listFindings } from "../workdir/findings.ts";
import { markInput, readInputs } from "../workdir/inputs.ts";
import { reportVersions } from "./report.ts";
import { readRequests } from "./requests.ts";
import { listSessions } from "./state.ts";

export interface ForgetPreview {
  sessions: number;
  findings: number;
  reportVersions: number;
  requests: number;
  inputs: number;
}

/** What a reset would set aside, counted now. */
export function forgetPreview(projectDir: string, appDir: string): ForgetPreview {
  return {
    sessions: listSessions(appDir, projectDir).length,
    findings: listFindings(projectDir, { appDir }).filter((f) => f.stage === "discovery").length,
    reportVersions: reportVersions(projectDir).length,
    requests: readRequests(projectDir).length,
    inputs: discoveryInputs(projectDir).length,
  };
}

const discoveryInputs = (projectDir: string) =>
  readInputs(projectDir).filter((e) => e.stage === "discovery" && e.kind === "direction");

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export function forgetDiscovery(projectDir: string, appDir: string, now = new Date()): ResetRecord {
  const before = forgetPreview(projectDir, appDir);
  const st = stamp(now);
  const setAside: string[] = [];
  const move = (from: string, to: string) => {
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, to);
    setAside.push(path.basename(to));
  };
  move(
    path.join(projectDir, "discovery-report"),
    path.join(projectDir, `discovery-report.set-aside-${st}`),
  );
  move(
    path.join(projectDir, "discovery-requests.json"),
    path.join(projectDir, `discovery-requests.set-aside-${st}.json`),
  );
  // the earlier runs' own history lines no longer belong to the Director's memory (what the user wrote as notes and sources stays)
  for (const e of discoveryInputs(projectDir))
    markInput(
      projectDir,
      e.id,
      true,
      `discovery was forgotten on ${now.toISOString().slice(0, 16).replace("T", " ")}`,
      now,
    );
  const rec: ResetRecord = { at: now.toISOString(), ...before, setAside };
  appendReset(projectDir, rec);
  return rec;
}
