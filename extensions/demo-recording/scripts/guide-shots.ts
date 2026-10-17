/**
 * The screenshots of GUIDE.md, CONTROL_ROOM.md and TUTORIAL-101.md: the real control room on the branching demo project
 * (the same one BRANCHING.md uses), so the pictures show what the panel shows. Never touches a real project, the real
 * config or a real account (no voice list, no previews that need a model). Local paths are masked.
 *
 *   node extensions/demo-recording/scripts/guide-shots.ts [--out DIR] [--only name,name]
 *
 * The names are the file names in docs/images/guide/ (without the extension). test/part14-docs.test.ts checks that every
 * picture the three documents show is one this script makes, and that it exists.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { branchSeededProject } from "../test/helpers/branching-project.ts";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

export const GUIDE_SHOTS = [
  "01-new-project",
  "02-brief",
  "03-storyboard",
  "04-recording",
  "05-voice",
  "06-versions",
  "07-annotations",
  "08-render",
  "09-map",
  "10-config",
  "11-brands",
  "12-frame-running",
  "13-use-dialog",
  "14-undo-toast",
  "15-shortcuts",
  "16-project-summary",
  "17-narrow",
  "18-light",
] as const;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] as string) : fallback;
};

async function main() {
  const OUT = arg("out", path.join(os.tmpdir(), "guide-shots"));
  const only = new Set(arg("only", "").split(",").filter(Boolean));
  const want = (n: string) => !only.size || only.has(n);

  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "demo-global-config.json");
  fs.writeFileSync(cfg, `${JSON.stringify({ voiceName: "Narrator_voice" }, null, 2)}\n`);
  process.env.DEMO_REC_CONFIG = cfg;
  branchSeededProject(seed.dir);
  // a keyframe for the anchor [@m1], so the Voice inspector shows a picture
  const kf = path.join(
    seed.dir,
    "takes",
    "take-001",
    "analysis",
    "keyframes",
    "01-dash",
    "001350-m1.jpg",
  );
  fs.mkdirSync(path.dirname(kf), { recursive: true });
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "gradients=s=640x360:c0=0x24273a:c1=0x8aadf4:d=1:speed=0",
      "-frames:v",
      "1",
      kf,
    ],
    { stdio: "ignore" },
  );
  if (ff.status !== 0)
    fs.writeFileSync(
      kf,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
  const af = path.join(seed.dir, "takes", "take-001", "analysis", "analysis.json");
  const analysis = JSON.parse(fs.readFileSync(af, "utf8"));
  analysis.scenes[0].marks[0].keyframe = kf;
  fs.writeFileSync(af, JSON.stringify(analysis));
  // a second, empty project for the first-run picture
  ensureProject(seed.root, { project: "demo", appName: "Demo", appUrl: "https://demo.example" });

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
  const pages: import("playwright").Page[] = [];
  const open = async (width = 1400, theme = "macchiato") => {
    const page = await browser.newPage({ viewport: { width, height: 940 } });
    pages.push(page);
    await page.addInitScript(`localStorage.setItem("demo-rec-theme", "${theme}")`);
    await page.route("**/api/annotation-preview", (r) =>
      r.fulfill({
        status: 400,
        contentType: "application/json",
        body: '{"error":"previews are not rendered for these screenshots"}',
      }),
    );
    return page;
  };
  /** Local paths and the panel address (it carries a token) never go into a committed picture. */
  const mask = (page: import("playwright").Page) =>
    page.evaluate(
      `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) n.nodeValue = n.nodeValue.replace(/(\\/private)?\\/(var\\/folders|tmp)\\/\\S+/g, "~/DemoRecordings/…").replace(/http:\\/\\/127\\.0\\.0\\.1\\S*/g, "http://127.0.0.1:…"); })()`,
    );
  const shot = async (page: import("playwright").Page, name: string) => {
    if (!want(name)) return;
    await mask(page);
    await page.waitForTimeout(250);
    const file = path.join(OUT, `${name}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 82 });
    made.push(file);
  };
  const go = async (page: import("playwright").Page, hash: string, ready: string) => {
    await page.goto(`${panel.url}${hash}`);
    await page.waitForSelector(ready);
    await page.waitForTimeout(300);
  };

  try {
    const page = await open();
    // the first run: an empty project
    rt.setActiveProject("demo");
    await go(page, "#/project", ".project-summary");
    await shot(page, "01-new-project");
    rt.setActiveProject(seed.slug);
    await go(page, "#/project", ".project-summary");
    await shot(page, "16-project-summary");
    await go(page, "#/project?group=brief", ".fact-groups");
    await shot(page, "02-brief");
    await go(page, "#/storyboard", ".ds-split-list .ds-item");
    await shot(page, "03-storyboard");
    await go(page, "#/recording", ".card.take");
    await shot(page, "04-recording");
    await go(page, "#/voice/v1", ".ds-split-list .ds-item");
    await page.click(".ds-item[data-key='01-dash']");
    await page.waitForSelector(".ds-anchor img");
    await page.waitForFunction("document.querySelector('.ds-anchor img')?.complete");
    await shot(page, "05-voice");
    await go(page, "#/voice/v2", ".history-btn");
    await page.click(".history-btn");
    await page.waitForSelector(".ds-histpop .ds-version--row");
    await shot(page, "06-versions");
    await page.keyboard.press("Escape");
    await go(page, "#/annotations", ".ds-split-list .ds-item");
    await shot(page, "07-annotations");
    await go(page, "#/render/v2", ".ds-inspector[data-version='2']");
    await shot(page, "08-render");
    await go(page, "#/map", ".ds-map .ds-node");
    await page.click("[data-act=fit]");
    await shot(page, "09-map");
    await page.keyboard.press("Escape");
    await go(page, "#/config", ".ds-srow");
    await shot(page, "10-config");
    await go(page, "#/config?view=brands", ".brand-editor .ds-inspector[data-brand]");
    await page
      .waitForSelector(".ds-brand-shots img[alt='framed sample frame']", { timeout: 30_000 })
      .catch(() => undefined);
    await shot(page, "11-brands");
    // the frame with work running
    await go(page, "#/voice/v1", ".ds-split-list .ds-item");
    const idle = (signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    const render = rt.jobs.start<void>("render", seed.slug, idle);
    rt.bus.publish(
      "render.progress",
      { done: 3, total: 6, label: "scene 3", message: "final scene 3" },
      seed.slug,
    );
    await page.waitForFunction(
      `/running/.test(document.querySelector(".ds-strip .strip-text")?.textContent ?? "")`,
    );
    await page.locator(".ds-strip button[aria-controls=activity]").click();
    await page.waitForSelector("aside#activity .prow");
    await shot(page, "12-frame-running");
    await page.keyboard.press("Escape");
    render.controller.abort();
    await render.done;
    rt.bus.publish("render.finished", { status: "cancelled", message: "cancelled" }, seed.slug);
    // use for next steps: the dialog, then the toast with Undo
    await go(page, "#/voice/v2", ".version-actions");
    await page.getByRole("button", { name: "Use for next steps" }).first().click();
    await page.waitForSelector(".modal.dialog");
    await shot(page, "13-use-dialog");
    await page.locator(".modal.dialog .ds-btn--primary").first().click();
    await page.waitForSelector(".ds-toast [data-act=toast-action]");
    await shot(page, "14-undo-toast");
    await page.locator(".ds-toast [data-act=toast-action]").first().click();
    await page.waitForSelector(".ds-toast:has-text('Undone')");
    await page.waitForTimeout(300);
    // the keyboard sheet
    await page.evaluate("document.activeElement?.blur()");
    await page.keyboard.press("Shift+Slash");
    await page.waitForSelector(".modal.dialog");
    await shot(page, "15-shortcuts");
    await page.keyboard.press("Escape");
    // a narrow window and the light theme
    const narrow = await open(900);
    await go(narrow, "#/voice/v1", ".ds-inspector");
    await shot(narrow, "17-narrow");
    const light = await open(1400, "latte");
    await go(light, "#/render/v2", ".ds-inspector[data-version='2']");
    await shot(light, "18-light");
  } finally {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
  for (const f of made) console.log(f);
}

// Only run when called as a script: the test imports GUIDE_SHOTS.
if (process.argv[1]?.endsWith("guide-shots.ts")) await main();
