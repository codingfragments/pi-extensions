/** P1a PR 3: "The Director asks" in the panel: Allow and Not now answer what the Director wanted to spend. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { askFirst } from "../src/tools/spend.ts";
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

test("Allow and Not now answer the Director's request", { skip, timeout: 90_000 }, async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  process.env.DEMO_REC_CONFIG = cfg;
  const told: string[] = [];
  const rt = new Runtime(
    () => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }),
    { sendUserMessage: (t) => told.push(t), sendMessage: (m) => told.push(m.content) },
  );
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${panel.url}#/voice`);
    await page.waitForSelector("header.top");
    assert.equal(await page.locator(".asks").count(), 0, "nothing asked: nothing shown");

    askFirst(rt, "tts", "vo:1", "synthesize voice-over v1 (about 1,231 characters)");
    await page.waitForSelector(".asks .ds-notice");
    assert.match(
      await page.locator(".asks").innerText(),
      /The Director asks to synthesize voice-over v1 .*It waits for you\. Or type\s+\/demo allow [0-9a-f]+\s+in chat/s,
    );
    assert.equal(await page.getByRole("alert").filter({ hasText: "The Director asks" }).count(), 1);
    if (process.env.P1A_SHOTS) await page.screenshot({ path: `${process.env.P1A_SHOTS}-asks.png` });

    await page.getByRole("button", { name: "Allow" }).click();
    await page.waitForSelector(".asks", { state: "detached" });
    assert.equal(rt.grants.has("tts", seed.slug, "vo:1"), true, "Allow is the grant");
    assert.match(told.at(-1) ?? "", /ALLOWED: synthesize voice-over v1/);

    askFirst(rt, "take", "storyboard:1", "record a new take of storyboard v1");
    await page.waitForSelector(".asks .ds-notice");
    await page.getByRole("button", { name: "Not now" }).click();
    await page.waitForSelector(".asks", { state: "detached" });
    assert.equal(rt.grants.has("take", seed.slug, "storyboard:1"), false);
    assert.match(told.at(-1) ?? "", /did NOT allow/);

    // an automatic start announces itself: the Activity drawer shows it before its first step (run-and-tell)
    rt.bus.publish(
      "design.announced",
      {
        trigger: "auto",
        message:
          "🎨 started by itself after the voice step: the annotation designer (a/one, about 900 tokens in, one call).",
      },
      seed.slug,
    );
    await page.getByRole("button", { name: /Activity/ }).click();
    await page
      .getByText(/started by itself after the voice step/)
      .first()
      .waitFor();
    assert.match(await page.locator(".prow.running").innerText(), /Annotation designer/);
    await page.close();
  } finally {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
