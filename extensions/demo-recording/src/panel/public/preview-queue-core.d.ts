export class AbortedError extends Error {}
export interface PreviewQueue {
  enqueue<T>(
    run: (signal: AbortSignal) => Promise<T>,
    o: { signal: AbortSignal; visible?: () => boolean; first?: boolean },
  ): Promise<T>;
  pending(): number;
  subscribe(fn: (pending: number) => void): () => void;
}
export function createPreviewQueue(): PreviewQueue;
