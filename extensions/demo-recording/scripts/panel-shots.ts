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
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --config      # Config (UX9a): settings with their layers, a search, a filter, the editor
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --project     # Project (UX8): summary, the brief group, findings
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --render      # Render (UX7): runs list + inspector, New render summary and Change…
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --annotations # Annotations (UX6): list by scene + inspector, draft saved, conflict, privacy dialog
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --storyboard # Storyboard (UX5c): scene list + inspector, a marked scene
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --voice     # Voice over (UX5): list + inspector, draft saved, failed save, conflict, base moved
 *   node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --map       # the project map (UX4): all paths, search, focus, group open, History link
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
const mapOnly = process.argv.includes("--map");
const voiceOnly = process.argv.includes("--voice");
const storyboardOnly = process.argv.includes("--storyboard");
const annotationsOnly = process.argv.includes("--annotations");
const renderOnly = process.argv.includes("--render");
const projectOnly = process.argv.includes("--project");
const configOnly = process.argv.includes("--config");

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
// the panel's config routes read the config file from the environment: never the real one, never in a screenshot
const demoConfig = path.join(seed.root, "demo-global-config.json");
fs.writeFileSync(
  demoConfig,
  `${JSON.stringify({ voiceName: "Narrator_voice", fps: 24 }, null, 2)}\n`,
);
process.env.DEMO_REC_CONFIG = demoConfig;
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
      if (configOnly) {
        await page.goto(`${panel.url}#/config`);
        await page.waitForSelector(".ds-setting");
        await page.waitForTimeout(300);
        await shot(page, `config-all-${tag}`, false);
        await page.goto(`${panel.url}#/config?q=voice`);
        await page.waitForSelector("mark.ds-hit");
        await shot(page, `config-search-${tag}`, false);
        await page.click(".ds-setting[data-key='voiceName'] [data-act=edit-global]");
        await shot(page, `config-edit-${tag}`, false);
        await page.goto(`${panel.url}#/config?filter=changed`);
        await page.waitForSelector(".ds-setting");
        await shot(page, `config-changed-${tag}`, false);
      } else if (projectOnly) {
        await page.goto(`${panel.url}#/project`);
        await page.waitForSelector(".project-summary");
        await page.waitForTimeout(300);
        await shot(page, `project-summary-${tag}`, false);
        await page.goto(`${panel.url}#/project?group=brief&field=goal`);
        await page.waitForSelector(".fact-groups");
        await page.waitForTimeout(300);
        await shot(page, `project-brief-${tag}`, false);
        await page.goto(`${panel.url}#/project?group=findings`);
        await page.waitForSelector("li.finding, .card.muted");
        await page.waitForTimeout(200);
        await shot(page, `project-findings-${tag}`, false);
      } else if (renderOnly) {
        await page.goto(`${panel.url}#/render/v2`);
        await page.waitForSelector(".ds-inspector[data-version='2']");
        await page.waitForTimeout(300);
        await shot(page, `render-approved-${tag}`, false);
        await page.goto(`${panel.url}#/render/v1`);
        await page.waitForSelector(".ds-inspector[data-version='1'] .ds-why");
        await shot(page, `render-blocked-${tag}`, false);
        await page.click(".render-change > summary");
        await page.waitForTimeout(200);
        await shot(page, `render-change-${tag}`, false);
      } else if (annotationsOnly) {
        const { editAnnotationDraft, readAnnotationDraft } = await import(
          "../src/drafts/annotations.ts"
        );
        // the previews need Chromium and ffmpeg per still: the shots show the screen, not the pictures
        await page.route("**/api/annotation-preview", (r) =>
          r.fulfill({
            status: 400,
            contentType: "application/json",
            body: '{"error":"previews are not rendered for this screenshot"}',
          }),
        );
        const saved = () =>
          page.waitForFunction(
            `/Draft saved/.test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
          );
        await page.goto(`${panel.url}#/annotations?item=co-kpi`);
        await page.waitForSelector(".ds-inspector h2");
        await page.waitForTimeout(300);
        await shot(page, `annotations-list-${tag}`, false);
        await page.click("button[data-act=row-enabled][data-id='ch-dash']");
        await saved();
        await page.click(".ds-inspector button[title='0.5 s later']");
        await saved();
        await shot(page, `annotations-draft-${tag}`, false);
        editAnnotationDraft(
          seed.dir,
          1,
          { op: "toggle", id: "sp-row" },
          { expected: readAnnotationDraft(seed.dir, 1)?.revision ?? null, author: "other-tab" },
        );
        await page.click("button[data-act=row-enabled][data-id='zoom-kpi']");
        await page.waitForSelector("[data-act=reapply]");
        await shot(page, `annotations-conflict-${tag}`, false);
        await page.click("[data-act=keep-theirs]");
        await page.click("button[data-act=row-enabled][data-id='rd-mail']");
        await saved();
        await page.click(".ds-item[data-key='rd-mail']");
        await page.click("button[data-act=row-enabled][data-id='rd-mail']");
        await page.waitForSelector(".modal.dialog");
        await shot(page, `annotations-privacy-${tag}`, false);
      } else if (storyboardOnly) {
        await page.goto(`${panel.url}#/storyboard?scene=02-search`);
        await page.waitForSelector(".ds-inspector h2");
        await page.waitForTimeout(300);
        await shot(page, `storyboard-list-${tag}`, false);
        await page.click("[data-status=changes]");
        await page.fill(
          "textarea[aria-label='Notes for this scene']",
          "Type a longer query so the results change visibly.",
        );
        await page.locator("textarea[aria-label='Notes for this scene']").blur();
        await page.waitForTimeout(500);
        await shot(page, `storyboard-review-${tag}`, false);
      } else if (voiceOnly) {
        const { saveDraft, readDraft } = await import("../src/drafts/store.ts");
        const field = page.locator(".ds-split-detail textarea[id^=narration]");
        const saved = () =>
          page.waitForFunction(
            `/Draft saved/.test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
          );
        await page.goto(`${panel.url}#/voice?section=01-dash`);
        await field.waitFor();
        await page.waitForTimeout(300);
        await shot(page, `voice-list-${tag}`, false);
        await field.fill(
          "Headline churn reads 4.2 percent, up from 3.1. [@m1] Steady. [@m2] EMEA is the outlier.",
        );
        await saved();
        await shot(page, `voice-draft-${tag}`, false);
        await page.route("**/api/draft-save", (r) => r.abort("failed"));
        await page.locator(".ds-item[data-key=_outro]").click();
        await page
          .locator(".ds-split-detail textarea[id^=narration]")
          .fill("An outro that cannot be saved.");
        await page.waitForSelector(".ds-notice:has-text('Save failed')");
        await shot(page, `voice-failed-${tag}`, false);
        await page.unroute("**/api/draft-save");
        await page.click("[data-act=retry]");
        await saved();
        saveDraft(seed.dir, "vo", 2, {
          expected: readDraft(seed.dir, "vo", 2)?.revision ?? null,
          edits: { "01-dash": "Changed in another tab." },
          author: "other-tab",
        });
        await page.locator(".ds-item[data-key=_intro]").click();
        await page.locator(".ds-split-detail textarea[id^=narration]").fill("Another opening.");
        await page.waitForSelector(".ds-notice:has-text('another tab')");
        await page.click(".ds-notice button:has-text('Compare')");
        await shot(page, `voice-conflict-${tag}`, false);
        await page.goto(`${panel.url}#/voice/v1`);
        await page.locator(".ds-split-detail textarea[id^=narration]").waitFor();
        await page
          .locator(".ds-split-detail textarea[id^=narration]")
          .fill("Edited on the older version.");
        await saved();
        await page.reload();
        await page.waitForSelector(".ds-notice:has-text('v2 exists')");
        await page.click("button:has-text('Compare with v2')");
        await shot(page, `voice-base-moved-${tag}`, false);
      } else if (mapOnly) {
        const ready = async () => {
          await page.waitForSelector(".ds-map .ds-node");
          await page.waitForTimeout(250);
        };
        await page.goto(`${panel.url}#/map`);
        await ready();
        await shot(page, `map-all-${tag}`, false);
        await page.goto(`${panel.url}#/map?q=final`);
        await ready();
        await shot(page, `map-search-${tag}`, false);
        await page.goto(`${panel.url}#/map?sel=vo%3A2&focus=1`);
        await ready();
        await shot(page, `map-focus-${tag}`, false);
        await page.goto(`${panel.url}#/map?sel=render%3A2&open=drafts%3Arender%3Aannotations%3A1`);
        await ready();
        await shot(page, `map-group-${tag}`, false);
        await page.goto(`${panel.url}#/voice`);
        await page.waitForSelector(".history-btn");
        await page.locator(".history-btn").click();
        await page.waitForSelector(".ds-histpop .show-in-map");
        await shot(page, `map-entry-${tag}`, false);
      } else if (versionsOnly) {
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
        await page.goto(`${panel.url}#/render/v1`);
        await page.waitForSelector(".ds-inspector[data-version='1'] .ds-why");
        await page.locator(".ds-inspector[data-version='1']").scrollIntoViewIfNeeded();
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
