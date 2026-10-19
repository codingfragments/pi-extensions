export interface StagedItem {
  id: string;
  key: string;
  scope: "global" | "project";
  project?: string;
  value?: unknown;
  unset?: boolean;
}
export const stageId: (scope: string, key: string) => string;
export function withChange(list: StagedItem[], item: Omit<StagedItem, "id">): StagedItem[];
export function without(list: StagedItem[], id: string): StagedItem[];
export function toBatch(
  list: StagedItem[],
): { key: string; scope: string; value?: unknown; unset?: true }[];
export function countWord(n: number): string;
