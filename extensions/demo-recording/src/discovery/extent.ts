/**
 * Lists that load more as you scroll. A table or feed that extends on every scroll can eat the whole step budget, bloat the page and the model's context, and take the
 * browser down with it. One extension is enough to understand such a page, so the engine measures what a scroll did and lets a page extend ONCE.
 */

import type { Page } from "playwright";

export interface Extent {
  /** Height of the content in the scroller the user would see move (px). */
  scrollH: number;
  clientH: number;
  top: number;
  /** Rows (table rows, role=row, list items of the main content). */
  rows: number;
  nodes: number;
}

/** Runs in the page: the tallest scrollable element (the page itself or an inner scroller) and what it holds. */
const MEASURE = `(() => {
  const root = document.scrollingElement || document.documentElement;
  let best = root, bestH = root.scrollHeight;
  for (const e of document.querySelectorAll("main, [role=main], div, section, ul, table, tbody")) {
    if (e === root) continue;
    const s = getComputedStyle(e);
    if (!/(auto|scroll)/.test(s.overflowY)) continue;
    if (e.scrollHeight - e.clientHeight > 50 && e.scrollHeight > bestH) { best = e; bestH = e.scrollHeight; }
  }
  const rows = document.querySelectorAll("tr, [role=row], [role=listitem], li").length;
  return { scrollH: best.scrollHeight, clientH: best.clientHeight || window.innerHeight, top: best.scrollTop, rows, nodes: document.getElementsByTagName("*").length };
})()`;

export async function measureExtent(page: Page): Promise<Extent | undefined> {
  try {
    return (await Promise.race([
      page.evaluate(MEASURE),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
    ])) as Extent | undefined;
  } catch {
    return undefined;
  }
}

/** More than this many elements in the page: no further scrolling down (a runaway list). */
export const NODE_CAP = 30_000;

export interface ExtensionState {
  /** The page grew when it was scrolled: it loads more as you go. */
  extends: boolean;
  /** How much it grew (rows, px) the one time it was allowed to. */
  grewRows: number;
  grewPx: number;
  /** The content height known after that one extension: scrolling never goes below it. */
  knownH: number;
}

/** Did this scroll make the page longer? A real list adds rows or a screenful of height; ordinary lazy images do not. */
export function grew(before: Extent, after: Extent): boolean {
  return (
    after.rows >= before.rows + 5 ||
    after.scrollH >= before.scrollH + Math.max(300, before.clientH * 0.4)
  );
}

/**
 * What a downward scroll of `dy` may do on a page that has already extended once: nothing past the content known after that extension (plus a small margin), so the
 * scroll stays inside what is loaded. Returns the scroll to do (0 = refuse).
 */
export function allowedScroll(state: ExtensionState, ext: Extent, dy: number): number {
  if (dy <= 0) return dy;
  if (ext.nodes > NODE_CAP) return 0;
  if (!state.extends) return dy;
  const room = state.knownH - 60 - (ext.top + ext.clientH);
  return Math.max(0, Math.min(dy, room));
}
