export const STALL_MS: number;
export const SETTLED_GRACE_MS: number;
export function stallOf(
  events: { type: string; at: string }[],
  now?: number,
): { kind: "quiet" | "director-stopped"; sinceMs: number } | null;
export function stallWords(s: { kind: "quiet" | "director-stopped"; sinceMs: number }): string;
export const AREA_WORDS: Record<string, [string, string, string]>;
export function areaSegment(
  a: { name: string; status: string; looks?: number; acts?: number },
  weight: number,
): {
  key: string;
  weight: number;
  title: string;
  label: string;
  done: number;
  state: string;
  restarted?: boolean;
};
export const KIND_ICON: Record<string, string>;
export function citedBy(
  report:
    | {
        found: { text: string; evidence: string[] }[];
        research: { text: string; evidence: string[] }[];
        guidance: Record<string, { title: string; evidence: string[] }[]>;
      }
    | null
    | undefined,
  id: string,
): { part: string; text: string }[];
export function findingsAtScreen<T extends { evidence: { type: string; id?: string }[] }>(
  findings: T[],
  id: string,
): T[];
