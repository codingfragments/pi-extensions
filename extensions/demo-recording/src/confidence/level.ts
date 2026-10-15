/**
 * Confidence-guided review (S5 part 11, D23, D76–D81; docs/CONFIDENCE.md).
 *
 * Every review item (storyboard scene, VO section, annotation) gets a level
 * from MEASURED signals — the worst signal wins — with the reasons listed.
 * The agent's own 1–5 view (an optional field in the artifact) is shown
 * separately and can only LOWER the level: 1–2 → low, 3 → at most medium.
 */

export type Level = "high" | "medium" | "low";

export const LEVELS: readonly Level[] = ["low", "medium", "high"];
const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

export interface Reason {
  level: Level;
  text: string;
}

export interface ItemConfidence {
  /** Scene id, section key or annotation id. */
  id: string;
  level: Level;
  /** Worst first; a high item may carry positive reasons ("approved in v2"). */
  reasons: Reason[];
  /** The agent's own view (D77), when it gave one. */
  agent?: { score: number; why?: string };
  /** Unchanged since this version, where the user approved it (D79). */
  approvedIn?: number;
}

export interface ConfidenceSummary {
  items: ItemConfidence[];
  counts: Record<Level, number>;
  /** Medium + low: "N need your eyes" (D23). */
  needEyes: number;
}

export const worse = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);

/** The agent's score as a ceiling: 1–2 → low, 3 → medium, 4–5 → no limit. */
export const agentCap = (score: number): Level =>
  score <= 2 ? "low" : score === 3 ? "medium" : "high";

export function judge(
  id: string,
  reasons: Reason[],
  agent?: { score: number; why?: string },
  approvedIn?: number,
): ItemConfidence {
  const all = [...reasons];
  if (agent && agent.score <= 3)
    all.push({
      level: agentCap(agent.score),
      text: `the agent rates it ${agent.score}/5${agent.why ? `: ${agent.why}` : ""}`,
    });
  if (approvedIn !== undefined)
    all.push({ level: "high", text: `unchanged since v${approvedIn}, where you approved it` });
  const level = all.reduce<Level>((l, r) => worse(l, r.level), "high");
  all.sort((a, b) => RANK[a.level] - RANK[b.level]);
  return {
    id,
    level,
    reasons: all,
    ...(agent ? { agent } : {}),
    ...(approvedIn !== undefined ? { approvedIn } : {}),
  };
}

export function summarize(items: ItemConfidence[]): ConfidenceSummary {
  const counts: Record<Level, number> = { high: 0, medium: 0, low: 0 };
  for (const i of items) counts[i.level]++;
  return { items, counts, needEyes: counts.low + counts.medium };
}

/** "2 low, 1 medium need your eyes — 01-intro: …" for agent messages and tool results (low first). */
export function formatConfidence(s: ConfidenceSummary, what = "item"): string {
  if (!s.needEyes) return `confidence: all ${s.items.length} ${what}(s) high`;
  const lines = [...s.items]
    .filter((i) => i.level !== "high")
    .sort((a, b) => RANK[a.level] - RANK[b.level])
    .map(
      (i) =>
        `  ${i.level === "low" ? "LOW " : "med "} ${i.id}: ${i.reasons
          .filter((r) => r.level !== "high")
          .map((r) => r.text)
          .join("; ")}`,
    );
  return `confidence: ${s.counts.low} low, ${s.counts.medium} medium, ${s.counts.high} high — lowest first:\n${lines.join("\n")}`;
}
