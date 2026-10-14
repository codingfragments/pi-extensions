/**
 * Wait until the page's DOM stops changing and no busy indicator is visible —
 * the SPA equivalent of "loaded". Resolves after `quietMs` without mutations
 * or visible busy indicators (or after `maxMs` total). Covers
 * client-side rendering after navigation, search results arriving, and
 * streamed chat answers, none of which trigger network-idle or load events
 * reliably.
 */

import type { Page } from "playwright";

/**
 * Visible elements that mean "still working" even when the DOM is momentarily
 * still (thinking pauses, CSS-animated spinners and typing indicators).
 */
export const BUSY_SELECTOR = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[class*="spinner"]',
  '[class*="loading"]',
  '[class*="typing"]',
  '[class*="streaming"]',
  '[class*="skeleton"]',
].join(", ");

export async function waitForDomQuiet(
  page: Page,
  quietMs = 400,
  maxMs = 4000,
): Promise<{ quiet: boolean; ms: number }> {
  // Runs in the page; written as a string so it needs no DOM types here.
  const script = `new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    // Our own cursor overlay moves every frame while it drifts: it is never app content.
    const ours = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return !!(el && (el.id === "__demo_rec_cursor" || (el.closest && el.closest("#__demo_rec_cursor")))); };
    const obs = new MutationObserver((recs) => { if (recs.some((r) => !ours(r.target))) last = performance.now(); });
    obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    const busy = () => [...document.querySelectorAll(${JSON.stringify(BUSY_SELECTOR)})]
      .some((el) => el.id !== "__demo_rec_cursor" && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
    const tick = () => {
      const now = performance.now();
      if (busy()) last = now;
      if (now - last >= ${quietMs}) { obs.disconnect(); resolve({ quiet: true, ms: Math.round(now - start) }); }
      else if (now - start >= ${maxMs}) { obs.disconnect(); resolve({ quiet: false, ms: Math.round(now - start) }); }
      else setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  })`;
  try {
    return (await page.evaluate(script)) as { quiet: boolean; ms: number };
  } catch {
    // Navigation destroyed the context mid-wait: the new page will be awaited by the caller.
    return { quiet: false, ms: 0 };
  }
}
