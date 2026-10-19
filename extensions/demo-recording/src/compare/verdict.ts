/**
 * The Director's verdict on two versions (item 9b, D-R2-11, R2-3). The engine supplies the facts (`facts.ts`); the Director
 * says what they mean, through a tool that REFUSES an answer that is not honest in a checkable way:
 *  - a verdict from a fixed set (better, worse, different, no meaningful change: "nothing changed" is a legal answer);
 *  - 2 to 6 points, each citing an evidence id that exists in this pair's facts (an invented scene or number is refused);
 *  - better or worse must cite at least one measured fact;
 *  - an "against": the strongest argument against its own recommendation (the anti-flattery rule);
 *  - a recommendation that does not contradict the verdict.
 * One stored note per pair of versions; asking again replaces it. Nothing is spent: it costs model tokens only.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../workdir/versioning.ts";
import { COMPARE_STAGES, type CompareStage, type Comparison, compareVersions } from "./facts.ts";

export const VERDICTS = ["better", "worse", "different", "no meaningful change"] as const;
export type VerdictWord = (typeof VERDICTS)[number];
export const CHOICES = ["a", "b", "both", "neither"] as const;
export type Choice = (typeof CHOICES)[number];

export const LIMITS = {
  headline: 140,
  said: 260,
  against: 320,
  why: 260,
  points: [2, 6] as [number, number],
};

export interface VerdictPoint {
  /** An id from the pair's evidence list: `fact:words`, `scene:02-search`, `section:01-dash`, `order`. */
  evidence: string;
  said: string;
}

export interface Verdict {
  id: string;
  stage: CompareStage;
  a: number;
  b: number;
  /** asked: waiting for the Director; answered: stored; cancelled: you gave up on an ask. */
  status: "asked" | "answered" | "cancelled";
  askedAt: string;
  answeredAt?: string;
  verdict?: VerdictWord;
  headline?: string;
  points?: VerdictPoint[];
  /** The strongest argument against the recommendation. */
  against?: string;
  recommendation?: { choice: Choice; why: string };
}

export interface VerdictAnswer {
  verdict?: unknown;
  headline?: unknown;
  points?: unknown;
  against?: unknown;
  recommendation?: unknown;
}

const dirOf = (projectDir: string) => path.join(projectDir, "compare");
export const verdictKey = (stage: string, a: number, b: number) => `${stage}.v${a}-v${b}`;
const fileOf = (projectDir: string, stage: string, a: number, b: number) =>
  path.join(dirOf(projectDir), `${verdictKey(stage, a, b)}.json`);

function save(projectDir: string, v: Verdict): void {
  writeFileAtomic(fileOf(projectDir, v.stage, v.a, v.b), `${JSON.stringify(v, null, 2)}\n`);
}

export function readVerdict(
  projectDir: string,
  stage: string,
  a: number,
  b: number,
): Verdict | undefined {
  const file = fileOf(projectDir, stage, a, b);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Verdict;
  } catch {
    return undefined;
  }
}

/** Every stored verdict (and open ask), oldest first, for one stage or all. */
export function listVerdicts(projectDir: string, stage?: string): Verdict[] {
  const dir = dirOf(projectDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^(storyboard|vo)\.v\d+-v\d+\.json$/.test(f))
    .flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Verdict];
      } catch {
        return [];
      }
    })
    .filter((v) => !stage || v.stage === stage)
    .sort((x, y) => (x.askedAt < y.askedAt ? -1 : 1));
}

/** The ask the Director has not answered, the newest one. */
export function askedVerdict(projectDir: string): Verdict | undefined {
  return [...listVerdicts(projectDir)].reverse().find((v) => v.status === "asked");
}

/** Ask for a verdict on a pair: the facts must exist (it throws like the comparison does). A stored verdict of the pair is replaced. */
export function askVerdict(
  projectDir: string,
  stage: string,
  a: number,
  b: number,
  now = new Date(),
): Verdict {
  compareVersions(projectDir, stage, a, b); // validates the stage, the versions and that they differ
  const v: Verdict = {
    id: verdictKey(stage, a, b),
    stage: stage as CompareStage,
    a,
    b,
    status: "asked",
    askedAt: now.toISOString(),
  };
  save(projectDir, v);
  return v;
}

export function cancelVerdict(projectDir: string, stage: string, a: number, b: number): Verdict {
  const v = readVerdict(projectDir, stage, a, b);
  if (!v || v.status !== "asked") throw new Error("there is no ask waiting for the Director");
  v.status = "cancelled";
  save(projectDir, v);
  return v;
}

const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** What is wrong with an answer, in words the Director can act on. Empty when it is acceptable. */
export function verdictProblems(c: Comparison, ans: VerdictAnswer): string[] {
  const out: string[] = [];
  const verdict = text(ans.verdict) as VerdictWord;
  if (!(VERDICTS as readonly string[]).includes(verdict))
    out.push(
      `verdict must be one of: ${VERDICTS.join(", ")} ("no meaningful change" is a legal answer; "it depends" is not)`,
    );
  const headline = text(ans.headline);
  if (!headline) out.push("headline is required: the verdict in one sentence");
  else if (headline.length > LIMITS.headline)
    out.push(`headline is ${headline.length} characters; keep it to ${LIMITS.headline}`);
  const points = Array.isArray(ans.points) ? (ans.points as VerdictPoint[]) : [];
  const [min, max] = LIMITS.points;
  if (points.length < min || points.length > max)
    out.push(`give ${min} to ${max} points (you gave ${points.length})`);
  const cited = new Set<string>();
  points.forEach((p, i) => {
    const ev = text(p?.evidence);
    const said = text(p?.said);
    if (!ev || !c.evidence.includes(ev))
      out.push(
        `point ${i + 1} cites "${ev || "nothing"}", which is not in these facts. Cite one of: ${c.evidence.join(", ")}`,
      );
    else cited.add(ev);
    if (!said) out.push(`point ${i + 1} says nothing`);
    else if (said.length > LIMITS.said)
      out.push(`point ${i + 1} is ${said.length} characters; keep it to ${LIMITS.said}`);
  });
  if (points.length >= min && cited.size < min)
    out.push(
      `the points must cite at least ${min} different pieces of evidence (you cited ${cited.size})`,
    );
  if (
    (verdict === "better" || verdict === "worse") &&
    ![...cited].some((e) => e.startsWith("fact:"))
  )
    out.push(
      `a "${verdict}" verdict must cite at least one measured fact (a fact:… id), not only scenes or sections`,
    );
  const against = text(ans.against);
  if (against.length < 10)
    out.push(
      "against is required: the strongest argument against your own recommendation, honestly (a verdict that cannot name its downside is refused)",
    );
  else if (against.length > LIMITS.against)
    out.push(`against is ${against.length} characters; keep it to ${LIMITS.against}`);
  const rec = (ans.recommendation ?? {}) as { choice?: unknown; why?: unknown };
  const choice = text(rec.choice) as Choice;
  if (!(CHOICES as readonly string[]).includes(choice))
    out.push(
      `recommendation.choice must be one of: ${CHOICES.join(", ")} (a = the older version, b = the newer one)`,
    );
  const why = text(rec.why);
  if (!why) out.push("recommendation.why is required");
  else if (why.length > LIMITS.why)
    out.push(`recommendation.why is ${why.length} characters; keep it to ${LIMITS.why}`);
  // the recommendation must not contradict the verdict
  if (verdict === "better" && (choice === "a" || choice === "neither"))
    out.push(
      "you said the newer version is better but recommend not using it: change the verdict or the recommendation",
    );
  if (verdict === "worse" && (choice === "b" || choice === "both"))
    out.push(
      "you said the newer version is worse but recommend it: change the verdict or the recommendation",
    );
  return out;
}

/** Store the Director's answer for the ask that is waiting (or the pair named). Throws with every problem at once. */
export function recordVerdict(
  projectDir: string,
  ans: VerdictAnswer,
  pair?: { stage: string; a: number; b: number },
  now = new Date(),
): Verdict {
  const waiting = pair
    ? readVerdict(projectDir, pair.stage, pair.a, pair.b)
    : askedVerdict(projectDir);
  if (!waiting || waiting.status !== "asked")
    throw new Error("no comparison is waiting for you: the user has not asked for a verdict");
  const c = compareVersions(projectDir, waiting.stage, waiting.a, waiting.b);
  const problems = verdictProblems(c, ans);
  if (problems.length)
    throw new Error(`verdict not stored, fix these:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  const rec = ans.recommendation as { choice: Choice; why: string };
  const v: Verdict = {
    ...waiting,
    status: "answered",
    answeredAt: now.toISOString(),
    verdict: text(ans.verdict) as VerdictWord,
    headline: text(ans.headline),
    points: (ans.points as VerdictPoint[]).map((p) => ({
      evidence: text(p.evidence),
      said: text(p.said),
    })),
    against: text(ans.against),
    recommendation: { choice: text(rec.choice) as Choice, why: text(rec.why) },
  };
  save(projectDir, v);
  return v;
}

const STAGE_WORD: Record<CompareStage, string> = { storyboard: "storyboard", vo: "voice-over" };

/** What the Director reads: the pair, the facts, the ids it may cite, and the rules it will be held to. */
export function verdictBrief(projectDir: string, v?: Verdict): string {
  const ask = v ?? askedVerdict(projectDir);
  if (!ask) throw new Error("no comparison is waiting for you");
  const c = compareVersions(projectDir, ask.stage, ask.a, ask.b);
  const word = STAGE_WORD[ask.stage];
  const lines = [
    `# Compare ${word} v${ask.a} (a, older) with v${ask.b} (b, newer)`,
    "",
    "## Facts (counted by the engine; do not recount, do not invent)",
    ...c.facts.map(
      (f) =>
        `- fact:${f.id} · ${f.label}: ${f.a ?? "—"} → ${f.b ?? "—"}${f.delta === undefined ? "" : ` (${f.delta > 0 ? "+" : ""}${f.delta})`}`,
    ),
    "",
    "## What changed",
    ...c.changes.map(
      (x) => `- ${x.id} · ${x.kind} · ${x.label}${x.kind === "same" ? "" : ` · ${x.detail}`}`,
    ),
    "",
    "## How to answer (demo_rec_compare answer)",
    "Be honest, not kind: say plainly when the newer version is worse, when a change is not an improvement, when nothing meaningful changed.",
    `- verdict: one of ${VERDICTS.join(" | ")} (b compared with a).`,
    `- headline: the verdict in one sentence (at most ${LIMITS.headline} characters).`,
    `- points: ${LIMITS.points[0]}-${LIMITS.points[1]} items { evidence, said }, each citing an id listed above (${c.evidence.join(", ")}), at most ${LIMITS.said} characters each. Cite at least ${LIMITS.points[0]} different ids; better or worse must cite at least one fact:… id.`,
    `- against: the strongest argument AGAINST your own recommendation (at most ${LIMITS.against} characters). Required.`,
    `- recommendation: { choice: a | b | both | neither, why } (a = v${ask.a}, b = v${ask.b}); it must not contradict the verdict.`,
    "You cannot use, approve or change a version: the user reads this and decides. Stop after answer. The tool refuses an answer that breaks a rule and says why; fix it and answer again.",
  ];
  return lines.join("\n");
}

export { COMPARE_STAGES };
