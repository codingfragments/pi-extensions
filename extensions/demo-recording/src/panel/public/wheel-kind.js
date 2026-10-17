// What a wheel event is, in the project map (no browser code: a test reads it).
//
//   pinch  zoom: Ctrl + wheel (what a trackpad pinch sends) and, in "zoom" mode, a plain mouse wheel
//   zoom   a mouse wheel notch, zooming at the pointer
//   pan    a two-finger scroll on a trackpad, or Shift + wheel: left to the browser, which scrolls with inertia
//
// A trackpad and a mouse wheel both send "wheel" events, so in "auto" mode they are told apart by what they look like:
// sideways movement, fractional deltas and a burst of events are a trackpad; a line- or page-mode delta and a delta of a
// full notch (100, 120) are a wheel. The first event of a gesture decides, and the rest of the burst keeps that decision.
// "zoom" and "scroll" mode are the user's override when the guess is wrong on their device.

export const WHEEL_MODES = ["auto", "zoom", "scroll"];
/** Events closer together than this belong to one gesture. */
export const BURST_MS = 60;

/**
 * @param {{ ctrlKey: boolean, shiftKey: boolean, deltaX: number, deltaY: number, deltaMode: number }} e
 * @param {{ at: number, kind: "zoom" | "pan" | null }} st remembered between events: updated here
 * @param {"auto" | "zoom" | "scroll"} mode
 * @param {number} now milliseconds
 * @returns {"pinch" | "zoom" | "pan"}
 */
export function classifyWheel(e, st, mode, now) {
  if (e.ctrlKey) return "pinch";
  if (e.shiftKey) return "pan";
  if (mode === "scroll") return "pan";
  if (mode === "zoom") return "zoom";
  const inBurst = st.kind !== null && now - st.at < BURST_MS;
  st.at = now;
  if (inBurst) return /** @type {"zoom" | "pan"} */ (st.kind);
  let kind;
  if (e.deltaMode !== 0) kind = "zoom";
  else if (Math.abs(e.deltaX) >= 1) kind = "pan";
  else if (!Number.isInteger(e.deltaY)) kind = "pan";
  else if (Math.abs(e.deltaY) >= 100) kind = "zoom";
  else kind = "pan";
  st.kind = kind;
  return kind;
}
