/**
 * UX2 in the browser (D98–D101, D111): the hash routes, the stepper and the next-action band, results
 * that never move you, what the strip says about running and failed jobs, and the Activity drawer.
 * Runs on the seeded project (test/helpers/panel-seed.ts). Skipped without Chromium.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { readState } from "../src/workdir/state.ts";
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
const skip = !browserType && "needs Playwright Chromium";

async function setup() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const close = async () => {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, rt, panel, browser, context, close };
}

const idle = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));

test(
  "routes: a new project starts at Project; the place is in the URL, Back works, and looking changes nothing",
  { skip, timeout: 60_000 },
  async () => {
    const { seed, panel, context, close } = await setup();
    try {
      const stateBefore = fs.readFileSync(path.join(seed.dir, "state.json"), "utf8");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(panel.url);
      await page.waitForFunction(`location.hash === "#/project"`);
      assert.equal(await page.locator("header.top a[aria-current=page]").innerText(), "Project");

      await page.locator("nav.steps a", { hasText: "Voice over" }).click();
      await page.waitForFunction(`location.hash === "#/voice"`);
      await page.waitForSelector(".vo-diff-head");
      await page.locator("nav.steps a", { hasText: "Render" }).click();
      await page.waitForFunction(`location.hash === "#/render"`);
      await page.goBack();
      await page.waitForFunction(`location.hash === "#/voice"`);
      await page.waitForSelector(".vo-diff-head");
      await page.goForward();
      await page.waitForFunction(`location.hash === "#/render"`);

      // reload keeps the place; the token is gone from the URL but the hash stays
      await page.reload();
      assert.equal(await page.evaluate("location.hash"), "#/render");
      assert.equal(await page.evaluate("location.search"), "");

      // a bare URL later restores the last place in this project
      const again = await context.newPage();
      await again.goto(panel.url);
      await again.waitForFunction(`location.hash === "#/render"`);
      assert.equal(
        await again
          .locator("nav.steps a[aria-current=step]")
          .innerText()
          .then((t) =>
            t
              .replace(/^\S+\s*/, "")
              .split("\n")[0]
              ?.trim(),
          ),
        "Render",
      );

      // an unknown route explains itself and falls back
      await page.goto(`${panel.url}#/nowhere`);
      await page.waitForFunction(`location.hash === "#/project"`);
      assert.match(
        await page.locator("main .route-notice").innerText(),
        /“nowhere” is not a screen of this panel\. Showing Project\./,
      );
      await page.goto(`${panel.url}#/map`);
      await page.waitForFunction(`location.hash === "#/project"`);
      assert.match(
        await page.locator("main .route-notice").innerText(),
        /“map” is not available yet/,
      );
      // the notice goes away when you move on
      await page.locator("nav.steps a", { hasText: "Storyboard" }).click();
      await page.waitForFunction(`!document.querySelector("main .route-notice")`);

      assert.equal(
        fs.readFileSync(path.join(seed.dir, "state.json"), "utf8"),
        stateBefore,
        "navigating never changes project state",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "the stepper and the band say where each stage stands and what needs you, in plain words",
  { skip, timeout: 60_000 },
  async () => {
    const { seed, panel, context, close } = await setup();
    try {
      const page = await context.newPage();
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector("nav.steps a[data-state]");
      // storyboard v2 and voice-over v2 are drafts newer than what is accepted; the rest is on the line
      const states = await page.evaluate(
        `Object.fromEntries([...document.querySelectorAll("nav.steps a")].map((a) => [a.dataset.tab, a.dataset.state]))`,
      );
      assert.deepEqual(states, {
        storyboard: "needs",
        recording: "complete",
        voice: "needs",
        annotations: "complete",
        render: "complete",
      });
      assert.match(
        await page.locator("nav.steps a[data-tab=voice]").innerText(),
        /Voice over\s*— needs you/,
      );
      assert.equal(
        await page.locator("nav.steps a[aria-current=step]").getAttribute("data-tab"),
        "recording",
      );

      const band = page.locator(".ds-next");
      assert.equal(await band.getAttribute("data-tone"), "needs");
      assert.match(await band.innerText(), /needs you\s*Storyboard v2 is waiting for review/i);
      // the other pending item is listed, and linked
      await band.locator("summary").click();
      assert.match(
        await band.locator(".ds-menu li").innerText(),
        /Voice over v2 is waiting for review/,
      );
      await page.keyboard.press("Escape");
      // Continue is a link: it goes there and changes nothing
      const before = readState(seed.dir)?.updatedAt;
      await band.getByRole("link", { name: "Continue" }).click();
      await page.waitForFunction(`location.hash === "#/storyboard"`);
      assert.equal(readState(seed.dir)?.updatedAt, before);
      // the Recording screen carries the shared stage title
      await page.locator("nav.steps a", { hasText: "Recording" }).click();
      await page.waitForFunction(`document.querySelector("main h1")?.textContent === "Recording"`);
    } finally {
      await close();
    }
  },
);

test(
  "a result that arrives never moves you: it puts a badge on its step, and what you are typing stays",
  { skip, timeout: 60_000 },
  async () => {
    const { rt, seed, panel, context, close } = await setup();
    try {
      // events from before the page opened are history, not news
      rt.bus.publish("storyboard.written", { version: 2, message: "storyboard v2" }, seed.slug);
      const page = await context.newPage();
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".vo-diff-head");
      assert.equal(
        await page.locator("nav.steps .ds-badge").count(),
        0,
        "replayed history is no news",
      );

      await page.locator("textarea[placeholder^='Notes for this section']").first().focus();
      await page.keyboard.type("keep this note");
      const focused = await page.evaluate("document.activeElement?.tagName");
      rt.bus.publish("storyboard.written", { version: 3, message: "storyboard v3" }, seed.slug);
      rt.bus.publish(
        "annotations.updated",
        { by: "agent", version: 2, message: "annotations v2" },
        seed.slug,
      );
      rt.bus.publish("vo.written", { by: "user", version: 3, message: "your edit" }, seed.slug);
      await page.waitForSelector("nav.steps a[data-tab=storyboard] .ds-badge");
      assert.equal(await page.evaluate("location.hash"), "#/voice", "the screen did not change");
      assert.equal(
        await page.evaluate("document.activeElement?.tagName"),
        focused,
        "the focus did not move",
      );
      assert.equal(
        await page.evaluate("document.activeElement?.value"),
        "keep this note",
        "the text you typed is there",
      );
      assert.match(await page.locator("nav.steps a[data-tab=storyboard]").innerText(), /new/);
      assert.match(
        await page.locator("nav.steps a[data-tab=storyboard] .ds-sr-only").innerText(),
        /new result/,
      );
      assert.equal(await page.locator("nav.steps a[data-tab=annotations] .ds-badge").count(), 1);
      assert.equal(
        await page.locator("nav.steps a[data-tab=voice] .ds-badge").count(),
        0,
        "your own edit is not news",
      );
      // visiting the screen clears its badge
      await page.locator("nav.steps a[data-tab=storyboard]").click();
      await page.waitForFunction(
        `!document.querySelector("nav.steps a[data-tab=storyboard] .ds-badge")`,
      );
      assert.equal(
        await page.locator("nav.steps a[data-tab=annotations] .ds-badge").count(),
        1,
        "the others stay until visited",
      );
    } finally {
      await close();
    }
  },
);

test(
  "the strip: running comes from real jobs, progress only when known, several jobs counted, failures stay",
  { skip, timeout: 90_000 },
  async () => {
    const { rt, seed, panel, context, close } = await setup();
    try {
      const page = await context.newPage();
      await page.goto(`${panel.url}#/render`);
      await page.waitForSelector(".ds-strip");
      const text = () => page.locator(".ds-strip .strip-text").innerText();
      assert.equal(await text(), "Nothing running");

      // the Director has not started anything: "waiting" is not "running"
      assert.equal(await page.locator("nav.steps a[data-state=running]").count(), 0);

      // a real job, no progress yet: it runs, with no invented percentage
      const render = rt.jobs.start<void>("render", seed.slug, idle);
      rt.bus.publish("render.started", { message: "final render started" }, seed.slug);
      await page.waitForFunction(
        `document.querySelector(".ds-strip .strip-text")?.textContent === "Render"`,
      );
      assert.equal(
        await page.locator(".ds-strip [role=progressbar]").count(),
        0,
        "no percentage without progress",
      );
      assert.equal(
        await page.locator("nav.steps a[data-tab=render]").getAttribute("data-state"),
        "running",
      );
      assert.equal(
        await page.locator("nav.steps a[data-tab=render]").getAttribute("aria-current"),
        "step",
      );

      rt.bus.publish(
        "render.progress",
        { done: 3, total: 6, label: "scene 3", message: "🎞 final scene 3" },
        seed.slug,
      );
      await page.waitForFunction(
        `document.querySelector(".ds-strip .strip-text")?.textContent === "Render 50%"`,
      );
      assert.equal(
        await page.locator(".ds-strip [role=progressbar]").getAttribute("aria-valuenow"),
        "50",
      );

      // two jobs: counted, no single percentage
      const tts = rt.jobs.start<void>("tts", seed.slug, idle);
      rt.bus.publish("tts.progress", { done: 1, total: 4, message: "voice 1/4" }, seed.slug);
      await page.waitForFunction(
        `/^2 running/.test(document.querySelector(".ds-strip .strip-text")?.textContent ?? "")`,
      );
      assert.equal(await page.locator(".ds-strip [role=progressbar]").count(), 0);
      assert.equal(
        await page.locator("nav.steps a[data-tab=voice]").getAttribute("data-state"),
        "running",
      );

      render.controller.abort();
      tts.controller.abort();
      await Promise.all([render.done, tts.done]);
      rt.bus.publish("render.finished", { status: "cancelled", message: "cancelled" }, seed.slug);
      rt.bus.publish("tts.finished", { status: "cancelled", message: "cancelled" }, seed.slug);
      await page.waitForFunction(
        `document.querySelector(".ds-strip .strip-text")?.textContent === "Nothing running"`,
      );

      // a failure: red in the strip, blocked in the stepper, and the drawer does not open by itself
      const bad = rt.jobs.start<void>("design", seed.slug, async () => {
        throw new Error("model said no\nsecond line of the stack");
      });
      await bad.done;
      rt.bus.publish(
        "design.finished",
        { status: "failed", message: "designer failed" },
        seed.slug,
      );
      await page.waitForFunction(`document.querySelector(".ds-strip")?.dataset.tone === "err"`);
      assert.equal(await text(), "Annotation designer failed: model said no");
      assert.equal(
        await page.locator("aside#activity").isVisible(),
        false,
        "an error never opens the drawer",
      );
      assert.equal(
        await page.locator("nav.steps a[data-tab=annotations]").getAttribute("data-state"),
        "blocked",
      );
      assert.match(
        await page.locator(".ds-next").innerText(),
        /blocked\s*Annotation designer failed/i,
      );

      // "Show error" is a click: the drawer opens with the failure and its details
      await page.getByRole("button", { name: "Show error" }).click();
      await page.waitForSelector("aside#activity", { state: "visible" });
      assert.match(
        await page.locator("aside#activity [aria-label='Needs attention']").innerText(),
        /Annotation designer failed/,
      );
      await page.locator("aside#activity details summary").click();
      assert.match(
        await page.locator("aside#activity pre").innerText(),
        /second line of the stack/,
      );
      // dismissing clears the strip but the failure stays listed under Recent
      await page.getByRole("button", { name: "Dismiss" }).click();
      await page.waitForFunction(`document.querySelector(".ds-strip")?.dataset.tone === "idle"`);
      assert.match(
        await page.locator("aside#activity [aria-label='Recent jobs']").innerText(),
        /Annotation designer · failed \(dismissed\)/,
      );
    } finally {
      await close();
    }
  },
);

test(
  "the drawer: opens only on request, takes the focus, Escape closes it (a dialog first), the focus goes back",
  { skip, timeout: 60_000 },
  async () => {
    const { panel, context, close } = await setup();
    try {
      const page = await context.newPage();
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".ds-strip");
      const drawer = page.locator("aside#activity");
      assert.equal(await drawer.isVisible(), false);
      assert.equal(
        await page
          .locator(".ds-strip button[aria-controls=activity]")
          .getAttribute("aria-expanded"),
        "false",
      );

      const button = page.locator(".ds-strip button[aria-controls=activity]");
      await button.focus();
      await button.press("Enter");
      await drawer.waitFor({ state: "visible" });
      assert.equal(await button.getAttribute("aria-expanded"), "true");
      assert.equal(
        await page.evaluate("document.activeElement?.id"),
        "activity",
        "focus moves into the drawer",
      );
      // the Log and its popups are there
      await page.waitForSelector("aside#activity .log li");

      // a dialog on top closes first
      await page.evaluate(
        `import("/dialog.js").then((m) => { m.ask({ title: "On top", confirmLabel: "OK" }); })`,
      );
      await page.waitForSelector(".modal.dialog");
      await page.keyboard.press("Escape");
      await page.waitForFunction(`!document.querySelector(".modal.dialog")`);
      assert.equal(await drawer.isVisible(), true, "the dialog took the Escape, not the drawer");
      await page.keyboard.press("Escape");
      await page.waitForFunction(`document.getElementById("activity").hidden`);
      assert.equal(
        await page.evaluate(`document.activeElement?.getAttribute("aria-controls")`),
        "activity",
        "focus returns to the Activity button",
      );

      // it overlays: the page does not get narrower, and it is closed again after a reload
      const width = await page.evaluate(
        `document.querySelector("main").getBoundingClientRect().width`,
      );
      await button.click();
      await drawer.waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(`document.querySelector("main").getBoundingClientRect().width`),
        width,
      );
      await page.reload();
      await page.waitForSelector(".ds-strip");
      assert.equal(await page.locator("aside#activity").isVisible(), false);
    } finally {
      await close();
    }
  },
);
