export function sizeWords(bytes: number): string;
export function sinceWords(iso: string, now?: number): string;
export function deleteText(row: { slug: string; bytes: number; active: boolean }): string;
export function canTryWithoutDrafts(message: string): boolean;
