/**
 * Item 13a (R3-6, D146): the Voice over screen says what happens. The buttons are named for what they do ("Approve script v2", "Make the voice (uses
 * credits)"), and a short ordered list under them says where you are: approve (free), the voice (credits, Allow), the edit and a draft (by themselves),
 * the annotations (by themselves).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { voiceSteps } from "../src/panel/public/voice-steps-core.js";
import { nextAfterApproval } from "../src/panel/version-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

test("the steps: where you are is the first one not done; the follow-on steps are 'later' until it is their turn", () => {
  const states = (o: Parameters<typeof voiceSteps>[0]) =>
    voiceSteps(o).map((s) => `${s.key}:${s.state}`);
  assert.deepEqual(states({ approved: false, voiced: false }), [
    "approve:next",
    "voice:later",
    "edit:later",
    "annotations:later",
  ]);
  assert.deepEqual(states({ approved: true, voiced: false }), [
    "approve:done",
    "voice:next",
    "edit:later",
    "annotations:later",
  ]);
  assert.deepEqual(states({ approved: true, voiced: true }), [
    "approve:done",
    "voice:done",
    "edit:next",
    "annotations:later",
  ]);
  const s = voiceSteps({ approved: false, voiced: false });
  assert.match(s[1]?.detail ?? "", /uses voice credits: you see the cost and press Allow/);
  assert.match(s[0]?.detail ?? "", /free; the Director then asks to make the voice/);
  assert.match(s[3]?.detail ?? "", /by themselves, after the edit .*annotations\.autoSuggest/);
  assert.match(
    voiceSteps({ approved: true, voiced: true, autoSuggest: false })[3]?.detail ?? "",
    /you ask for them in the Annotations tab/,
  );
});

test("the toast after approving says the same, in the same words as the buttons", () => {
  const t = nextAfterApproval("vo");
  assert.match(
    t,
    /^Next: the Director asks to make the voice; the cost comes with the request and it waits for your Allow \(or press Make the voice yourself\)/,
  );
  assert.match(
    t,
    /sync edit and a draft to watch, and the annotations are suggested by themselves/,
  );
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
  "in the browser: Approve script, Make the voice, the steps list, and the cost dialog uses the same name",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector("[data-vosteps]");
      const list = page.locator("[data-vosteps] li");
      assert.equal(await list.count(), 4);
      assert.match(
        await page.locator("[data-vosteps]").innerText(),
        /Approve the script[\s\S]*Make the voice[\s\S]*The sync edit and a draft to watch[\s\S]*Annotations are suggested/,
      );
      // the first step not done is marked (aria-current) and the state is said in words for a screen reader
      assert.equal(await page.locator("[data-vosteps] li[aria-current=step]").count(), 1);
      assert.match(await page.locator("[data-vosteps] li").first().innerHTML(), /ds-sr-only/);
      // the approve button names what it approves; the old names are gone
      const buttons = await page.locator(".version-actions button").allInnerTexts();
      assert.ok(
        buttons.some((b) => /^Approve script v\d+$/.test(b.trim())),
        buttons.join(" | "),
      );
      assert.ok(!buttons.some((b) => /Approve & use/.test(b)), "no 'Approve & use' on Voice over");
      const body = await page.locator("main").innerText();
      assert.doesNotMatch(body, /Generate voice, edit and a draft/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
