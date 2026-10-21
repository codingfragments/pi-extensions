export const STEP_MS: number;
export const FINE_STEP_MS: number;
export type KeyAction =
  | { kind: "chapter" | "finding"; d: -1 | 1 }
  | { kind: "seekBy"; ms: number }
  | { kind: "note" };
export function keyAction(key: string, shift?: boolean): KeyAction | null;
export interface FindingStop {
  id: string;
  ms: number;
  scene: string;
  kind: "found" | "planned";
  text: string;
  timed: boolean;
}
export function findingStops(
  scenes: {
    id: string;
    startMs: number;
    found?: { id: string; text: string; t?: number }[];
    planned?: { id: string; text: string; t?: number }[];
  }[],
): FindingStop[];
export function stopFrom(stops: FindingStop[], ms: number, d: number): FindingStop | undefined;
export function clampSeek(ms: number, deltaMs: number, durationMs: number): number;
