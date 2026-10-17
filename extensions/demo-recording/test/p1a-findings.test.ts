/**
 * P1a PR 11 (Q1b): a finding names its stage and version, one view serves every stage, coverage is said, and the
 * panel's "Checks of <stage> vN" popup shows it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { findingsFor } from "../src/qa/findings.ts";
import { qaFile } from "../src/qa/run.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

function writeReport(dir: string, report: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(qaFile(dir, 1)), { recursive: true });
  fs.writeFileSync(qaFile(dir, 1), JSON.stringify(report));
}

const REPORT = {
  render: 1,
  stage: "render",
  version: 1,
  variant: "neutral",
  createdAt: "2026-10-18T10:00:00.000Z",
  whisper: true,
  coverage: { anchors: { measured: 11, total: 16 } },
  items: [
    {
      id: "annotations-1",
      check: "annotations",
      level: "blocking",
      hard: "redaction",
      atMs: 2500,
      message: "redaction r1 doesn't cover its element here",
    },
    {
      id: "values-2",
      check: "values",
      level: "warning",
      high: true,
      atMs: 2100,
      message: "the narration says 14.3: it isn't on screen",
    },
    { id: "media-3", check: "media", level: "warning", message: "no narration for 4.6 s" },
    {
      id: "media-4",
      check: "media",
      level: "info",
      moments: [1000, 9000],
      atMs: 1000,
      message: "2 held frames",
    },
  ],
};

test("findingsFor: every finding names its stage and version; the summary and the coverage come with it", () => {
  const seed = seedPanelProject();
  try {
    writeReport(seed.dir, REPORT);
    const v = findingsFor(seed.dir, "render", 1);
    assert.equal(v.checked, true);
    assert.equal(v.findings.length, 4);
    assert.ok(v.findings.every((f) => f.stage === "render" && f.version === 1));
    assert.deepEqual(v.coverage, { anchors: { measured: 11, total: 16 } });
    assert.equal(v.whisper, true);
    assert.deepEqual(
      [v.summary?.blocking, v.summary?.high, v.summary?.warnings, v.summary?.info],
      [1, 1, 2, 1],
    );
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("findingsFor: a final without QA, a draft and the stages without adapters say why there is nothing", () => {
  const seed = seedPanelProject();
  try {
    assert.match(findingsFor(seed.dir, "render", 1).note ?? "", /QA has not run on this final/);
    assert.match(findingsFor(seed.dir, "render", 99).note ?? "", /QA runs on finals/);
    for (const stage of ["storyboard", "recording", "vo", "annotations"] as const) {
      const v = findingsFor(seed.dir, stage, 1);
      assert.deepEqual([v.checked, v.findings.length], [false, 0]);
      assert.match(v.note ?? "", /no automatic checks yet/);
    }
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("GET /api/checks: one route for every stage; bad input is an error", async () => {
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  try {
    writeReport(seed.dir, REPORT);
    const get = rt.routeTables().get.checks as (q: URLSearchParams) => { findings: unknown[] };
    assert.equal(get(new URLSearchParams("stage=render&version=1")).findings.length, 4);
    assert.throws(() => get(new URLSearchParams("stage=nope&version=1")), /unknown stage/);
    assert.throws(() => get(new URLSearchParams("stage=render")), /"version" is required/);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

test(
  "Render: All checks… opens the popup with the findings in groups; Escape closes it",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    writeReport(seed.dir, REPORT);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${panel.url}#/render/v1`);
      await page.waitForSelector(".ds-inspector[data-version='1']");
      await page.getByRole("button", { name: "All checks…" }).click();
      const dialog = page.getByRole("dialog", { name: "Checks of render v1" });
      await dialog.waitFor();
      await dialog.locator(".checks").waitFor();
      const text = await dialog.innerText();
      assert.match(text, /hard stops\s*1/i);
      assert.match(text, /needs your eyes\s*1/i);
      assert.match(text, /worth a look\s*1/i);
      assert.match(text, /sync measured at 11 of 16 anchors/);
      assert.match(text, /Info \(1\)/);
      assert.match(text, /redaction r1 doesn't cover its element here/);
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-checks.png` });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
