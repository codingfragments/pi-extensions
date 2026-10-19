export function clock(ms: number): string;
export function frameAt(frames: { t: number }[], ms: number): number;
export function chapterAt(scenes: { startMs: number }[], ms: number): number;
export function marksSpoken(text: string): Map<string, string>;
