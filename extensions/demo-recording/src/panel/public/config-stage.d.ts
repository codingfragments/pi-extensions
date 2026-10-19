export * from "./config-stage-core.js";
export interface StagedItem {
  id: string;
  key: string;
  scope: "global" | "project";
  project?: string;
  value?: unknown;
  unset?: boolean;
}
export function stagedList(): StagedItem[];
export function stage(item: Omit<StagedItem, "id">): void;
export function unstage(id: string): void;
export function clearStaged(): void;
export function useStaged(): StagedItem[];
export function guardLeaving(ask: (count: number) => Promise<boolean>): () => void;
