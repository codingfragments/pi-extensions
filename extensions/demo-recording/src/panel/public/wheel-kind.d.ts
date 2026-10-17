export const WHEEL_MODES: readonly ["auto", "zoom", "scroll"];
export const BURST_MS: number;
export interface WheelLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}
export interface WheelState {
  at: number;
  kind: "zoom" | "pan" | null;
}
export function classifyWheel(
  e: WheelLike,
  st: WheelState,
  mode: "auto" | "zoom" | "scroll",
  now: number,
): "pinch" | "zoom" | "pan";
