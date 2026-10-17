/**
 * Screenshots for docs/BRANCHING.md: the real control room on a small *branching* demo project, so the map
 * in the doc is the map you will see. Never touches a real project or the real config.
 *
 *   node extensions/demo-recording/scripts/branching-shots.ts [--out DIR] [--themes macchiato,latte] [--width 1400]
 *
 * The story (also the Mermaid chart 10-branch-paths):
 *   line A, delivered   storyboard v1 → take-001 → voice-over v1 → annotations v1 → final render v2 (on the line)
 *   branch 1, narration voice-over v2 on take-001 (approved, kept as an alternative) → annotations v2 (a draft)
 *   branch 2, story     storyboard v2 (approved, kept) → take-002 (just recorded, not yet approved)
 * Then the shots follow the doc: the map in its three views, the Versions list, the consequence dialog of
 * "Use for next steps", and the map after the line moved.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { branchSeededProject } from "../test/helpers/branching-project.ts";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] as string) : fallback;
};
const OUT = arg("out", path.join(os.tmpdir(), "branching-shots"));
const THEMES = arg("themes", "macchiato,latte").split(",");
const WIDTH = Number(arg("width", "1400"));

process.env.DEMO_REC_NO_OPEN = "1";
const seed = seedPanelProject();
const cfg = path.join(seed.root, "demo-global-config.json");
fs.writeFileSync(cfg, "{}\n");
process.env.DEMO_REC_CONFIG = cfg;

branchSeededProject(seed.dir);
const dir = seed.dir;

const rt = new Runtime(() => ({
  ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
  root: seed.root,
  panelPort: 0,
}));
rt.tellAgent = () => undefined;
rt.setActiveProject(seed.slug);
const panel = await rt.ensurePanel();
const pw = await import("playwright");
const browser = await pw.chromium.launch();
fs.mkdirSync(OUT, { recursive: true });
const made: string[] = [];
try {
  for (const theme of THEMES) {
    const tag = theme === "macchiato" ? "dark" : "light";
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 1300 } });
    await page.addInitScript(`localStorage.setItem("demo-rec-theme", "${theme}")`);
    const shot = async (name: string, full = false) => {
      const file = path.join(OUT, `${name}-${tag}-${WIDTH}.jpg`);
      await page.screenshot({ path: file, fullPage: full, type: "jpeg", quality: 82 });
      made.push(file);
    };
    const mapReady = async () => {
      await page.waitForSelector(".ds-map .ds-node");
      // the real overlay is at most 52rem tall and scrolls inside; for the doc the whole graph is shown at once
      await page.addStyleTag({
        content:
          ".ds-map { block-size: auto !important; max-block-size: none !important } .ds-map-canvas { overflow: visible !important }",
      });
      await page.waitForTimeout(300);
    };
    // the map, three ways
    await page.goto(`${panel.url}#/map`);
    await mapReady();
    await shot("map-all");
    await page.click("button[data-view=approved]");
    await page.waitForTimeout(250);
    await shot("map-approved");
    await page.click("button[data-view=line]");
    await page.waitForTimeout(250);
    await shot("map-line");
    // a branch point in focus
    await page.goto(`${panel.url}#/map?sel=recording%3A1&focus=1`);
    await mapReady();
    await shot("map-focus");
    // the Versions list of the voice-over: two narrations, one on the line, one kept
    await page.goto(`${panel.url}#/voice/v2`);
    await page.waitForSelector(".history-btn");
    await page.click(".history-btn");
    await page.waitForSelector(".ds-histpop .ds-version--row");
    await page.waitForTimeout(250);
    await shot("voice-versions");
    // "Use for next steps": the dialog says what moves
    await page.getByRole("button", { name: "Use for next steps" }).first().click();
    await page.waitForSelector(".modal.dialog");
    await page.waitForTimeout(250);
    await shot("use-dialog");
    // confirm, then the map shows the line on the other narration, stopping where the next stage is missing
    await page.locator(".modal.dialog .ds-btn--primary").first().click();
    await page.waitForSelector(".modal.dialog", { state: "detached" });
    await page.waitForTimeout(400);
    await page.goto(`${panel.url}#/map`);
    await mapReady();
    await page.click("button[data-view=line]");
    await page.waitForTimeout(250);
    await shot("map-line-after");
    await page.goto(`${panel.url}#/recording`);
    await page.waitForSelector(".card.take");
    await page.waitForTimeout(300);
    await shot("recording-two-takes");
    await page.close();
    // put the project back for the next theme: the line on narration 1
    const { planVersionAction, applyVersionAction } = await import(
      "../src/panel/version-actions.ts"
    );
    const { readState } = await import("../src/workdir/state.ts");
    const st = readState(dir) as NonNullable<ReturnType<typeof readState>>;
    const plan = planVersionAction(dir, st, { stage: "vo", version: 1, intent: "use" });
    applyVersionAction(dir, { stage: "vo", version: 1, intent: "use", token: plan.token });
  }
} finally {
  await browser.close();
  await rt.shutdown();
  fs.rmSync(seed.root, { recursive: true, force: true });
}
for (const f of made) console.log(f);
