export interface SettingLike {
  key: string;
  label: string;
  doc: string;
  type: string;
  value: unknown;
  source: "default" | "global" | "project" | "env" | "unset";
  layers: { default: unknown; global: unknown; project: unknown };
  envVar?: string;
  envSet?: boolean;
  globalOnly?: boolean;
}
export interface SettingGroup<T extends SettingLike = SettingLike> {
  id: string;
  label: string;
  settings: T[];
}
export interface SearchResult<T extends SettingLike = SettingLike> {
  groups: SettingGroup<T>[];
  count: number;
  total: number;
  searching: boolean;
  words: string[];
}
export const SECRET_KEY: RegExp;
export const FILTERS: [id: string, label: string, title: string][];
export function isSecret(s: Pick<SettingLike, "key">): boolean;
export function same(a: unknown, b: unknown): boolean;
export function showValue(s: Pick<SettingLike, "key">, v: unknown): string;
export function isChanged(s: SettingLike): boolean;
export function isOverridden(s: SettingLike, project: string | null | undefined): boolean;
export function isFromEnv(s: SettingLike): boolean;
export function wordsOf(q: string | undefined): string[];
export function haystack(s: SettingLike, project?: string | null): string;
export function filterGroups<T extends SettingLike>(
  groups: SettingGroup<T>[],
  opts?: { q?: string; filters?: Set<string>; project?: string | null },
): SearchResult<T>;
export function highlight(text: unknown, ws: string[]): { t: string; hit: boolean }[];
export function searchFromQuery(query?: Record<string, string>): {
  q: string;
  filters: Set<string>;
  view: "settings" | "brands";
};
export function queryFromSearch(s?: {
  q?: string;
  filters?: Set<string>;
  view?: "settings" | "brands";
}): Record<string, string>;
