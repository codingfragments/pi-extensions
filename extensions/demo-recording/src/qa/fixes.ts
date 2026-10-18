/**
 * Fix sets: you flag findings, the Director proposes how to fix them, you refine, and nothing changes until you apply
 * (P1c Q3, D-QA-2 and D-QA-7).
 *
 * The goal of a proposal round is ONE run at the EARLIEST stage that needs a fix, fixing as many problems as possible: so a round has
 * **at most one proposal per stage** (the tool refuses two for the same stage: merge them), every flagged finding is either answered by a
 * proposal or named as unresolved with a reason, and the earliest stage is computed, not guessed. A round can be asked again with more
 * of your context ("rethink"): the Director then sees the earlier rounds, your decisions and your notes. Proposals are text; this module
 * never applies anything (applying is the next step, and it is yours).
 *
 * Stored in the project: `fixes/fs-<n>.json`, one per render the findings come from.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../workdir/versioning.ts";
import { activeIgnores } from "./ignores.ts";
import { readQa } from "./run.ts";
import type { QaItem } from "./types.ts";

/** The stages a fix can belong to, earliest first. `render` means "render again after the others". */
export const FIX_STAGES = [
  "discovery",
  "storyboard",
  "recording",
  "vo",
  "annotations",
  "render",
] as const;
export type FixStage = (typeof FIX_STAGES)[number];

export const FIX_STAGE_WORD: Record<FixStage, string> = {
  discovery: "discovery",
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice-over",
  annotations: "annotations",
  render: "render",
};

export interface Flag {
  /** The finding's id in the render's QA report. */
  id: string;
  choice: "fix" | "leave";
}

export interface Proposal {
  id: string;
  stage: FixStage;
  /** One line. */
  title: string;
  /** What would change, concretely, in plain text (one run at this stage). */
  change: string;
  /** Why this fixes the findings. */
  why: string;
  /** The findings it answers (ids of the render's report). */
  findings: string[];
  /** What applying it would cost, in the Director's words ("nothing", "re-synthesises two sections: about 480 characters"). */
  cost?: string;
  /** Your decision. */
  decision: "undecided" | "accepted" | "rejected";
  /** Your own wording of the change, when you edited it. */
  edited?: string;
  /** Your note on this proposal. */
  note?: string;
}

export interface Round {
  n: number;
  askedAt: string;
  /** The flags and guidance of this round, as they were when you asked. */
  flags: Flag[];
  guidance: string;
  status: "asked" | "proposed" | "failed";
  proposedAt?: string;
  /** The Director's reasoning in a few sentences. */
  summary?: string;
  proposals?: Proposal[];
  /** Findings it could not fix, with why (an honest "I can't"). */
  unresolved?: { finding: string; why: string }[];
  /** The earliest stage among the proposals. */
  earliest?: FixStage;
}

export interface FixSet {
  id: string;
  /** The render whose findings it answers. */
  render: number;
  createdAt: string;
  status: "open" | "applied" | "withdrawn";
  /** What you have flagged and written but not yet asked about. */
  draft: { flags: Flag[]; guidance: string };
  rounds: Round[];
}

const dir = (projectDir: string) => path.join(projectDir, "fixes");
const file = (projectDir: string, id: string) => path.join(dir(projectDir), `${id}.json`);

export function listFixSets(projectDir: string): FixSet[] {
  if (!fs.existsSync(dir(projectDir))) return [];
  return fs
    .readdirSync(dir(projectDir))
    .filter((f) => /^fs-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(3, -5)) - Number(b.slice(3, -5)))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir(projectDir), f), "utf8")) as FixSet);
}

export function readFixSet(projectDir: string, id: string): FixSet | undefined {
  const f = file(projectDir, id);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as FixSet) : undefined;
}

function save(projectDir: string, set: FixSet): void {
  writeFileAtomic(file(projectDir, set.id), `${JSON.stringify(set, null, 2)}\n`);
}

/** The open fix set of a render (created when there is none). */
export function openFixSet(projectDir: string, render: number, now = new Date()): FixSet {
  const have = listFixSets(projectDir).find((s) => s.render === render && s.status === "open");
  if (have) return have;
  const all = listFixSets(projectDir);
  const n = all.reduce((m, s) => Math.max(m, Number(s.id.slice(3))), 0) + 1;
  const set: FixSet = {
    id: `fs-${n}`,
    render,
    createdAt: now.toISOString(),
    status: "open",
    draft: { flags: [], guidance: "" },
    rounds: [],
  };
  save(projectDir, set);
  return set;
}

/** The findings of the render's report that can be flagged: everything but a broken file, what is ignored, and info. */
export function flaggable(projectDir: string, render: number): QaItem[] {
  return (readQa(projectDir, render)?.items ?? []).filter(
    (i) => i.hard !== "integrity" && !i.ignored && i.level !== "info",
  );
}

/** Save what you flagged and wrote (not yet asked). Unknown or unflaggable ids are refused. */
export function saveDraft(
  projectDir: string,
  render: number,
  draft: { flags: Flag[]; guidance: string },
  now = new Date(),
): FixSet {
  const ok = new Set(flaggable(projectDir, render).map((i) => i.id));
  for (const f of draft.flags) {
    if (!ok.has(f.id))
      throw new Error(
        `${f.id} cannot be flagged: it is not in the report, is ignored, is info or is a broken file`,
      );
    if (f.choice !== "fix" && f.choice !== "leave") throw new Error('choice is "fix" or "leave"');
  }
  const set = openFixSet(projectDir, render, now);
  set.draft = { flags: draft.flags, guidance: draft.guidance.slice(0, 4000) };
  save(projectDir, set);
  return set;
}

/** The latest round that is waiting for the Director. */
export const askedRound = (set: FixSet): Round | undefined =>
  [...set.rounds].reverse().find((r) => r.status === "asked");

/**
 * Ask the Director (round n+1): the draft becomes a round. At least one finding must be flagged "fix". A round still waiting for the
 * Director is not asked again.
 */
export function askRound(
  projectDir: string,
  render: number,
  draft: { flags: Flag[]; guidance: string },
  now = new Date(),
): { set: FixSet; round: Round } {
  const set = saveDraft(projectDir, render, draft, now);
  if (askedRound(set)) throw new Error("the Director has not answered the last ask yet");
  const fix = draft.flags.filter((f) => f.choice === "fix");
  if (!fix.length) throw new Error("flag at least one finding as Fix first");
  const round: Round = {
    n: set.rounds.length + 1,
    askedAt: now.toISOString(),
    flags: draft.flags,
    guidance: draft.guidance.trim().slice(0, 4000),
    status: "asked",
  };
  set.rounds.push(round);
  save(projectDir, set);
  return { set, round };
}

const stageIndex = (s: FixStage) => FIX_STAGES.indexOf(s);

export interface ProposalInput {
  stage: string;
  title: string;
  change: string;
  why: string;
  findings: string[];
  cost?: string;
}

/**
 * The Director's answer to the asked round. Refuses what would not reach the goal (one run at the earliest stage, as many
 * problems as possible): two proposals for one stage, a proposal that answers nothing flagged, a flagged finding that nobody answers.
 */
export function recordProposals(
  projectDir: string,
  id: string,
  answer: {
    summary: string;
    proposals: ProposalInput[];
    unresolved?: { finding: string; why: string }[];
  },
  now = new Date(),
): { set: FixSet; round: Round } {
  const set = readFixSet(projectDir, id);
  if (!set) throw new Error(`there is no fix set ${id}`);
  const round = askedRound(set);
  if (!round) throw new Error(`fix set ${id} has no open ask: the user has not asked for fixes`);
  const flagged = new Set(round.flags.filter((f) => f.choice === "fix").map((f) => f.id));
  const seen = new Map<string, number>();
  const problems: string[] = [];
  answer.proposals.forEach((p, i) => {
    const where = `proposal ${i + 1}`;
    if (!FIX_STAGES.includes(p.stage as FixStage))
      problems.push(`${where}: stage "${p.stage}" is not one of ${FIX_STAGES.join(", ")}`);
    if (p.title.trim().length < 3) problems.push(`${where}: a title is needed`);
    if (p.change.trim().length < 10) problems.push(`${where}: say concretely what would change`);
    if (p.why.trim().length < 3) problems.push(`${where}: say why it fixes the findings`);
    if (!p.findings?.length) problems.push(`${where}: name the findings it answers`);
    for (const f of p.findings ?? [])
      if (!flagged.has(f)) problems.push(`${where}: ${f} is not a finding the user flagged as Fix`);
    const prev = seen.get(p.stage);
    if (prev !== undefined)
      problems.push(
        `proposals ${prev + 1} and ${i + 1} are both for ${p.stage}: merge them into ONE proposal per stage (one run fixes as much as possible)`,
      );
    else seen.set(p.stage, i);
  });
  const unresolved = answer.unresolved ?? [];
  const answered = new Set([
    ...answer.proposals.flatMap((p) => p.findings ?? []),
    ...unresolved.map((u) => u.finding),
  ]);
  const missing = [...flagged].filter((f) => !answered.has(f));
  if (missing.length)
    problems.push(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} flagged but neither answered by a proposal nor named under unresolved with a reason`,
    );
  if (!answer.proposals.length && !unresolved.length)
    problems.push("no proposal and nothing unresolved");
  if (problems.length) throw new Error(`not stored:\n- ${problems.join("\n- ")}`);

  // what you decided on the same stage in an earlier round carries over as your decision (you can change it)
  const before = set.rounds.filter((r) => r.n < round.n && r.proposals).at(-1);
  const proposals: Proposal[] = [...answer.proposals]
    .sort((a, b) => stageIndex(a.stage as FixStage) - stageIndex(b.stage as FixStage))
    .map((p, i) => {
      const prev = before?.proposals?.find((x) => x.stage === p.stage);
      return {
        id: `p${i + 1}`,
        stage: p.stage as FixStage,
        title: p.title.trim(),
        change: p.change.trim(),
        why: p.why.trim(),
        findings: p.findings,
        ...(p.cost?.trim() ? { cost: p.cost.trim() } : {}),
        decision: "undecided",
        ...(prev?.note ? { note: prev.note } : {}),
      };
    });
  round.status = "proposed";
  round.proposedAt = now.toISOString();
  round.summary = answer.summary.trim().slice(0, 2000);
  round.proposals = proposals;
  round.unresolved = unresolved;
  round.earliest = proposals[0]?.stage;
  save(projectDir, set);
  return { set, round };
}

/** The Director could not answer (a failed run): the round says so and can be asked again. */
export function failRound(projectDir: string, id: string, why: string): void {
  const set = readFixSet(projectDir, id);
  const round = set && askedRound(set);
  if (!set || !round) return;
  round.status = "failed";
  round.summary = why.slice(0, 500);
  save(projectDir, set);
}

/** Your decision on one proposal of the latest answered round: accept, reject, undecided, with your edit and note. */
export function decideProposal(
  projectDir: string,
  id: string,
  proposal: string,
  d: { decision?: Proposal["decision"]; edited?: string; note?: string },
): { set: FixSet; proposal: Proposal } {
  const set = readFixSet(projectDir, id);
  if (!set) throw new Error(`there is no fix set ${id}`);
  const round = [...set.rounds].reverse().find((r) => r.status === "proposed");
  const p = round?.proposals?.find((x) => x.id === proposal);
  if (!round || !p) throw new Error(`there is no proposal ${proposal} to decide in ${id}`);
  if (d.decision !== undefined) {
    if (!["undecided", "accepted", "rejected"].includes(d.decision))
      throw new Error('decision is "accepted", "rejected" or "undecided"');
    p.decision = d.decision;
  }
  if (d.edited !== undefined) {
    if (d.edited.trim()) p.edited = d.edited.trim().slice(0, 4000);
    else Reflect.deleteProperty(p, "edited");
  }
  if (d.note !== undefined) {
    if (d.note.trim()) p.note = d.note.trim().slice(0, 1000);
    else Reflect.deleteProperty(p, "note");
  }
  save(projectDir, set);
  return { set, proposal: p };
}

/** The earliest stage among the accepted proposals: where the one run goes (the next step applies it). */
export function acceptedEarliest(round: Round | undefined): FixStage | undefined {
  return round?.proposals?.find((p) => p.decision === "accepted")?.stage;
}

/**
 * What the Director reads: the flagged findings in full, your context, the rounds so far with your decisions and notes, what is
 * already decided (ignores), and the rules of a good answer.
 */
export function directorBrief(projectDir: string, id: string): string {
  const set = readFixSet(projectDir, id);
  if (!set) throw new Error(`there is no fix set ${id}`);
  const round = askedRound(set) ?? set.rounds.at(-1);
  if (!round) throw new Error(`fix set ${id} has no round: the user has not asked yet`);
  const report = readQa(projectDir, set.render);
  const byId = new Map((report?.items ?? []).map((i) => [i.id, i]));
  const line = (i: QaItem | undefined, id: string) =>
    i
      ? `- ${i.id} [${i.level === "blocking" ? "HARD STOP" : i.high ? "needs the user's eyes" : i.level}] ${i.check}${i.scene ? ` in ${i.scene}` : ""}${i.atMs !== undefined ? ` at ${Math.round(i.atMs / 100) / 10} s` : ""}: ${i.message}${i.fix ? ` (the check's own suggestion: ${i.fix.label})` : ""}`
      : `- ${id} (no longer in the report)`;
  const flaggedFix = round.flags.filter((f) => f.choice === "fix").map((f) => f.id);
  const left = round.flags.filter((f) => f.choice === "leave").map((f) => f.id);
  const lines = [
    `# Fix set ${set.id}, round ${round.n} (QA of render v${set.render})`,
    "",
    `## The findings the user wants fixed (${flaggedFix.length})`,
    ...flaggedFix.map((x) => line(byId.get(x), x)),
    ...(left.length
      ? [
          "",
          `## Flagged to leave as they are (do not propose anything for these): ${left.join(", ")}`,
        ]
      : []),
    "",
    "## The user's context for this round",
    round.guidance || "(none)",
  ];
  const earlier = set.rounds.filter((r) => r.n < round.n && r.proposals?.length);
  if (earlier.length) {
    lines.push(
      "",
      "## Earlier rounds (the user asked you to rethink: use their decisions and notes)",
    );
    for (const r of earlier) {
      lines.push(`### Round ${r.n}${r.guidance ? `, the user said: ${r.guidance}` : ""}`);
      for (const p of r.proposals ?? [])
        lines.push(
          `- ${p.id} [${FIX_STAGE_WORD[p.stage]}] ${p.title}: ${p.decision.toUpperCase()}${p.note ? `, the user's note: "${p.note}"` : ""}${p.edited ? `, the user rewrote the change as: "${p.edited}"` : ""}`,
        );
    }
  }
  const ig = activeIgnores(projectDir);
  if (ig.length)
    lines.push(
      "",
      "## Already decided (the user left these alone: do not raise them)",
      ...ig.map(
        (i) =>
          `- ${i.id} [${i.scope}${i.scene ? `, ${i.scene}` : ""}] ${i.check}${i.kind ? `/${i.kind}` : ""}: ${i.reason}`,
      ),
    );
  lines.push(
    "",
    "## How to answer (demo_rec_qa propose)",
    "- The goal is ONE run at the EARLIEST stage that needs a fix, fixing as many of the problems as possible. Group the findings by the stage where their cause is, not where they show.",
    `- At most ONE proposal per stage (${FIX_STAGES.join(", ")}); the tool refuses two for the same stage. Put every change for that stage in that one proposal.`,
    "- A proposal says concretely what would change (the sentences, the marks, the steps), why that fixes the findings it names, and what applying it would cost.",
    "- Every finding to fix is answered by a proposal or named under `unresolved` with an honest reason.",
    "- Nothing is applied by you: the user reads your proposals, decides, may give you more context and ask you to rethink. Stop after propose.",
  );
  return lines.join("\n");
}

/** A short summary of a fix set for the project context. */
export function formatFixSets(projectDir: string): string[] {
  const open = listFixSets(projectDir).filter((s) => s.status === "open" && s.rounds.length);
  return open.map((s) => {
    const r = s.rounds.at(-1) as Round;
    return `- ${s.id} (QA of render v${s.render}): round ${r.n} ${r.status}${r.proposals ? `, ${r.proposals.length} proposal(s), earliest stage ${r.earliest ? FIX_STAGE_WORD[r.earliest] : "none"}, ${r.proposals.filter((p) => p.decision === "accepted").length} accepted` : ""}`;
  });
}
