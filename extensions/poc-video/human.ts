/**
 * human.ts — human-like input layer for pass-2 recording.
 *
 * ghost-cursor drives the mouse along Bézier paths with overshoot and
 * jitter; installMouseHelper draws the DOM cursor overlay (a
 * `<p-mouse-pointer>` circle following the mouse) — the fix for Playwright
 * recording the page but never the OS pointer. Typing is per-character
 * with 45–140 ms jitter.
 *
 * This is the input layer record.ts uses by default
 * (`--raw-input` drops back to instant Playwright input for debugging and
 * fast selector validation).
 */
import { createCursor, installMouseHelper } from "@playwright-labs/ghost-cursor";
import type { GhostCursor } from "@playwright-labs/ghost-cursor";
import type { Page } from "playwright";

export const TYPE_JITTER_MS: readonly [number, number] = [45, 140];

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HumanInput {
  cursor: GhostCursor;
  click(selector: string): Promise<void>;
  hover(selector: string): Promise<void>;
  /** glide to the field, click to focus, then type per-char with jitter */
  type(selector: string, text: string): Promise<void>;
  /**
   * After a navigation the new document's cursor overlay starts idle at 0,0
   * (it only knows mousemoves on its own document). The CDP mouse position
   * persists across navigations — recall re-fires it so the overlay picks
   * the cursor back up, like a real pointer that never teleported.
   */
  recall(): Promise<void>;
}

/**
 * The DOM cursor overlay is installed via addInitScript — it applies from the
 * NEXT navigation on. Create this BEFORE the first navigation (including
 * the user's manual login navigation during the auth handshake), or the
 * video's first segment has no visible cursor. We await installMouseHelper
 * directly instead of createCursor's `visible: true`, which installs it
 * fire-and-forget and can lose the race against the first goto.
 */
export async function createHumanInput(page: Page): Promise<HumanInput> {
  await installMouseHelper(page);
  const cursor = createCursor(page, {
    visible: false, // overlay already installed above — avoid double-injecting
    performRandomMoves: false,
  });
  return {
    cursor,
    async click(selector) {
      await cursor.click(selector);
    },
    async hover(selector) {
      await cursor.move(selector);
    },
    async recall() {
      const { x, y } = cursor.getLocation();
      await page.mouse.move(x, y);
    },
    async type(selector, text) {
      await cursor.click(selector);
      for (const ch of text) {
        await page.keyboard.type(ch);
        await sleep(rand(TYPE_JITTER_MS[0], TYPE_JITTER_MS[1]));
      }
    },
  };
}
