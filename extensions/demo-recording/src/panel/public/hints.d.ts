export const HINT_STEP_MS: number;
export const HINT_MAX_MS: number;
export function hintIn(text: string, mark: string): number | null;
export function withHint(text: string, mark: string, ms: number): string;
export function hintWords(ms: number): string;
