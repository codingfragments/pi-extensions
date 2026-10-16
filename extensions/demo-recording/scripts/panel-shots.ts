/**
 * Screenshots of the real control room on the seeded project, every tab in both themes at
 * 1400 and 900 px, plus the dialogs and a toast. Used for the before/after comparison of each
 * UX slice.
 *
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/panel-before
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --tabs voice,render --themes latte
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --widths 1400 --format jpeg
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --dialogs   # dialogs and toast only
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --frame     # the frame's states (UX2): menu, running, failed, drawer
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --versions  # versions (UX3): History, the consequence dialog, a disabled action
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] as string) : fallback;
};
const OUT = arg("out", path.join(os.tmpdir(), "panel-shots"));
const FORMAT = arg("format", "png") === "jpeg" ? "jpeg" : "png";
const WIDTHS = arg("widths", "1400,900").split(",").map(Number);
const THEMES = arg("themes", "macchiato,latte").split(",");
const dialogsOnly = process.argv.includes("--dialogs");
const frameOnly = process.argv.includes("--frame");
const versionsOnly = process.argv.includes("--versions");

const TABS: [id: string, label: string][] = [
  ["project", "Project"],
  ["storyboard", "Storyboard"],
  ["recording", "Recording"],
  ["voice", "Voice over"],
  ["annotations", "Annotations"],
  ["render", "Render"],
  ["config", "⚙ Config"],
];
const tabs = arg("tabs", "").split(",").filter(Boolean);

process.env.DEMO_REC_NO_OPEN = "1";
const seed = seedPanelProject();
const rt = new Runtime(() => ({
  ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
  root: seed.root,
  panelPort: 0,
}));
rt.setActiveProject(seed.slug);
const panel = await rt.ensurePanel();
const pw = await import("playwright");
const browser = await pw.chromium.launch();
fs.mkdirSync(OUT, { recursive: true });
const made: string[] = [];
const ext = FORMAT === "jpeg" ? "jpg" : "png";
const shot = async (page: import("playwright").Page, name: string, full = true) => {
  const file = path.join(OUT, `${name}.${ext}`);
  await page.screenshot({
    path: file,
    fullPage: full,
    ...(FORMAT === "jpeg" ? { type: "jpeg" as const, quality: 80 } : {}),
  });
  made.push(file);
};
try {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 1300 } });
      await page.addInitScript(`localStorage.setItem("demo-rec-theme", "${theme}")`);
      await page.goto(panel.url);
      await page.waitForSelector("header.top");
      const tag = `${theme === "macchiato" ? "dark" : "light"}-${width}`;
      if (versionsOnly) {
        await page.goto(`${panel.url}#/voice`);
        await page.waitForSelector(".stage-summary");
        await page.waitForTimeout(300);
        await shot(page, `versions-summary-${tag}`, false);
        await page.locator(".history-btn").click();
        await page.waitForSelector(".ds-histpop");
        await shot(page, `versions-history-${tag}`, false);
        await page.keyboard.press("Escape");
        await page.goto(`${panel.url}#/storyboard`);
        await page.waitForSelector(".version-actions [data-intent=approve-use]");
        await page.getByRole("button", { name: "Approve & use v2" }).click();
        await page.waitForSelector(".modal.dialog");
        await page.waitForTimeout(200);
        await shot(page, `versions-consequence-${tag}`, false);
        await page.keyboard.press("Escape");
        await page.goto(`${panel.url}#/render`);
        await page.waitForSelector(".render-card");
        await page.locator(".render-card", { hasText: "Final v1" }).locator("summary").click();
        await page.waitForSelector(".render-card .ds-why");
        await page.locator(".render-card", { hasText: "Final v1" }).scrollIntoViewIfNeeded();
        await shot(page, `versions-disabled-${tag}`, false);
        await page.goto(`${panel.url}#/recording`);
        await page.waitForSelector(".card.take");
        await shot(page, `versions-recording-${tag}`, false);
      } else if (frameOnly) {
        const idle = (signal: AbortSignal) =>
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        await page.goto(`${panel.url}#/voice`);
        await page.waitForSelector(".vo-diff-head");
        await page.waitForTimeout(300);
        await shot(page, `frame-default-${tag}`, false);
        await page.locator(".ds-next summary").click();
        await shot(page, `frame-menu-${tag}`, false);
        await page.keyboard.press("Escape");
        const render = rt.jobs.start<void>("render", seed.slug, idle);
        const tts = rt.jobs.start<void>("tts", seed.slug, idle);
        rt.bus.publish(
          "render.progress",
          { done: 3, total: 6, label: "scene 3", message: "🎞 final scene 3" },
          seed.slug,
        );
        rt.bus.publish("tts.progress", { done: 1, total: 4, message: "voice 1/4" }, seed.slug);
        await page.waitForFunction(
          `/^2 running/.test(document.querySelector(".ds-strip .strip-text")?.textContent ?? "")`,
        );
        await shot(page, `frame-running-${tag}`, false);
        await page.locator(".ds-strip button[aria-controls=activity]").click();
        await page.waitForSelector("aside#activity .prow");
        await shot(page, `frame-drawer-running-${tag}`, false);
        await page.keyboard.press("Escape");
        render.controller.abort();
        tts.controller.abort();
        await Promise.all([render.done, tts.done]);
        rt.bus.publish("render.finished", { status: "cancelled", message: "cancelled" }, seed.slug);
        rt.bus.publish("tts.finished", { status: "cancelled", message: "cancelled" }, seed.slug);
        const bad = rt.jobs.start<void>("design", seed.slug, async () => {
          throw new Error("the model returned no usable suggestions\nsecond line of the stack");
        });
        await bad.done;
        rt.bus.publish(
          "design.finished",
          { status: "failed", message: "designer failed" },
          seed.slug,
        );
        await page.waitForFunction(`document.querySelector(".ds-strip")?.dataset.tone === "err"`);
        await shot(page, `frame-failed-${tag}`, false);
        await page.getByRole("button", { name: "Show error" }).click();
        await page.waitForSelector("aside#activity [aria-label='Needs attention']");
        await shot(page, `frame-drawer-failed-${tag}`, false);
        // a later success clears the failure, so the next theme and width start from the same state
        const fixed = rt.jobs.start<void>("design", seed.slug, async () => {});
        await fixed.done;
      } else if (!dialogsOnly) {
        for (const [id, label] of TABS) {
          if (tabs.length && !tabs.includes(id)) continue;
          await page
            .locator("header.top a", { hasText: label === "⚙ Config" ? "Config" : label })
            .first()
            .click();
          await page.waitForTimeout(500);
          await shot(page, `${id}-${tag}`);
        }
      } else {
        await page.waitForTimeout(300);
        const open = (body: string) =>
          page.evaluate(`import("/dialog.js").then((m) => { ${body} })`).catch(() => undefined);
        void open(
          `m.ask({ title: "Generate voice and render", facts: [["Sections", "4 to synthesize · 2 cached (free)"], ["Characters", "1,284"], ["Cost", "≈ $0.28"]], confirmLabel: "Generate (≈ $0.28)" })`,
        );
        await page.waitForSelector(".modal.dialog");
        await page.waitForTimeout(200);
        await shot(page, `dialog-cost-${tag}`, false);
        await page.keyboard.press("Escape");
        void open(
          `m.ask({ title: "Delete the files of Final v7?", text: "The record and its QA report stay; the videos are removed. This cannot be undone.", danger: true, confirmLabel: "Delete files" })`,
        );
        await page.waitForSelector(".modal.dialog");
        await page.waitForTimeout(200);
        await shot(page, `dialog-danger-${tag}`, false);
        await page.keyboard.press("Escape");
        await page.evaluate(
          `import("/dialog.js").then((m) => { m.errorToast(new Error("config.json is read-only"), "fps"); m.toast("Draft saved", "ok"); })`,
        );
        await page.waitForSelector(".toast");
        await page.waitForTimeout(200);
        await shot(page, `toast-${tag}`, false);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  await rt.shutdown();
  fs.rmSync(seed.root, { recursive: true, force: true });
}
for (const f of made) console.log(f);
