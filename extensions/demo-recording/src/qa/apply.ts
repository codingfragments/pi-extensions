/**
 * Apply the accepted proposals of a fix set (P1c Q4, D-QA-2, D-QA-8, D-QA-9, D-QA-10).
 *
 * "Apply" never renders and never synthesizes: it makes ONE new draft at the EARLIEST stage that has an accepted proposal, by asking the
 * Director (a visible turn) to write it; you read, verify and approve that draft as always, and synthesis only comes after that, behind
 * your Allow. The accepted proposals for LATER stages become PENDING FIXES in the project memory (the stage's writer reads them when its
 * turn comes). A recording or discovery fix is never done inside this flow: it is kept as a pending fix and starts, with its normal
 * asks, when you start that step.
 */

import path from "node:path";
import type { Runtime } from "../runtime.ts";
import { readState, updateState } from "../workdir/state.ts";
import { writeFileAtomic } from "../workdir/versioning.ts";
import {
  FIX_STAGES,
  FIX_STAGE_WORD,
  type FixSet,
  type FixStage,
  type Proposal,
  type Round,
  listFixSets,
  readFixSet,
} from "./fixes.ts";
import { readQa } from "./run.ts";
import type { PendingFix } from "./types.ts";

/** The stages the Director can write a draft for. A recording or a discovery is something you start. */
export const DRAFT_STAGES: readonly FixStage[] = ["storyboard", "vo", "annotations"];

export const listPending = (projectDir: string): PendingFix[] =>
  readState(projectDir)?.pendingFixes ?? [];
export const openPending = (projectDir: string, stage?: FixStage): PendingFix[] =>
  listPending(projectDir).filter(
    (p) => p.status === "open" && (stage === undefined || p.stage === stage),
  );

/** The text of a proposal as you want it done: your wording when you edited it. */
export const proposalText = (p: Proposal): string => `${p.title}: ${p.edited ?? p.change}`;

export interface ApplyPlan {
  set: FixSet;
  round: Round;
  /** The stage that gets the one new draft (undefined: the earliest accepted stage is one you start yourself). */
  stage: FixStage;
  /** The accepted proposals of that stage: what the Director carries out. */
  now: Proposal[];
  /** The accepted proposals of later stages, now pending fixes. */
  pending: PendingFix[];
  /** True when the Director writes a draft; false for a recording or a discovery (kept as pending, you start it). */
  writes: boolean;
}

function nextPendingId(all: PendingFix[]): string {
  const n = all.reduce((m, i) => Math.max(m, Number(/^pf-(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  return `pf-${n + 1}`;
}

/**
 * Plan and record the apply: the earliest accepted stage, the accepted proposals there, the pending fixes for the rest. Marks the fix set
 * `applying` (so the draft the Director writes can be linked to it). Refuses what cannot be applied.
 */
export function applyFixSet(projectDir: string, id: string, now = new Date()): ApplyPlan {
  const set = readFixSet(projectDir, id);
  if (!set) throw new Error(`there is no fix set ${id}`);
  if (set.status !== "open") throw new Error(`${id} is already ${set.status}`);
  if (set.applying && !set.applying.version)
    throw new Error("the Director is already writing this draft");
  const round = [...set.rounds].reverse().find((r) => r.status === "proposed");
  if (!round?.proposals) throw new Error(`${id} has no answered round to apply`);
  const accepted = round.proposals.filter((p) => p.decision === "accepted");
  if (!accepted.length) throw new Error("accept at least one proposal first");
  const earliest = accepted[0] as Proposal;
  const stage = earliest.stage;
  const writes = DRAFT_STAGES.includes(stage);
  const nowProposals = accepted.filter((p) => p.stage === stage);
  const later = accepted.filter((p) => FIX_STAGES.indexOf(p.stage) > FIX_STAGES.indexOf(stage));
  const report = readQa(projectDir, set.render);
  const byId = new Map((report?.items ?? []).map((i) => [i.id, i]));
  const pendingFor = (p: Proposal, base: PendingFix[]): PendingFix => ({
    id: nextPendingId(base),
    stage: p.stage,
    text: proposalText(p),
    ...(p.note ? { guidance: p.note } : {}),
    fixset: set.id,
    render: set.render,
    findings: p.findings.map((f) => {
      const it = byId.get(f);
      return {
        id: f,
        message: it?.message ?? f,
        check: it?.check ?? "values",
        ...(it?.scene ? { scene: it.scene } : {}),
        ...(it?.identity ? { identity: it.identity } : {}),
      };
    }),
    status: "open",
    createdAt: now.toISOString(),
  });
  const created: PendingFix[] = [];
  updateState(
    projectDir,
    "qa-fixes-applying",
    (s) => {
      const all = [...(s.pendingFixes ?? [])];
      // a recording or discovery fix is kept for when you start that step; so are the later stages' accepted proposals
      const keep = writes ? later : accepted;
      for (const p of keep) {
        const pf = pendingFor(p, all);
        all.push(pf);
        created.push(pf);
      }
      s.pendingFixes = all;
    },
    { fixset: set.id, round: round.n, stage, writes },
    now,
  );
  set.applying = {
    stage,
    round: round.n,
    proposals: nowProposals.map((p) => p.id),
    at: now.toISOString(),
    ...(writes ? {} : { kept: true }),
  };
  if (!writes) set.status = "applied";
  writeFileAtomic(
    path.join(projectDir, "fixes", `${set.id}.json`),
    `${JSON.stringify(set, null, 2)}\n`,
  );
  return { set, round, stage, now: nowProposals, pending: created, writes };
}

/**
 * The Director wrote a draft of `stage`: if a fix set was waiting for one, link them (the draft is "fixes from render vN") and close the
 * set. Returns the fix set it linked, if any.
 */
export function linkFixDraft(
  projectDir: string,
  stage: string,
  version: number,
  now = new Date(),
): FixSet | undefined {
  const set = listFixSets(projectDir).find(
    (s) => s.status === "open" && s.applying && !s.applying.version && s.applying.stage === stage,
  );
  if (!set?.applying) return undefined;
  set.applying.version = version;
  set.status = "applied";
  set.appliedAt = now.toISOString();
  writeFileAtomic(
    path.join(projectDir, "fixes", `${set.id}.json`),
    `${JSON.stringify(set, null, 2)}\n`,
  );
  return set;
}

/** Which fix set a draft came from: `{ fixset, render }`, so the panel can say "fixes from render v8". */
export function fixLinkFor(
  projectDir: string,
  stage: string,
  version: number,
): { fixset: string; render: number } | undefined {
  const set = listFixSets(projectDir).find(
    (s) => s.applying?.stage === stage && s.applying.version === version,
  );
  return set ? { fixset: set.id, render: set.render } : undefined;
}

/** What the Director is told: carry out exactly this, as one draft, and stop. */
export function applyMessage(plan: ApplyPlan, panelPrefix: string): string {
  const word = FIX_STAGE_WORD[plan.stage];
  const tool: Record<string, string> = {
    vo: "demo_rec_vo (get the current script, then write a new version with base set to it)",
    storyboard: "demo_rec_storyboard (get the current storyboard, then write a new version)",
    annotations: "demo_rec_annotations (context, then suggest or write a new version)",
  };
  return (
    `${panelPrefix} The user ACCEPTED ${plan.now.length} fix proposal${plan.now.length === 1 ? "" : "s"} for the ${word} (fix set ${plan.set.id}, round ${plan.round.n}, from the QA of render v${plan.set.render}) ` +
    `and asks you to APPLY them: write ONE new ${word} draft that carries out exactly what they accepted. Call demo_rec_qa context first: it lists the accepted proposals, with the user's own wording and notes where they edited. ` +
    `Use ${tool[plan.stage] ?? "the stage's tool"}. Change only what the proposals say. Do NOT render and do NOT synthesize anything: the user reads the draft, verifies it and approves it, and only then does the voice cost anything. ` +
    `${plan.pending.length ? "The accepted proposals for later stages are kept as pending fixes: leave them. " : ""}Stop after writing the draft.`
  );
}

/** The pending fixes as text for the Director and the project context. Open ones first; resolved ones briefly. */
export function formatPending(projectDir: string): string[] {
  const all = listPending(projectDir);
  if (!all.length) return [];
  const line = (p: PendingFix) =>
    `- ${p.id} [${FIX_STAGE_WORD[p.stage]}] ${p.text}${p.guidance ? ` (the user's note: ${p.guidance})` : ""} — answers ${p.findings.map((f) => f.id).join(", ")} of render v${p.render}${p.status === "open" ? "" : ` — ${p.status.toUpperCase()}${p.resolvedWhy ? `: ${p.resolvedWhy}` : ""}`}`;
  const open = all.filter((p) => p.status === "open");
  const done = all.filter((p) => p.status !== "open").slice(-3);
  return [
    ...(open.length
      ? ["Open (the stage's writer takes these into account):", ...open.map(line)]
      : []),
    ...(done.length ? ["Resolved:", ...done.map(line)] : []),
  ];
}
