/**
 * UX8 in the browser (D124): the Project screen opens on a summary of the brief in human terms, names what
 * is missing with a link to fix it, offers "Ask the Director to draft it" or "Fill it in myself" on a new
 * project, and shows one group at a time (in the address). Missing is orientation: nothing is blocked.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
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

async function setup(kind: "new" | "seeded", width = 1400) {
  process.env.DEMO_REC_NO_OPEN = "1";
  let root: string;
  let dir: string;
  let slug: string;
  if (kind === "seeded") {
    const s = seedPanelProject();
    ({ root, dir, slug } = s);
  } else {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ux8-panel-"));
    const p = ensureProject(root, { project: "demo", appName: "Demo", appUrl: "https://app.test" });
    dir = p.dir;
    slug = p.slug;
  }
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
    root,
    panelPort: 0,
  }));
  const turns: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = () => undefined;
  rt.setActiveProject(slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dlg = answerDialogs(page);
  const open = async (p: Page, hash = "#/project") => {
    await p.goto(`${panel.url}${hash}`);
    await p.waitForSelector(".project-summary");
  };
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { dir, page, open, turns, errors, close };
}
const rowText = (p: Page, key: string) => p.locator(`.ds-fact[data-row='${key}']`).innerText();
const focused = (p: Page) =>
  p.evaluate("document.activeElement?.closest('[data-fact]')?.dataset.fact ?? null");

test(
  "a new project opens on the summary: what is missing is named, nothing is open, two ways to start",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup("new");
    try {
      await open(page);
      assert.match(await rowText(page, "persona"), /Audience[\s\S]*Missing/);
      assert.match(await rowText(page, "goal"), /Goal[\s\S]*Missing/);
      assert.match(await rowText(page, "depth"), /Depth[\s\S]*Missing/);
      assert.match(
        await rowText(page, "length"),
        /Length[\s\S]*Not decided/,
        "length is not 'missing'",
      );
      assert.match(await rowText(page, "voice"), /Voice[\s\S]*Project default/);
      assert.match(await rowText(page, "url"), /https:\/\/app\.test/);
      assert.match(
        await page.locator(".project-summary .ds-notice").innerText(),
        /Next: describe the demo to the Director, or fill the brief in yourself/,
      );
      assert.equal(await page.locator(".fact-groups").count(), 0, "the form is closed");
      assert.equal(
        await page.locator(".subtabs .chip[aria-pressed=true]").count(),
        0,
        "no group is open",
      );
      assert.match(
        await page.locator(".subtabs").innerText(),
        /Brief[\s\S]*Sources & context[\s\S]*Findings[\s\S]*Project history/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "Ask the Director starts one agent turn and writes nothing; Fill it in myself opens the form on the first missing field",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, dir, turns, errors, close } = await setup("new");
    try {
      const brief = fs.readFileSync(path.join(dir, "brief.md"), "utf8");
      await open(page);
      assert.match(
        await page
          .locator("[data-act=ask-director] ~ .cost-hint, .project-summary .cost-hint")
          .first()
          .innerText(),
        /starts the Director/,
      );
      await page.click("[data-act=ask-director]");
      await page.waitForFunction("document.querySelector('[data-act=ask-director]')?.disabled");
      assert.equal(turns.length, 1);
      assert.match(turns[0] ?? "", /draft the brief for project "demo" with them/);
      assert.equal(
        fs.readFileSync(path.join(dir, "brief.md"), "utf8"),
        brief,
        "asking does not write the brief",
      );
      assert.match(await page.locator("[data-act=ask-director]").innerText(), /Asked the Director/);
      await page.click("[data-act=fill-myself]");
      await page.waitForSelector(".fact-groups");
      assert.match(await page.evaluate("location.hash"), /^#\/project\?group=brief&field=persona$/);
      assert.equal(
        await page.locator(".subtabs .chip[data-group=brief]").getAttribute("aria-pressed"),
        "true",
      );
      await page.waitForFunction(
        "document.activeElement?.closest('[data-fact]')?.dataset.fact === 'persona'",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "a fix link lands on its field; filling the essentials in turns the summary complete, and depth brings its length",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, errors, close } = await setup("new");
    try {
      await open(page);
      await page.click("[data-act=fix-goal]");
      await page.waitForSelector(".fact-groups");
      await page.waitForFunction(
        "document.activeElement?.closest('[data-fact]')?.dataset.fact === 'goal'",
      );
      await page.fill("[data-fact=goal] textarea", "Search, compare, act.");
      await page.fill("[data-fact=persona] textarea", "Product teams evaluating search");
      await page.locator(".segmented button", { hasText: "showcase" }).click();
      await page.getByRole("button", { name: "Save facts" }).click();
      await page.waitForFunction(
        "/saved as brief v/.test(document.querySelector('.facts .flash')?.innerText ?? '')",
      );
      // back to the summary: nothing is missing, the length says where it comes from
      await page.click(".subtabs .chip[data-group=brief]");
      await page.waitForSelector("[data-ready]");
      assert.match(await page.locator("[data-ready]").innerText(), /The brief is complete/);
      assert.match(await rowText(page, "persona"), /Product teams evaluating search/);
      assert.match(await rowText(page, "length"), /2–3 min[\s\S]*from depth showcase/);
      assert.equal(await page.locator(".project-summary .ds-badge:has-text('Missing')").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "one group at a time, in the address: Findings, Sources, History; the same chip closes it; a reload keeps it",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup("seeded");
    try {
      await open(page);
      assert.equal(await page.locator("[data-ready]").count(), 1, "the seeded brief is complete");
      await page.click(".subtabs .chip[data-group=findings]");
      await page.waitForSelector("li.finding, .card.muted");
      assert.equal(await page.evaluate("location.hash"), "#/project?group=findings");
      await page.click(".subtabs .chip[data-group=history]");
      await page.waitForSelector("ul.inputs li, .brief-text");
      assert.equal(await page.locator("li.finding").count(), 0, "only one group is open");
      assert.match(
        await page.locator(".card", { hasText: "Production line" }).first().innerText(),
        /Production line/,
      );
      await page.click(".subtabs .chip[data-group=sources]");
      await page.waitForSelector(".sources, .card:has-text('Sources & assets')");
      assert.equal(await page.locator("ul.inputs").count(), 0);
      await page.reload();
      await page.waitForSelector(".project-summary");
      assert.equal(
        await page.locator(".subtabs .chip[data-group=sources]").getAttribute("aria-pressed"),
        "true",
      );
      await page.click(".subtabs .chip[data-group=sources]");
      assert.equal(await page.evaluate("location.hash"), "#/project");
      assert.equal(await page.locator(".subtabs .chip[aria-pressed=true]").count(), 0);
      // narrow: the summary stacks, nothing overflows
      await page.setViewportSize({ width: 700, height: 1000 });
      const overflow = await page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth",
      );
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
