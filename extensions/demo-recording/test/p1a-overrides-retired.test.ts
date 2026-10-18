/**
 * Q7: render overrides are retired. Timing is fixed in the script (`[@mark +300ms]`, Q6) and through the fix loop, not by a hidden shift on one
 * render. Nothing creates an override: no "Apply N fixes" button, no route, no CLI flag, no `fix` on a finding. Renders that were made with one
 * (keycraft v3 to v5) keep their file, are still read, and are named for what they are.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { effectiveTimeline, qaFile, summarize } from "../src/qa/run.ts";
import { type RenderRecord, readRender, saveRecord } from "../src/render/store.ts";
import { Runtime } from "../src/runtime.ts";
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

// a report as an OLD engine wrote it: a drift item that carries a `fix`
const OLD_ITEMS = [
  {
    id: "drift-1",
    check: "drift",
    level: "warning",
    high: true,
    scene: "01-dash",
    atMs: 9000,
    message:
      "the narration for @emea-bar starts 1004 ms after its moment (measured; the edit planned +375 ms)",
    identity: { anchor: "emea-bar" },
    fix: {
      kind: "shift-narration",
      scene: "01-dash",
      anchor: "emea-bar",
      deltaMs: -1004,
      label: "move it 1.00 s earlier",
    },
  },
];

function setup() {
  const seed = seedPanelProject();
  fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
  fs.writeFileSync(
    qaFile(seed.dir, 1),
    JSON.stringify({
      render: 1,
      stage: "render",
      version: 1,
      variant: "neutral",
      createdAt: "2026-10-18T10:00:00.000Z",
      whisper: true,
      items: OLD_ITEMS,
    }),
  );
  const rec = readRender(seed.dir, 1) as RenderRecord;
  rec.qa = summarize(OLD_ITEMS as never);
  rec.overrides = { fromRender: 0, shifts: 2 };
  saveRecord(seed.dir, rec);
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  return { seed, rt };
}

test("nothing can create an override: no route, no CLI flag, no finding carries a fix", () => {
  const { seed, rt } = setup();
  try {
    assert.equal(rt.routeTables().post["render-qa-fix"], undefined, "the route is gone");
    const cli = fs.readFileSync(path.join(import.meta.dirname, "..", "cli.ts"), "utf8");
    assert.doesNotMatch(cli, /--fix\b|fixRequest/, "the CLI flag is gone");
    const run = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "qa", "run.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      run,
      /shift-narration|export function fixRequest/,
      "the QA no longer proposes or builds a shift",
    );
    const render = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "render", "run.ts"),
      "utf8",
    );
    assert.doesNotMatch(render, /overrides\.json/, "a render never writes the file");
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("an old render keeps its override: still read, and named for what it is", () => {
  const { seed, rt } = setup();
  try {
    fs.writeFileSync(
      path.join(seed.dir, "render", "v1.overrides.json"),
      JSON.stringify({
        fromRender: 0,
        shifts: [
          {
            kind: "shift-narration",
            scene: "01-dash",
            anchor: "m2",
            deltaMs: 300,
            label: "an old fix",
          },
        ],
      }),
    );
    const rec = readRender(seed.dir, 1) as RenderRecord;
    const timeline = effectiveTimeline(seed.dir, rec);
    const plain = JSON.parse(
      fs.readFileSync(path.join(seed.dir, "edit", `timeline.v${rec.timeline}.json`), "utf8"),
    );
    assert.ok(
      timeline.scenes.length === plain.scenes.length,
      "the timeline of an old render is still built",
    );
    assert.deepEqual(
      readRender(seed.dir, 1)?.overrides,
      { fromRender: 0, shifts: 2 },
      "the record still says it",
    );
    void rt;
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test(
  "Render: an old report's `fix` shows nothing to apply; the finding is flagged like any other; the old render says 'legacy timing fixes'",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const { seed, rt } = setup();
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(`${panel.url}#/render/v1`);
      const qa = page.locator(".ds-inspector .ds-section", { hasText: "Quality check" });
      await qa.getByText("the narration for @emea-bar starts 1004 ms after its moment").waitFor();
      assert.equal(
        await page.getByRole("button", { name: /Apply \d+ fix/ }).count(),
        0,
        "no Apply N fixes button",
      );
      assert.equal(
        await qa.locator(".qa-fix, input[type=checkbox]").count(),
        0,
        "no fix checkbox on the finding",
      );
      assert.equal(
        await qa.locator("li.qa-item").first().locator("[data-flag=fix]").count(),
        1,
        "it is flagged Fix / Leave like any other",
      );
      assert.match(
        await page.locator(".ds-inspector").first().innerText(),
        /legacy timing fixes: 2 shift\(s\) from render v0/,
      );
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
