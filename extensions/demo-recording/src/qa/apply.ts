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
import { annotationVersions } from "../annotations/file.ts";
import type { Runtime } from "../runtime.ts";
import { storyboardVersions } from "../storyboard/store.ts";
import { voVersions } from "../vo/store.ts";
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
  /** The steps from this fix to a new render (see pathToRender). */
  path: string[];
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
  const steps = pathToRender(
    stage,
    later.map((p) => p.stage),
  );
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
    path: steps,
    ...(writes ? {} : { kept: true }),
  };
  if (!writes) set.status = "applied";
  writeFileAtomic(
    path.join(projectDir, "fixes", `${set.id}.json`),
    `${JSON.stringify(set, null, 2)}\n`,
  );
  return { set, round, stage, now: nowProposals, pending: created, writes, path: steps };
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

/**
 * The steps after a fix at `stage` until a new render exists, in the order they happen: what you do, what asks for your Allow, what the
 * engine does by itself. `later` are the stages that have pending fixes (the Director takes them into account when it writes them).
 */
export function pathToRender(stage: FixStage, later: FixStage[] = []): string[] {
  const has = (s: FixStage) => later.includes(s);
  const steps: string[] = [];
  switch (stage) {
    case "discovery":
    case "storyboard":
      steps.push(
        stage === "discovery"
          ? "Run the discovery again (Project: it asks for a budget) and read what it finds"
          : "Read the new storyboard draft and approve it (Storyboard tab)",
        "Record a new take: you start it, and it asks for your Allow (model calls and recording time)",
        "Approve the take (Recording tab); the voice-over is written from it, then read and approve it",
        "Generate voice, edit and a draft to watch: it asks for your Allow and shows what is billed",
      );
      break;
    case "recording":
      steps.push(
        "Start the new take yourself (Recording tab, Request a new take): it asks for your Allow",
        "Approve the take; the voice-over is written from it, then read and approve it",
        "Generate voice, edit and a draft to watch: it asks for your Allow and shows what is billed",
      );
      break;
    case "vo":
      steps.push(
        "Read the new voice-over draft and approve it (Voice tab)",
        "Generate voice, edit and a draft to watch: only changed sections are synthesised (the rest comes from the cache); it asks for your Allow and shows the cost",
      );
      break;
    case "annotations":
      steps.push("Read the new annotations draft and approve it (Annotations tab)");
      break;
    case "render":
      break;
  }
  if (stage !== "annotations" && stage !== "render") {
    steps.push(
      has("annotations")
        ? "The annotations are re-suggested for the new timing, taking your pending annotation fixes into account; review and approve them"
        : "The annotations are re-suggested for the new timing (automatic unless you turned it off); review and approve them",
    );
  } else if (stage === "annotations" && later.includes("render")) {
    steps.push("A render is the next step anyway");
  }
  steps.push(
    "Render a final (Render, New render…) and read its QA: no synthesis or recording happens in a render",
  );
  return steps;
}

/** What the Director is told: carry out exactly this, as one draft, and stop. */
export function applyMessage(plan: ApplyPlan, panelPrefix: string): string {
  const word = FIX_STAGE_WORD[plan.stage];
  const tool: Record<string, string> = {
    vo: "demo_rec_vo (get the current script, then write a new version with base set to it)",
    storyboard: "demo_rec_storyboard (get the current storyboard, then write a new version)",
    annotations: "demo_rec_annotations (context, then suggest or write a new version)",
  };
  return `${panelPrefix} The user ACCEPTED ${plan.now.length} fix proposal${plan.now.length === 1 ? "" : "s"} for the ${word} (fix set ${plan.set.id}, round ${plan.round.n}, from the QA of render v${plan.set.render}) and asks you to APPLY them: write ONE new ${word} draft that carries out exactly what they accepted. Call demo_rec_qa context first: it lists the accepted proposals, with the user's own wording and notes where they edited. Use ${tool[plan.stage] ?? "the stage's tool"}. Change only what the proposals say. Do NOT render and do NOT synthesize anything: the user reads the draft, verifies it and approves it, and only then does the voice cost anything. ${plan.pending.length ? "The accepted proposals for later stages are kept as pending fixes: leave them. " : ""}Stop after writing the draft.\n\nYour reply to the user is STRUCTURED, at most 12 lines, in exactly this shape (no paragraph):\n**Stage:** ${word.charAt(0).toUpperCase()}${word.slice(1)}: new draft vN (fixes from render v${plan.set.render})\n**Changed:** one bullet per edit you made (old → new)\n**Next steps to a new render:**\n${plan.path.map((s, i) => `${i + 1}. ${s}`).join("\n")}\nSay that nothing was rendered or synthesised.`;
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

// --- Q5: the stage writers read the pending fixes and settle them --------------------------------------------------

const versionsOf = (projectDir: string, stage: FixStage): number[] | undefined =>
  stage === "vo"
    ? voVersions(projectDir)
    : stage === "storyboard"
      ? storyboardVersions(projectDir)
      : stage === "annotations"
        ? annotationVersions(projectDir)
        : undefined; // a recording or a discovery has no draft the Director writes

/**
 * Settle a pending fix: `applied` (the draft that carries it, and how) or `dropped` (and why). The Director settles the ones of the stage it
 * has just written; you can drop any of them. Nothing else changes: a pending fix is memory, and what happened to it stays readable.
 */
export function resolvePending(
  projectDir: string,
  id: string,
  o: { status: "applied" | "dropped"; why?: string; by: "agent" | "user"; version?: number },
  now = new Date(),
): PendingFix {
  const all = listPending(projectDir);
  const pf = all.find((x) => x.id === id);
  if (!pf)
    throw new Error(
      `there is no pending fix ${id}${
        all.some((x) => x.status === "open")
          ? ` (open: ${all
              .filter((x) => x.status === "open")
              .map((x) => x.id)
              .join(", ")})`
          : " (none are open)"
      }`,
    );
  if (pf.status !== "open")
    throw new Error(`${id} is already ${pf.status}${pf.resolvedWhy ? `: ${pf.resolvedWhy}` : ""}`);
  const why = (o.why ?? "").trim();
  if (o.by === "agent" && why.length < 4)
    throw new Error(
      `say in a sentence how ${id} was ${o.status === "applied" ? "applied" : "left out"} (why)`,
    );
  if (o.status === "applied") {
    const known = versionsOf(projectDir, pf.stage);
    if (known) {
      if (o.version === undefined || !known.includes(o.version))
        throw new Error(
          `applied needs the ${FIX_STAGE_WORD[pf.stage]} version that carries it (version: ${known.join(", ") || "none written yet"})`,
        );
    }
  }
  let out = pf;
  updateState(
    projectDir,
    "qa-pending-resolved",
    (s) => {
      const target = (s.pendingFixes ?? []).find((x) => x.id === id);
      if (!target) return;
      target.status = o.status;
      target.resolvedBy = o.by;
      target.resolvedAt = now.toISOString();
      target.resolvedWhy = why || (o.by === "user" ? "dropped by you" : "");
      if (o.status === "applied" && o.version !== undefined) target.version = o.version;
      out = target;
    },
    { id, status: o.status, by: o.by, stage: pf.stage },
    now,
  );
  return out;
}

/**
 * What a stage's writer reads about the user's accepted QA fixes for that stage: in the voice-over template, the annotations context and
 * the storyboard read. Empty when nothing is open.
 */
export function pendingBlock(projectDir: string, stage: FixStage): string[] {
  const open = openPending(projectDir, stage);
  if (!open.length) return [];
  return [
    `## Pending fixes for the ${FIX_STAGE_WORD[stage]} (${open.length}): the user accepted these from a QA`,
    ...open.map(
      (p) =>
        `- ${p.id} (render v${p.render}, answers ${p.findings.map((f) => `${f.id}: ${f.message}`).join("; ")}): ${p.text}${p.guidance ? ` — the user's note: ${p.guidance}` : ""}`,
    ),
    "Take each into account in this draft. Then settle each one: demo_rec_qa resolve with the id, status applied (and the version that carries it) or dropped (and why it does not apply any more). Say in your reply which you applied and which you dropped.",
    "",
  ];
}

/** The reminder appended to a stage tool's write result: which pending fixes of that stage are still open. */
export function pendingReminder(projectDir: string, stage: FixStage, version: number): string {
  const open = openPending(projectDir, stage);
  if (!open.length) return "";
  return `\n${open.length} pending fix${open.length === 1 ? "" : "es"} for the ${FIX_STAGE_WORD[stage]} still open (${open.map((p) => p.id).join(", ")}): for each, call demo_rec_qa resolve with status applied (version ${version} if this draft carries it) or dropped (with why), then say which in your reply.`;
}
