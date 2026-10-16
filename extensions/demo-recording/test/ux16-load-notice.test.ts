/**
 * UX16: when a part of the panel cannot load (a content blocker, a bad cache, a broken file) the page says so in plain
 * words with what to try, instead of staying blank. A normal start shows nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
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

test("a failed file, a broken script and a normal start", { skip, timeout: 90_000 }, async () => {
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
  try {
    // 1. a normal start: the panel comes up, nothing is said
    const ok = await browser.newPage();
    await ok.goto(`${panel.url}#/project`);
    await ok.waitForSelector("header.top");
    assert.equal(await ok.evaluate("window.__panelUp"), true);
    assert.equal(await ok.locator("#boot-notice").count(), 0);
    await ok.close();

    // 2. a file blocked (what a content blocker does): the notice names the script that failed and says what to try
    const blocked = await browser.newPage();
    await blocked.route("**/keys.js", (r) => r.abort("blockedbyclient"));
    await blocked.goto(`${panel.url}#/project`);
    await blocked.waitForSelector("#boot-notice");
    const text = await blocked.locator("#boot-notice").innerText();
    assert.match(text, /could not load part of itself/);
    assert.match(text, /or a file it loads did not[\s\S]*app\.js/);
    assert.match(text, /content blockers/);
    assert.equal(await blocked.locator("#boot-notice button").count(), 2);
    assert.equal(await blocked.getByRole("button", { name: "Reload" }).count(), 1);
    assert.equal(await blocked.getByRole("alert").count(), 1, "announced to a screen reader");
    assert.equal(await blocked.evaluate("window.__panelUp"), false);
    await blocked.close();

    // 3. a stylesheet blocked: the notice still shows (it does not depend on the styles)
    const noCss = await browser.newPage();
    await noCss.route("**/ds/screens.css", (r) => r.abort("blockedbyclient"));
    await noCss.goto(`${panel.url}#/project`);
    await noCss.waitForSelector("#boot-notice");
    assert.match(await noCss.locator("#boot-notice").innerText(), /screens\.css/);
    await noCss.close();

    // 4. a broken script: said too, with the error
    const broken = await browser.newPage();
    await broken.route("**/keys.js", (r) =>
      r.fulfill({ status: 200, contentType: "text/javascript", body: "export const = ;" }),
    );
    await broken.goto(`${panel.url}#/project`);
    await broken.waitForSelector("#boot-notice");
    assert.match(
      await broken.locator("#boot-notice").innerText(),
      /failed while starting|did not load/,
    );
    await broken.close();
  } finally {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
