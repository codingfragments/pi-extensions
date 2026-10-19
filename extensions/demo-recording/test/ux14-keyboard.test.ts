/**
 * UX14 (D128): arrow keys, Home and End move between the items of a list (one tab stop per list, Enter opens the
 * item in focus), and "?" opens a sheet of the shortcuts that exist, never while typing or over a dialog.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { SHORTCUTS } from "../src/panel/public/shortcuts.js";
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
const skip = !browserType && "needs Playwright Chromium";

async function setup() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  process.env.DEMO_REC_CONFIG = cfg;
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  ).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const close = async () => {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { page, panel, errors, close };
}
const active = (p: { evaluate: (s: string) => Promise<unknown> }) =>
  p.evaluate(
    "document.activeElement?.dataset?.key ?? document.activeElement?.closest('.ds-item')?.dataset?.key ?? null",
  ) as Promise<string | null>;

test(
  "lists: one tab stop, arrows/Home/End move focus (not the selection), Enter opens, Tab leaves the list",
  { skip, timeout: 90_000 },
  async () => {
    const { page, panel, errors, close } = await setup();
    try {
      await page.goto(`${panel.url}#/render`);
      await page.waitForSelector(".ds-runs .ds-item");
      await page.click("[data-kind=drafts]");
      await page.waitForSelector(".ds-runs .ds-item[data-key='7']");
      await page.waitForTimeout(100);
      const stops = () =>
        page.evaluate(
          "[...document.querySelectorAll('.ds-runs .ds-item')].filter((e) => e.tabIndex === 0).length",
        );
      assert.equal(await stops(), 1, "the list is one tab stop");
      const keys = (await page.evaluate(
        "[...document.querySelectorAll('.ds-runs .ds-item')].map((e) => e.dataset.key)",
      )) as string[];
      assert.ok(keys.length >= 3);
      await page.focus(`.ds-runs .ds-item[data-key='${keys[0]}']`);
      const hash0 = await page.evaluate("location.hash");
      await page.keyboard.press("ArrowDown");
      assert.equal(await active(page), keys[1]);
      await page.keyboard.press("ArrowDown");
      assert.equal(await active(page), keys[2]);
      await page.keyboard.press("ArrowUp");
      assert.equal(await active(page), keys[1]);
      await page.keyboard.press("End");
      assert.equal(await active(page), keys.at(-1));
      await page.keyboard.press("ArrowDown");
      assert.equal(await active(page), keys.at(-1), "stops at the end, never wraps or leaves");
      await page.keyboard.press("Home");
      assert.equal(await active(page), keys[0]);
      assert.equal(
        await page.evaluate("location.hash"),
        hash0,
        "moving focus did not select anything",
      );
      assert.equal(await stops(), 1, "still one tab stop, now where the focus is");
      // Enter opens the item in focus
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForFunction(`location.hash.includes("/v${keys[1]}")`);
      // Tab leaves the list instead of walking its items
      await page.focus(`.ds-runs .ds-item[data-key='${keys[1]}']`);
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate("!!document.activeElement?.closest('.ds-runs .ds-list')"),
        false,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "the Versions list takes arrow keys too, and Escape still closes it",
  { skip, timeout: 90_000 },
  async () => {
    const { page, panel, errors, close } = await setup();
    try {
      await page.goto(`${panel.url}#/voice/v2`);
      await page.waitForSelector(".history-btn");
      await page.click(".history-btn");
      await page.waitForSelector(".ds-histpop .ds-version-main");
      const links = () =>
        page.evaluate(
          "[...document.querySelectorAll('.ds-histpop .ds-version-main')].map((e) => e.textContent.trim())",
        ) as Promise<string[]>;
      const [a, b] = await links();
      assert.deepEqual([a, b], ["v2", "v1"]);
      const now = () => page.evaluate("document.activeElement?.textContent?.trim()");
      assert.equal(await now(), "v2");
      await page.keyboard.press("ArrowDown");
      assert.equal(await now(), "v1");
      await page.keyboard.press("ArrowUp");
      assert.equal(await now(), "v2");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".ds-histpop").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "?: opens the sheet of shortcuts (header button too), lists what exists, never over a field or a dialog",
  { skip, timeout: 90_000 },
  async () => {
    const { page, panel, errors, close } = await setup();
    try {
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector("textarea[id^=narration]");
      // typing a question mark in a field is typing
      await page.focus("textarea[id^=narration]");
      await page.keyboard.type("why?");
      assert.equal(await page.locator(".modal.dialog").count(), 0, "no sheet while typing");
      await page.evaluate("document.activeElement.blur()");
      await page.keyboard.press("Shift+Slash");
      await page.waitForSelector(".modal.dialog");
      const text = await page.locator(".modal.dialog").innerText();
      assert.match(text, /Keyboard shortcuts/);
      for (const [keys, what] of SHORTCUTS) {
        assert.ok(text.includes(keys), `the sheet shows "${keys}"`);
        assert.ok(text.includes(what), `and what it does: ${what}`);
      }
      // one Close button, Escape closes, a second ? over the open sheet does nothing
      assert.equal(await page.locator(".modal.dialog .ds-dialog-foot button").count(), 1);
      await page.keyboard.press("Shift+Slash");
      assert.equal(await page.locator(".modal.dialog").count(), 1);
      await page.keyboard.press("Escape");
      await page.waitForSelector(".modal.dialog", { state: "detached" });
      // the header button does the same and focus comes back to it
      await page.click("[data-act=shortcuts]");
      await page.waitForSelector(".modal.dialog");
      await page.click(".modal.dialog [data-confirm]");
      await page.waitForSelector(".modal.dialog", { state: "detached" });
      assert.equal(await page.evaluate("document.activeElement?.dataset?.act"), "shortcuts");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test("every shortcut the sheet promises is handled somewhere in the panel", () => {
  const read = (f: string) =>
    fs.readFileSync(path.join(import.meta.dirname, "..", "src", "panel", "public", f), "utf8");
  assert.match(read("config.js"), /ctrlKey|metaKey/, "Ctrl/Cmd+K in Config");
  assert.match(read("config.js"), /"\/"/, "/ in Config");
  assert.match(read("map.js"), /ArrowRight|ArrowDown/, "arrows in the Map");
  assert.match(read("map.js"), /"\+", "=", "-", "_", "0"/, "zoom keys in the Map");
  assert.match(read("keys.js"), /ArrowDown[\s\S]*Home[\s\S]*End/, "arrows, Home and End in lists");
  assert.equal(SHORTCUTS.length, 11);
});
