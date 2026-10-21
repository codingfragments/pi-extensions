/**
 * Findings (S5 part 5a, D48 / Q9): what discovery and the recordings found,
 * in one list.
 *
 * - **Agent findings** (`findings.jsonl`, append-only): what the Researcher /
 *   Director judges notable — a strength, a weakness or friction, a notable
 *   value, a candidate use case, a length concern — each with evidence.
 * - **Engine findings** (computed, never stored): error toasts, improvise
 *   fallbacks, retries/resumes, long dead time, blocked and state-changing
 *   discovery actions, and the rendered length vs. the target length. Stable
 *   ids (hash of kind + scene + text) so marks stick; duplicates across takes
 *   merge into one finding with several pieces of evidence.
 * - **Marks** (`{"mark": id, "state": …}` lines): `auto` (default — the
 *   director may pick it up), `use` (must end up in the recording and the
 *   narration), `ignore` (never brought up again).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effectiveFacts, formatLength } from "./brief.ts";
import { discoveryCutoff } from "./discovery-cutoff.ts";

export const FINDINGS_FILE = "findings.jsonl";

export type FindingState = "auto" | "use" | "ignore";
export const FINDING_STATES: readonly FindingState[] = ["auto", "use", "ignore"];

export const AGENT_KINDS = [
  "strength",
  "weakness",
  "friction",
  "value",
  "use-case",
  "length",
  "other",
] as const;
export const ENGINE_KINDS = [
  "error",
  "fallback",
  "retry",
  "dead-time",
  "blocked",
  "state-change",
  "length",
] as const;
export type FindingKind = (typeof AGENT_KINDS)[number] | (typeof ENGINE_KINDS)[number];

export type Evidence =
  | { type: "screen"; id: string }
  | { type: "take"; take: string; t: number; scene?: string }
  | { type: "url"; url: string }
  | { type: "file"; path: string };

export interface Finding {
  id: string;
  at: string;
  source: "agent" | "engine";
  stage: "discovery" | "recording" | "vo" | "render";
  kind: FindingKind;
  text: string;
  evidence: Evidence[];
  /** e.g. a suggested target length. */
  suggestion?: string;
  scene?: string;
  state: FindingState;
}

interface Entry extends Omit<Finding, "state"> {}
interface MarkLine {
  mark: string;
  state: FindingState;
  at: string;
}

function lines(projectDir: string): (Entry | MarkLine)[] {
  const file = path.join(projectDir, FINDINGS_FILE);
  if (!fs.existsSync(file)) return [];
  const out: (Entry | MarkLine)[] = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as Entry | MarkLine);
    } catch {
      // torn last line: skip
    }
  }
  return out;
}

function append(projectDir: string, line: Entry | MarkLine): void {
  const file = path.join(projectDir, FINDINGS_FILE);
  let sep = "";
  if (
    fs.existsSync(file) &&
    fs.statSync(file).size > 0 &&
    !fs.readFileSync(file, "utf8").endsWith("\n")
  )
    sep = "\n";
  fs.appendFileSync(file, `${sep}${JSON.stringify(line)}\n`);
}

export interface NewFinding {
  stage: Finding["stage"];
  kind: (typeof AGENT_KINDS)[number];
  text: string;
  evidence?: Evidence[];
  suggestion?: string;
  scene?: string;
}

/** Record an agent finding. */
export function recordFinding(projectDir: string, f: NewFinding, now = new Date()): Finding {
  const text = f.text.trim();
  if (!text) throw new Error("a finding needs text");
  if (!(AGENT_KINDS as readonly string[]).includes(f.kind))
    throw new Error(`unknown finding kind "${f.kind}" (${AGENT_KINDS.join(", ")})`);
  const n = lines(projectDir).filter((l) => !("mark" in l)).length + 1;
  const entry: Entry = {
    id: `f-${String(n).padStart(4, "0")}`,
    at: now.toISOString(),
    source: "agent",
    stage: f.stage,
    kind: f.kind,
    text: text.length > 1000 ? `${text.slice(0, 1000)}…` : text,
    evidence: f.evidence ?? [],
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    ...(f.scene ? { scene: f.scene } : {}),
  };
  append(projectDir, entry);
  return { ...entry, state: "auto" };
}

const engineId = (kind: string, scene: string | undefined, text: string) =>
  `e-${crypto
    .createHash("sha1")
    .update(
      `${kind}|${scene ?? ""}|${text
        .toLowerCase()
        .replace(/\d+(\.\d+)?\s*s\b/g, "#s")
        .replace(/\s+/g, " ")}`,
    )
    .digest("hex")
    .slice(0, 8)}`;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface AnalysisLite {
  scenes: {
    id: string;
    alerts?: { t: number; text: string; level: string }[];
    typed?: { t: number; text: string; improvised: boolean; source?: string }[];
    idle?: { start: number; end: number; source: string }[];
  }[];
}

/** Engine findings for a project: takes, discovery sessions of its app, rendered length. */
export function engineFindings(
  projectDir: string,
  opts: { appDir?: string; since?: string } = {},
): Omit<Finding, "state">[] {
  const byId = new Map<string, Omit<Finding, "state">>();
  const add = (f: Omit<Finding, "state" | "id">) => {
    const id = engineId(f.kind, f.scene, f.text);
    const cur = byId.get(id);
    if (cur) cur.evidence.push(...f.evidence);
    else byId.set(id, { id, ...f });
  };

  // Recordings
  const takes = path.join(projectDir, "takes");
  if (fs.existsSync(takes)) {
    for (const t of fs
      .readdirSync(takes)
      .filter((d) => /^take-\d{3,}$/.test(d))
      .sort()) {
      const dir = path.join(takes, t);
      const meta = readJson<{
        startedAt?: string;
        segments?: { resumedAfter?: string; start: number }[];
      }>(path.join(dir, "take.json"));
      const at = meta?.startedAt ?? new Date(0).toISOString();
      for (const seg of meta?.segments ?? [])
        if (seg.resumedAfter)
          add({
            at,
            source: "engine",
            stage: "recording",
            kind: "retry",
            text: `resumed after: ${seg.resumedAfter}`,
            evidence: [{ type: "take", take: t, t: seg.start }],
          });
      const a = readJson<AnalysisLite>(path.join(dir, "analysis", "analysis.json"));
      for (const s of a?.scenes ?? []) {
        for (const al of s.alerts ?? [])
          if (al.level === "error")
            add({
              at,
              source: "engine",
              stage: "recording",
              kind: "error",
              scene: s.id,
              text: `error shown: "${al.text}"`,
              evidence: [{ type: "take", take: t, t: al.t, scene: s.id }],
            });
        for (const ty of s.typed ?? [])
          if (ty.improvised && ty.source === "fallback")
            add({
              at,
              source: "engine",
              stage: "recording",
              kind: "fallback",
              scene: s.id,
              text: `improvise used its fallback text ("${ty.text.slice(0, 60)}")`,
              evidence: [{ type: "take", take: t, t: ty.t, scene: s.id }],
            });
        for (const r of s.idle ?? []) {
          const sec = (r.end - r.start) / 1000;
          if (r.source === "observer" && sec >= 5)
            add({
              at,
              source: "engine",
              stage: "recording",
              kind: "dead-time",
              scene: s.id,
              text: `the app is busy for ${sec.toFixed(0)} s (cut by the editor; worth mentioning if it's a real weakness)`,
              evidence: [{ type: "take", take: t, t: r.start, scene: s.id }],
            });
        }
      }
    }
  }

  // Discovery sessions of the app (since the project exists)
  const disc = opts.appDir ? path.join(opts.appDir, "discovery") : undefined;
  if (disc && fs.existsSync(disc)) {
    for (const session of fs.readdirSync(disc).sort()) {
      const audit = path.join(disc, session, "audit.jsonl");
      if (!fs.existsSync(audit)) continue;
      for (const l of fs.readFileSync(audit, "utf8").split("\n")) {
        if (!l.trim()) continue;
        let r: {
          at: string;
          action: string;
          target?: string;
          level: string;
          reason?: string;
          page?: string;
        };
        try {
          r = JSON.parse(l);
        } catch {
          continue;
        }
        if (opts.since && r.at < opts.since) continue;
        if (r.level !== "blocked" && r.level !== "mutating") continue;
        add({
          at: r.at,
          source: "engine",
          stage: "discovery",
          kind: r.level === "blocked" ? "blocked" : "state-change",
          text: `${r.level === "blocked" ? "blocked" : "state-changing"}: ${r.action} ${r.target ?? ""}${r.reason ? ` — ${r.reason}` : ""}`.trim(),
          evidence: r.page ? [{ type: "url", url: r.page }] : [],
        });
      }
    }
  }

  // Rendered length vs. the target length (latest edit timeline)
  const briefFile = path.join(projectDir, "brief.md");
  const target = fs.existsSync(briefFile)
    ? effectiveFacts(fs.readFileSync(briefFile, "utf8")).length
    : undefined;
  const edit = path.join(projectDir, "edit");
  if (target && fs.existsSync(edit)) {
    const latest = fs
      .readdirSync(edit)
      .map((f) => /^timeline\.v(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((x, y) => x - y)
      .at(-1);
    const tl = latest
      ? readJson<{
          full: { type: string; durationMs?: number }[];
          scenes: { durationMs: number }[];
        }>(path.join(edit, `timeline.v${latest}.json`))
      : undefined;
    if (tl) {
      const sec = Math.round(
        (tl.full.reduce((n, x) => n + (x.durationMs ?? 0), 0) +
          tl.scenes.reduce((n, x) => n + x.durationMs, 0)) /
          1000,
      );
      const [lo, hi] = target;
      if (sec < lo * 0.8 || sec > hi * 1.2) {
        const round = (x: number) => Math.max(30, Math.round(x / 30) * 30);
        add({
          at: fs.statSync(path.join(edit, `timeline.v${latest}.json`)).mtime.toISOString(),
          source: "engine",
          stage: "render",
          kind: "length",
          text: `the edited video is ${sec} s, the target is ${formatLength(target)}`,
          suggestion: `target length ${formatLength([round(sec * 0.9), round(sec * 1.1)])} — or cut/extend scenes`,
          evidence: [{ type: "file", path: `edit/timeline.v${latest}.json` }],
        });
      }
    }
  }
  return [...byId.values()];
}

/** Agent + engine findings with their marks, newest first. */
export function listFindings(
  projectDir: string,
  opts: { appDir?: string; since?: string } = {},
): Finding[] {
  const marks = new Map<string, FindingState>();
  const agent: Entry[] = [];
  for (const l of lines(projectDir)) {
    if ("mark" in l) marks.set(l.mark, l.state);
    else agent.push(l);
  }
  // a project that forgot its discovery does not see the discovery findings from before (nothing is deleted)
  const cutoff = discoveryCutoff(projectDir);
  return [...agent, ...engineFindings(projectDir, opts)]
    .filter((f) => !(cutoff && f.stage === "discovery" && f.at < cutoff))
    .map((f) => ({ ...f, state: marks.get(f.id) ?? "auto" }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function markFinding(
  projectDir: string,
  id: string,
  state: FindingState,
  opts: { appDir?: string } = {},
  now = new Date(),
): Finding {
  if (!FINDING_STATES.includes(state))
    throw new Error(`state must be ${FINDING_STATES.join(" | ")}`);
  const f = listFindings(projectDir, opts).find((x) => x.id === id);
  if (!f) throw new Error(`no finding ${id} in this project`);
  append(projectDir, { mark: id, state, at: now.toISOString() });
  return { ...f, state };
}

const evidenceText = (e: Evidence) =>
  e.type === "screen"
    ? `screen ${e.id}`
    : e.type === "take"
      ? `${e.take} @${(e.t / 1000).toFixed(1)}s${e.scene ? ` (${e.scene})` : ""}`
      : e.type === "url"
        ? e.url
        : e.path;

/** The findings part of the agent's project context: use (must cover) first, then auto; ignored left out. */
export function formatFindings(findings: Finding[], opts: { max?: number } = {}): string {
  const use = findings.filter((f) => f.state === "use");
  const auto = findings.filter((f) => f.state === "auto").slice(0, opts.max ?? 40);
  const ignored = findings.filter((f) => f.state === "ignore").length;
  const line = (f: Finding) =>
    `- ${f.id} [${f.kind}/${f.source}, ${f.stage}${f.scene ? `, ${f.scene}` : ""}] ${f.text}${f.suggestion ? ` → suggestion: ${f.suggestion}` : ""}${f.evidence.length ? ` (evidence: ${f.evidence.slice(0, 3).map(evidenceText).join("; ")}${f.evidence.length > 3 ? ` +${f.evidence.length - 3}` : ""})` : ""}`;
  const out: string[] = [];
  out.push(
    use.length
      ? `USE — must appear in the recording AND the narration (list them in the storyboard scene's \`findings:\`):\n${use.map(line).join("\n")}`
      : "USE — none marked",
  );
  out.push(
    auto.length ? `AUTO — candidates, your call:\n${auto.map(line).join("\n")}` : "AUTO — none",
  );
  if (ignored) out.push(`(${ignored} marked IGNORE by the user — never bring them up)`);
  return out.join("\n");
}

/** "use" findings not covered by any scene of a storyboard (`scenes[].findings`). */
export function uncoveredUseFindings(
  findings: Finding[],
  scenes: { id: string; findings?: string[] }[],
): Finding[] {
  const covered = new Set(scenes.flatMap((s) => s.findings ?? []));
  return findings.filter((f) => f.state === "use" && !covered.has(f.id));
}

export const evidenceLabel = evidenceText;
