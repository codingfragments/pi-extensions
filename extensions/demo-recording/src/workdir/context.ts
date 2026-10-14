/**
 * The project's memory as one text (D42): what the agent reads on
 * (re)opening a project and what the panel's Project context view shows.
 */

import fs from "node:fs";
import path from "node:path";
import { formatInputs, readInputs } from "./inputs.ts";
import { formatStageStatus, stageStatus } from "./stages.ts";
import { readState } from "./state.ts";
import { listVersions } from "./versioning.ts";

const BRIEF_LIMIT = 8000;

/**
 * The project's memory, as the agent should read it (D42): brief, stage
 * lineage with stale flags, and every input that is not marked outdated.
 * The panel's Project context view shows the same data.
 */
export function projectContext(projectDir: string, slug: string): string {
  const state = readState(projectDir);
  if (!state) throw new Error(`no state.json in ${projectDir}`);
  const briefFile = path.join(projectDir, "brief.md");
  const brief = fs.existsSync(briefFile)
    ? fs.readFileSync(briefFile, "utf8").trim()
    : "(no brief yet)";
  const briefVersions = listVersions(path.join(projectDir, "brief"), "v", ".md").length;
  const all = readInputs(projectDir, { includeOutdated: true });
  const active = all.filter((e) => !e.outdated);
  return [
    `# Project context: ${slug} (phase: ${state.phase})`,
    "",
    `## Brief (brief.md, ${briefVersions} version(s))`,
    brief.length > BRIEF_LIMIT
      ? `${brief.slice(0, BRIEF_LIMIT)}\n…(truncated; demo_rec_project read_brief for all)`
      : brief,
    "",
    "## Stages (lineage)",
    formatStageStatus(stageStatus(projectDir, state.approved)),
    "",
    `## Inputs (${active.length} active${all.length > active.length ? `, ${all.length - active.length} marked outdated and left out` : ""}; newest first)`,
    formatInputs(active),
    "",
    "Follow the active inputs unless the user now says otherwise. Outdated inputs were withdrawn by the user — ignore them.",
  ].join("\n");
}
