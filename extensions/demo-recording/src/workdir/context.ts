/**
 * The project's memory as one text (D42): what the agent reads on
 * (re)opening a project and what the panel's Project context view shows.
 */

import fs from "node:fs";
import path from "node:path";
import { formatReport, readReport } from "../discovery/report.ts";
import { formatPending } from "../qa/apply.ts";
import { formatFixSets } from "../qa/fixes.ts";
import { formatIgnores } from "../qa/ignores.ts";
import { questionsContext } from "../questions.ts";
import { DEPTH_DEFAULTS, effectiveFacts, formatLength } from "./brief.ts";
import { formatFindings, listFindings } from "./findings.ts";
import { formatInputs, readInputs } from "./inputs.ts";
import { formatLine, formatStageStatus, stageStatus } from "./stages.ts";
import { readState } from "./state.ts";
import { listVersions } from "./versioning.ts";

const BRIEF_LIMIT = 8000;

/** `<root>/apps/<app>` for a project dir `<root>/projects/<slug>` (discovery lives in the app folder). */
export function appDirOf(projectDir: string, app: string): string {
  return path.join(path.dirname(path.dirname(projectDir)), "apps", app);
}

/** One-paragraph summary of the project facts with depth defaults made explicit. */
export function factsSummary(brief: string): string {
  const e = effectiveFacts(brief);
  const f = e.facts;
  const parts = [
    `title: ${f.title ?? "—"}${f.subtitle ? ` / subtitle: ${f.subtitle}` : ""}`,
    `persona: ${f.persona ?? "—"}`,
    `depth: ${e.depth ? `${e.depth} (${DEPTH_DEFAULTS[e.depth].label})` : "— (not set)"}`,
    `stance: ${e.stance ? `${e.stance}${e.stanceFromDepth ? " (depth default)" : ""}` : "—"}`,
    `target length: ${e.length ? `${formatLength(e.length)}${e.lengthFromDepth ? " (depth default)" : ""}` : "—"}`,
    `URL: ${f.url ?? "—"}${e.extraUrls.length ? ` + ${e.extraUrls.join(", ")}` : ""}`,
  ];
  return parts.join(" · ");
}

/** Accepted fixes that wait for their stage: the stage's writer reads them when its turn comes (P1c Q4/Q5, D-QA-9). */
function pendingFixes(projectDir: string): string[] {
  const lines = formatPending(projectDir);
  return lines.length
    ? ["", "## Pending fixes (accepted by the user, for a later stage)", ...lines]
    : [];
}

/** The QA fix sets in progress: what the user flagged and what the Director proposed (P1c Q3). */
function qaFixes(projectDir: string): string[] {
  const lines = formatFixSets(projectDir);
  return lines.length ? ["", "## QA fixes in progress", ...lines] : [];
}

/** What the user decided to leave alone in the QA, so the Director does not raise it again (P1a Q2). */
function qaDecisions(projectDir: string): string[] {
  const lines = formatIgnores(projectDir);
  return lines.length ? ["", "## QA decisions (what the user left alone)", ...lines] : [];
}

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
  const findings = listFindings(projectDir, {
    appDir: appDirOf(projectDir, state.app),
    since: state.createdAt,
  });
  return [
    `# Project context: ${slug} (phase: ${state.phase})`,
    "",
    "## Project facts",
    factsSummary(brief),
    "",
    `## Brief (brief.md, ${briefVersions} version(s))`,
    brief.length > BRIEF_LIMIT
      ? `${brief.slice(0, BRIEF_LIMIT)}\n…(truncated; demo_rec_project read_brief for all)`
      : brief,
    "",
    "## Stages (lineage)",
    `working line: ${formatLine(state.line)}`,
    formatStageStatus(stageStatus(projectDir, state.accepted, state.line)),
    "",
    `## Inputs (${active.length} active${all.length > active.length ? `, ${all.length - active.length} marked outdated and left out` : ""}; newest first)`,
    formatInputs(active),
    "",
    `## Findings (${findings.length}; from discovery, recordings and the engine)`,
    formatFindings(findings),
    ...discoveryReport(projectDir),
    ...questionsContext(projectDir),
    ...qaDecisions(projectDir),
    ...qaFixes(projectDir),
    ...pendingFixes(projectDir),
    "",
    "Follow the active inputs unless the user now says otherwise. Outdated inputs were withdrawn by the user — ignore them.",
  ].join("\n");
}

/** The latest discovery report in brief (D2): the storyboard follows its guidance; the whole text is demo_rec_discovery get. */
function discoveryReport(projectDir: string): string[] {
  const r = readReport(projectDir);
  if (!r) return [];
  return [
    "",
    "## Discovery report (follow its guidance when writing the storyboard; demo_rec_discovery get for the evidence)",
    formatReport(r),
  ];
}
