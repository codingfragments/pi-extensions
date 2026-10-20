/**
 * The discovery report (item 10, D2; F2): what discovery found about the app, what the extra research (sources, notes, links)
 * added, and the guidance the Director carries into the storyboard (use cases, must-show, risks, things to avoid). A project artifact,
 * versioned and immutable like the others, written by the Director through a tool that REFUSES a claim without real evidence:
 * every item cites a finding, a screen the session saw, or a source of the project, and an id that does not exist is refused.
 * The coverage is not the Director's to write: the engine fills it from what it measured (measure.ts), so the report cannot claim
 * areas nobody saw.
 */

import fs from "node:fs";
import path from "node:path";
import { listFindings } from "../workdir/findings.ts";
import { readInputs } from "../workdir/inputs.ts";
import { latestVersion, listVersions, writeNextVersion } from "../workdir/versioning.ts";
import { measureSession } from "./coverage.ts";
import type { AreaMeasure } from "./measure.ts";
import { listSessions, sessionsDir } from "./state.ts";

export const LIMITS = {
  summary: 600,
  text: 260,
  title: 90,
  why: 260,
  found: [2, 12] as [number, number],
  research: [0, 8] as [number, number],
  useCases: [1, 6] as [number, number],
  group: [0, 8] as [number, number],
};

export const GUIDANCE_KEYS = ["useCases", "mustShow", "risks", "avoid"] as const;
export type GuidanceKey = (typeof GUIDANCE_KEYS)[number];
export const GUIDANCE_WORD: Record<GuidanceKey, string> = {
  useCases: "use cases",
  mustShow: "must show",
  risks: "risks",
  avoid: "avoid",
};

export interface ReportItem {
  text: string;
  /** Evidence ids: a finding `f-0004`, a screen `20261017-140044/s012`, a source `file:context/x.pdf`, `ref:https://…` or `input:in-0003`. */
  evidence: string[];
}
export interface GuidanceItem {
  title: string;
  why: string;
  evidence: string[];
}

export interface CoverageArea {
  name: string;
  status: string;
  looks: number;
  acts: number;
  droppedWhy?: string;
}

export interface DiscoveryReport {
  version: number;
  at: string;
  summary: string;
  found: ReportItem[];
  research: ReportItem[];
  guidance: Record<GuidanceKey, GuidanceItem[]>;
  /** Filled by the engine when the report is stored: what was measured, not what the Director says. */
  coverage: {
    sessions: { id: string; areas: CoverageArea[] }[];
    findings: number;
    sources: { files: number; refs: number };
  };
}

export type ReportAnswer = {
  summary?: unknown;
  found?: unknown;
  research?: unknown;
  guidance?: unknown;
};

const dirOf = (projectDir: string) => path.join(projectDir, "discovery-report");
export const reportVersions = (projectDir: string) =>
  listVersions(dirOf(projectDir), "report.v", ".json");

export function readReport(projectDir: string, version?: number): DiscoveryReport | undefined {
  const v = version ?? latestVersion(dirOf(projectDir), "report.v", ".json");
  if (v === undefined) return undefined;
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dirOf(projectDir), `report.v${v}.json`), "utf8"),
    ) as DiscoveryReport;
  } catch {
    return undefined;
  }
}

/** The sources of the project: files under context/, links and notes the user gave. */
export function projectSources(projectDir: string): {
  files: string[];
  refs: string[];
  inputs: string[];
} {
  const ctx = path.join(projectDir, "context");
  const files = fs.existsSync(ctx)
    ? fs
        .readdirSync(ctx, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map(
          (d) =>
            `context/${path
              .relative(ctx, path.join(d.parentPath ?? ctx, d.name))
              .split(path.sep)
              .join("/")}`,
        )
    : [];
  const inputs = readInputs(projectDir).filter(
    (i) => (i.kind === "source" || i.kind === "asset") && !i.outdated,
  );
  return { files, refs: inputs.flatMap((i) => i.refs ?? []), inputs: inputs.map((i) => i.id) };
}

/** What an evidence id points at: "finding" | "screen" | "source", or undefined when nothing is there. */
export function evidenceKind(
  projectDir: string,
  appDir: string,
  id: string,
): "finding" | "screen" | "source" | undefined {
  const e = id.trim();
  if (/^f-\d+$/.test(e))
    return listFindings(projectDir, { appDir }).some((f) => f.id === e) ? "finding" : undefined;
  const screen = /^([\w-]+)\/(s\d+)$/.exec(e);
  if (screen)
    return fs.existsSync(
      path.join(sessionsDir(appDir), screen[1] as string, "screens", `${screen[2]}.jpg`),
    )
      ? "screen"
      : undefined;
  const src = projectSources(projectDir);
  if (e.startsWith("file:")) return src.files.includes(e.slice(5)) ? "source" : undefined;
  if (e.startsWith("ref:")) return src.refs.includes(e.slice(4)) ? "source" : undefined;
  if (e.startsWith("input:")) return src.inputs.includes(e.slice(6)) ? "source" : undefined;
  return undefined;
}

const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** What is wrong with an answer, in words the Director can act on. Empty when it is acceptable. */
export function reportProblems(projectDir: string, appDir: string, ans: ReportAnswer): string[] {
  const out: string[] = [];
  const sources = projectSources(projectDir);
  const hasSources = sources.files.length + sources.refs.length > 0;
  const summary = text(ans.summary);
  if (!summary) out.push("summary is required: what discovery found, in a few sentences");
  else if (summary.length > LIMITS.summary)
    out.push(`summary is ${summary.length} characters; keep it to ${LIMITS.summary}`);

  const check = (where: string, evidence: unknown, allow: ("finding" | "screen" | "source")[]) => {
    const ids = list(evidence).map(text).filter(Boolean);
    if (!ids.length) return out.push(`${where} cites no evidence: name a ${allow.join(" or ")}`);
    for (const id of ids) {
      const k = evidenceKind(projectDir, appDir, id);
      if (!k)
        out.push(
          `${where} cites "${id}", which does not exist here (findings f-0001, screens <session>/s001, sources file:context/x, ref:https://…, input:in-0001)`,
        );
      else if (!allow.includes(k))
        out.push(`${where} cites "${id}", a ${k}: this part must cite a ${allow.join(" or ")}`);
    }
  };
  const items = (
    key: string,
    raw: unknown,
    [min, max]: [number, number],
    allow: ("finding" | "screen" | "source")[],
  ) => {
    const arr = list(raw) as { text?: unknown; evidence?: unknown }[];
    if (arr.length < min || arr.length > max)
      out.push(`${key}: give ${min} to ${max} items (you gave ${arr.length})`);
    arr.forEach((it, i) => {
      const t = text(it?.text);
      const where = `${key} ${i + 1}`;
      if (!t) out.push(`${where} says nothing`);
      else if (t.length > LIMITS.text)
        out.push(`${where} is ${t.length} characters; keep it to ${LIMITS.text}`);
      check(where, it?.evidence, allow);
    });
  };
  items("found", ans.found, LIMITS.found, ["finding", "screen"]);
  // the research: what the project's own sources added. Without sources there is nothing to report, and nothing may be invented
  const research = list(ans.research);
  if (hasSources) {
    if (!research.length)
      out.push(
        `research: the project has ${sources.files.length + sources.refs.length} source(s) (${[...sources.files, ...sources.refs].slice(0, 4).join(", ")}${sources.files.length + sources.refs.length > 4 ? ", …" : ""}); say what they added, citing them`,
      );
    else items("research", research, LIMITS.research, ["source"]);
  } else if (research.length)
    out.push(
      "research must be empty: the project has no sources (files, links or notes), so there is nothing that could have added anything",
    );

  const g = (ans.guidance ?? {}) as Record<string, unknown>;
  for (const key of GUIDANCE_KEYS) {
    const raw = list(g[key]) as { title?: unknown; why?: unknown; evidence?: unknown }[];
    const [min, max] = key === "useCases" ? LIMITS.useCases : LIMITS.group;
    const word = GUIDANCE_WORD[key];
    if (raw.length < min || raw.length > max)
      out.push(`guidance ${word}: give ${min} to ${max} items (you gave ${raw.length})`);
    raw.forEach((it, i) => {
      const where = `${word} ${i + 1}`;
      const title = text(it?.title);
      const why = text(it?.why);
      if (!title) out.push(`${where} needs a title`);
      else if (title.length > LIMITS.title)
        out.push(`${where}: the title is ${title.length} characters; keep it to ${LIMITS.title}`);
      if (!why) out.push(`${where} needs a why`);
      else if (why.length > LIMITS.why)
        out.push(`${where}: the why is ${why.length} characters; keep it to ${LIMITS.why}`);
      check(where, it?.evidence, ["finding", "screen", "source"]);
    });
  }
  return out;
}

/** The engine's own account of what discovery covered: every session, every area, and how much there is to cite. */
export function coverageOf(projectDir: string, appDir: string): DiscoveryReport["coverage"] {
  const sessions = listSessions(appDir).map((s) => ({
    id: s.id,
    areas: measureSession(appDir, s.id).areas.map(
      (a: AreaMeasure): CoverageArea => ({
        name: a.name,
        status: a.status,
        looks: a.looks,
        acts: a.acts,
        ...(a.droppedWhy ? { droppedWhy: a.droppedWhy } : {}),
      }),
    ),
  }));
  const src = projectSources(projectDir);
  return {
    sessions,
    findings: listFindings(projectDir, { appDir }).filter((f) => f.stage === "discovery").length,
    sources: { files: src.files.length, refs: src.refs.length },
  };
}

const clean = <T extends { evidence?: unknown }>(it: T) => ({
  ...it,
  evidence: [...new Set(list(it.evidence).map(text).filter(Boolean))],
});

/** Validate, fill the coverage from the engine, and store as the next version. Throws with every problem at once. */
export function writeReport(
  projectDir: string,
  appDir: string,
  ans: ReportAnswer,
  now = new Date(),
): DiscoveryReport {
  const problems = reportProblems(projectDir, appDir, ans);
  if (problems.length)
    throw new Error(`report not stored, fix these:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  const g = ans.guidance as Record<
    GuidanceKey,
    { title: string; why: string; evidence: unknown }[]
  >;
  const body = {
    at: now.toISOString(),
    summary: text(ans.summary),
    found: (ans.found as ReportItem[]).map((x) => ({
      text: text(x.text),
      evidence: clean(x).evidence as string[],
    })),
    research: (list(ans.research) as ReportItem[]).map((x) => ({
      text: text(x.text),
      evidence: clean(x).evidence as string[],
    })),
    guidance: Object.fromEntries(
      GUIDANCE_KEYS.map((k) => [
        k,
        list(g[k]).map((x) => ({
          title: text((x as GuidanceItem).title),
          why: text((x as GuidanceItem).why),
          evidence: clean(x as GuidanceItem).evidence as string[],
        })),
      ]),
    ) as DiscoveryReport["guidance"],
    coverage: coverageOf(projectDir, appDir),
  };
  const stored = writeNextVersion(
    dirOf(projectDir),
    "report.v",
    ".json",
    `${JSON.stringify({ version: 0, ...body }, null, 2)}\n`,
  );
  const report: DiscoveryReport = { version: stored.version, ...body };
  fs.writeFileSync(stored.file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** The report as text for the Director and the project context: the claims, the guidance, what was measured. */
export function formatReport(r: DiscoveryReport, opts: { full?: boolean } = {}): string {
  const ids = (e: string[]) => ` [${e.join(", ")}]`;
  const lines = [
    `Discovery report v${r.version} (${r.at.slice(0, 16).replace("T", " ")}): ${r.summary}`,
  ];
  if (opts.full) {
    lines.push("Found:", ...r.found.map((x) => `- ${x.text}${ids(x.evidence)}`));
    if (r.research.length)
      lines.push(
        "What the research added:",
        ...r.research.map((x) => `- ${x.text}${ids(x.evidence)}`),
      );
  }
  for (const k of GUIDANCE_KEYS)
    if (r.guidance[k].length)
      lines.push(
        `${GUIDANCE_WORD[k][0]?.toUpperCase()}${GUIDANCE_WORD[k].slice(1)}:`,
        ...r.guidance[k].map((x) => `- ${x.title}: ${x.why}${opts.full ? ids(x.evidence) : ""}`),
      );
  const last = r.coverage.sessions.at(-1);
  if (last) {
    const seen = last.areas.filter((a) => a.looks > 0).length;
    lines.push(
      `Coverage (measured): ${seen} of ${last.areas.length} areas seen in session ${last.id}${last.areas.filter((a) => a.status === "dropped").length ? `, ${last.areas.filter((a) => a.status === "dropped").length} left out` : ""}.`,
    );
  }
  return lines.join("\n");
}

/** The report that was current when a storyboard version was written: the newest one stored before that file's last write. */
export function reportFor(projectDir: string, storyboardFile: string): DiscoveryReport | undefined {
  let t: number;
  try {
    t = fs.statSync(storyboardFile).mtimeMs;
  } catch {
    return undefined;
  }
  return [...reportVersions(projectDir)]
    .reverse()
    .map((v) => readReport(projectDir, v))
    .find((r) => r && Date.parse(r.at) <= t);
}

/** What the Director reads before writing a report: what it may cite, what changed since the last one, and the rules. */
export function reportBrief(projectDir: string, appDir: string): string {
  const findings = listFindings(projectDir, { appDir }).filter(
    (f) => f.stage === "discovery" || f.stage === "recording",
  );
  const sessions = listSessions(appDir);
  const src = projectSources(projectDir);
  const prev = readReport(projectDir);
  const cov = coverageOf(projectDir, appDir);
  const shots = (id: string) => {
    try {
      return fs
        .readdirSync(path.join(sessionsDir(appDir), id, "screens"))
        .filter((f) => f.endsWith(".jpg"))
        .map((f) => f.replace(".jpg", ""));
    } catch {
      return [];
    }
  };
  return [
    "# Discovery report: what you may cite and the rules",
    "",
    `## Findings (${findings.length}). Cite by id.`,
    ...findings.map(
      (f) =>
        `- ${f.id} [${f.kind}] ${f.text.slice(0, 160)}${f.state === "use" ? " (the user marked it USE)" : f.state === "ignore" ? " (the user marked it IGNORE)" : ""}`,
    ),
    "",
    `## Sessions and screens (${sessions.length}). Cite a screen as <session>/<sNNN>.`,
    ...sessions.map((s) => {
      const sh = shots(s.id);
      return `- ${s.id}: ${s.screens} screen(s)${sh.length ? ` (${sh[0]} to ${sh.at(-1)})` : ""}, ${s.actions} action(s)${s.exhausted ? ", budget used up" : ""}`;
    }),
    "",
    "## What was measured per area (the engine fills the coverage: do not claim more)",
    ...cov.sessions.flatMap((s) => [
      `- session ${s.id}`,
      ...s.areas.map(
        (a) =>
          `  - ${a.name}: ${a.status === "dropped" ? `left out (${a.droppedWhy})` : `${a.looks} look(s), ${a.acts} action(s)${a.status === "done-empty" ? " (marked done, nothing seen)" : ""}`}`,
      ),
    ]),
    "",
    `## Sources (${src.files.length + src.refs.length})`,
    ...(src.files.length + src.refs.length
      ? [
          ...src.files.map((f) => `- file:${f}`),
          ...src.refs.map((r) => `- ref:${r}`),
          ...src.inputs.map((i) => `- input:${i} (a note or link the user gave)`),
        ]
      : ["- none: leave research empty"]),
    "",
    prev
      ? `## The latest report (v${prev.version}) — ${sessions.length > (prev.coverage.sessions.length) ? "there are newer sessions: say what they added" : "update it where the project changed"}\n${formatReport(prev, { full: true })}`
      : "## No report yet",
    "",
    "## How to answer (demo_rec_discovery report)",
    `- summary: what discovery found, a few sentences (at most ${LIMITS.summary} characters).`,
    `- found: ${LIMITS.found[0]}-${LIMITS.found[1]} items { text, evidence } about the APP; each cites findings (f-…) or screens (<session>/s…), at most ${LIMITS.text} characters.`,
    "- research: items about what the SOURCES added, each citing file:/ref:/input: ids; give none if the project has no sources, and some if it has.",
    `- guidance: { useCases (${LIMITS.useCases[0]}-${LIMITS.useCases[1]}), mustShow, risks, avoid } each an item { title (≤ ${LIMITS.title}), why (≤ ${LIMITS.why}), evidence } citing any finding, screen or source. Use cases are what the storyboard should build scenes from; risks are what could go wrong on camera; avoid is what not to show.`,
    "A claim without evidence, or with an id that does not exist, is refused with the reason; fix it and answer again. Respect the user's USE and IGNORE marks. You cannot write the storyboard from here: stop after report.",
  ].join("\n");
}
