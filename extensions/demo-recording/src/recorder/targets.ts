/**
 * Storyboard target → Playwright locator. Resolution order follows the plan:
 * role+name → text → label → css. Always `.first()` visible match.
 */

import type { Locator, Page } from "playwright";
import type { Target } from "../storyboard/types.ts";
import type { Box } from "./events.ts";

type AriaRole = Parameters<Page["getByRole"]>[0];

export function locate(page: Page, target: Target): Locator {
  if ("role" in target) {
    return page
      .getByRole(target.role as AriaRole, {
        ...(target.name ? { name: target.name } : {}),
        ...(target.exact !== undefined ? { exact: target.exact } : {}),
      })
      .first();
  }
  if ("text" in target)
    return page.getByText(target.text, { exact: target.exact ?? false }).first();
  if ("label" in target) return page.getByLabel(target.label).first();
  return page.locator(target.css).first();
}

export function describeTarget(target: Target): string {
  if ("role" in target) return `${target.role}${target.name ? ` "${target.name}"` : ""}`;
  if ("text" in target) return `text "${target.text}"`;
  if ("label" in target) return `label "${target.label}"`;
  return `css ${target.css}`;
}

/** Wait for the target, scroll it into view, and return its viewport box (CSS px). */
export async function resolveBox(
  page: Page,
  target: Target,
  timeout = 10000,
): Promise<{ locator: Locator; box: Box }> {
  const locator = locate(page, target);
  try {
    await locator.waitFor({ state: "visible", timeout });
  } catch {
    throw new Error(`target not visible within ${timeout} ms: ${describeTarget(target)}`);
  }
  await locator.scrollIntoViewIfNeeded();
  const bb = await locator.boundingBox();
  if (!bb) throw new Error(`target has no bounding box: ${describeTarget(target)}`);
  return {
    locator,
    box: {
      x: Math.round(bb.x),
      y: Math.round(bb.y),
      w: Math.round(bb.width),
      h: Math.round(bb.height),
    },
  };
}
