/**
 * The panel audit (UX1): the control room does not get less accessible. A browser run of
 * scripts/panel-audit.ts (axe-core, tab stops, target sizes) on the seeded project must not be worse
 * than the committed baseline (test/fixtures/panel-audit-baseline.json). Skipped, with a reason
 * and never as a pass, when Chromium or axe-core is not available (offline without the cache).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  AUDIT_BASELINE,
  type AuditResult,
  type PageAudit,
  axeSource,
  compare,
  runAudit,
  summary,
} from "../scripts/panel-audit.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();
const axe = browserType ? await axeSource() : undefined;

const page = (over: Partial<PageAudit> = {}): PageAudit => ({
  axe: {},
  axeSerious: 0,
  smallTargets: 0,
  focusMissing: 0,
  focusChecked: 10,
  ...over,
});

test("compare reports growth as worse, shrinkage as better, and ignores axe when it did not run", () => {
  const base: AuditResult = {
    axeVersion: "x",
    pages: { "voice|latte|1400": page({ axeSerious: 5, smallTargets: 10, focusMissing: 1 }) },
  };
  const now: AuditResult = {
    axeVersion: "x",
    pages: { "voice|latte|1400": page({ axeSerious: 7, smallTargets: 4, focusMissing: 1 }) },
  };
  const r = compare(now, base);
  assert.deepEqual(r.worse, ["voice|latte|1400: serious axe nodes 7 > baseline 5"]);
  assert.deepEqual(r.better, ["voice|latte|1400: targets < 24 px 4 < baseline 10"]);
  const noAxe = compare({ ...now, axeVersion: null }, base);
  assert.deepEqual(noAxe.worse, [], "an audit without axe-core cannot claim a regression in axe");
  assert.match(summary({ ...now, axeVersion: null }), /NOT RUN/);
});

test("the baseline covers every screen, theme and width, and starts with no missing focus indicators", () => {
  assert.ok(fs.existsSync(AUDIT_BASELINE), "test/fixtures/panel-audit-baseline.json exists");
  const base = JSON.parse(fs.readFileSync(AUDIT_BASELINE, "utf8")) as AuditResult;
  assert.ok(base.axeVersion, "the baseline was recorded with axe-core");
  const keys = Object.keys(base.pages);
  assert.equal(
    keys.length,
    15 * 2 * 2,
    "15 screens (with Brands, the map and the Project groups) × 2 themes × 2 widths",
  );
  for (const k of keys)
    assert.equal(base.pages[k]?.focusMissing, 0, `${k}: every tab stop shows a focus indicator`);
});

test("the global focus ring, [hidden] and reduced motion are in the design system's base", () => {
  const base = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "panel", "public", "ds", "base.css"),
    "utf8",
  );
  assert.match(base, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
  assert.match(base, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(base, /@media \(prefers-reduced-motion: reduce\)/);
});

test(
  "the audited panel is no worse than the baseline (axe-core, focus, target size; both themes, 1400 and 900 px)",
  {
    skip: !browserType
      ? "needs Playwright Chromium: the audit did not run"
      : !axe
        ? "axe-core is not available (offline without the cache): the audit did not run"
        : false,
    timeout: 300_000,
  },
  async () => {
    const base = JSON.parse(fs.readFileSync(AUDIT_BASELINE, "utf8")) as AuditResult;
    const now = await runAudit();
    assert.equal(now.axeVersion, base.axeVersion, "the same axe-core version as the baseline");
    const { worse, better } = compare(now, base);
    assert.deepEqual(worse, [], `the panel got less accessible:\n${summary(now)}`);
    if (better.length)
      console.log(
        `panel audit improved (lower the baseline: node extensions/demo-recording/scripts/panel-audit.ts --update):\n${better.join("\n")}`,
      );
    // every screen of the seeded project really has content to audit
    assert.equal(Object.keys(now.pages).length, 60);
  },
);

test("the seeded project has something on every tab", () => {
  const s = seedPanelProject();
  try {
    for (const f of [
      "storyboard/v1.yaml",
      "storyboard/v2.yaml",
      "takes/take-001/take.json",
      "vo/script.v1.md",
      "vo/script.v2.md",
      "annotations/v1.json",
      "render/v1.json",
      "render/v7.json",
    ])
      assert.ok(fs.existsSync(path.join(s.dir, f)), `${f} exists`);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
