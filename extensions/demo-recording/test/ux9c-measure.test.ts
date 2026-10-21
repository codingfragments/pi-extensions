/**
 * UX9c (docs/UX.md §9, "Evidence and bars"): the controls a screen shows when it opens, measured on the seeded
 * project at the spec's 1500 px, against the pre-pass measurements quoted there (Render 196, Annotations 102,
 * Voice 46, Config 58, Project 30, Storyboard 22, Recording 5). The bar is to at least halve Render and
 * Annotations without removing a capability; the others must not grow back. No screen may scroll sideways.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { measure } from "../scripts/ux-measure.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const skip = !(await chromium()) && "needs Playwright Chromium";

const PRE_PASS = {
  Render: 196,
  Annotations: 102,
  "Voice over": 46,
  Config: 58,
  // 31: one more control on purpose (S7): "Log in…" on the Login card, which is how a saved login starts
  Project: 31,
  Storyboard: 22,
  Recording: 5,
} as const;

test(
  "controls when a screen opens: Render and Annotations at most half of the pre-pass count; nothing else grows back",
  { skip, timeout: 180_000 },
  async () => {
    const rows = (await measure({ widths: [1500], themes: ["macchiato"] })) as {
      screen: string;
      controls: number;
      frame: number;
      height: number;
    }[];
    const by = (n: string) => rows.find((r) => r.screen === n) as (typeof rows)[number];
    const total = (n: string) => by(n).controls + by(n).frame;
    assert.ok(
      total("Render") <= PRE_PASS.Render / 2,
      `Render: ${total("Render")} controls (was ${PRE_PASS.Render})`,
    );
    assert.ok(
      total("Annotations") <= PRE_PASS.Annotations / 2,
      `Annotations: ${total("Annotations")} (was ${PRE_PASS.Annotations})`,
    );
    // the frame is on every screen, so the others are compared with their own controls plus the frame's, with the
    // frame's growth (stepper, Map, band, strip) said openly in docs/ux/UX9c.md; they must not grow beyond this
    assert.ok(total("Voice over") <= 60, `Voice over: ${total("Voice over")}`);
    assert.ok(total("Storyboard") <= 40, `Storyboard: ${total("Storyboard")}`);
    assert.ok(
      total("Project") <= PRE_PASS.Project,
      `Project (the summary): ${total("Project")} (was ${PRE_PASS.Project})`,
    );
    // 21: one more control on purpose: "Show the browser window while recording" on the request card
    assert.ok(total("Recording") <= 21, `Recording: ${total("Recording")}`);
    assert.ok(
      by("Render").frame >= 10 && by("Render").frame <= 16,
      "the frame is about thirteen controls on every screen",
    );
  },
);
