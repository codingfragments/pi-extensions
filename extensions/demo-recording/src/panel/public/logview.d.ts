/** Types for logview.js (panel module, loaded by the browser and by tests). */
export interface LogEvent {
  seq: number;
  at: string;
  type: string;
  project?: string;
  data?: Record<string, unknown>;
}
export function collapseProgress<E extends LogEvent>(
  events: E[],
): (E & { ticks?: number; firstAt?: string })[];
