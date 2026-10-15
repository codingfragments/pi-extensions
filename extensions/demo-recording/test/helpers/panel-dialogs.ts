/**
 * Answers the panel's in-page dialogs (S5 part 13) the way a test used to answer the native
 * ones: it watches for the top-most `.dialog`, records its text, fills the text field when
 * there is one, and clicks Confirm (or Cancel when `answer.accept` is false).
 */

import type { Page } from "playwright";

export interface DialogAnswerer {
  /** The text of every dialog that appeared, in order. */
  seen: string[];
  answer: { accept: boolean; text?: string };
  stop: () => void;
}

export function answerDialogs(
  page: Page,
  init: { accept?: boolean; text?: string } = {},
): DialogAnswerer {
  const a: DialogAnswerer = {
    seen: [],
    answer: {
      accept: init.accept ?? true,
      ...(init.text !== undefined ? { text: init.text } : {}),
    },
    stop: () => clearInterval(timer),
  };
  let busy = false;
  const timer = setInterval(async () => {
    if (page.isClosed()) return clearInterval(timer);
    if (busy) return;
    busy = true;
    try {
      const open = page.locator(".modal-backdrop .modal.dialog").last();
      if (await open.count()) {
        a.seen.push(((await open.innerText()) ?? "").replace(/\s+\n/g, "\n"));
        if (a.answer.text !== undefined) {
          const input = open.locator("input:not([type=checkbox]), textarea").first();
          if (await input.count()) await input.fill(a.answer.text);
        }
        await open.locator(a.answer.accept ? "[data-confirm]" : "[data-cancel]").click();
        await page.waitForTimeout(80);
      }
    } catch {
      // the page moved on or closed
    } finally {
      busy = false;
    }
  }, 60);
  timer.unref();
  return a;
}
