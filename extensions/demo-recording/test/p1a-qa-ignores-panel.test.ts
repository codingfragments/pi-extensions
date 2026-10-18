/** P1a PR 12 in the browser: Ignore… on a finding asks how far it goes and why, moves it to "Ignored by you", and Stop ignoring brings it back. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { qaFile } from "../src/qa/run.ts";
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

test(
  "Ignore… asks scope and reason; the finding moves to Ignored by you and comes back with Stop ignoring",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
    fs.writeFileSync(
      qaFile(seed.dir, 1),
      JSON.stringify({
        render: 1,
        stage: "render",
        version: 1,
        variant: "neutral",
        createdAt: new Date().toISOString(),
        whisper: true,
        items: [
          {
            id: "values-1",
            check: "values",
            level: "warning",
            high: true,
            scene: "01-dash",
            atMs: 2100,
            message: "the narration says 14.3: it isn't on screen",
            identity: { anchor: "m2", phrase: ["but", "emea", "is"], value: "14.3" },
          },
          {
            id: "media-2",
            check: "media",
            level: "warning",
            scene: "01-dash",
            atMs: 4000,
            message: "no narration for 4.6 s",
            identity: { kind: "pause", relMs: 1000 },
          },
          {
            id: "media-3",
            check: "media",
            level: "blocking",
            hard: "integrity",
            message: "the audio is silent",
          },
        ],
      }),
    );
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(`${panel.url}#/render/v1`);
      const qa = page.locator(".ds-inspector .ds-section", { hasText: "Quality check" });
      await qa.getByText("the narration says 14.3").waitFor();
      // a broken file has no Ignore button, the others do
      const row = (text: string) => qa.locator("li.qa-item", { hasText: text });
      assert.equal(await row("the audio is silent").locator("[data-act=ignore]").count(), 0);
      await row("the narration says 14.3").locator("[data-act=ignore]").click();

      const dlg = page.getByRole("dialog", { name: "Leave this alone?" });
      await dlg.waitFor();
      const text = await dlg.innerText();
      assert.match(text, /Only this finding/);
      assert.match(text, /narrated-value warnings in 01-dash/);
      assert.match(text, /narrated-value warnings in the whole project/);
      assert.equal(await dlg.getByRole("radio").count(), 3);
      assert.equal(
        await dlg.getByRole("button", { name: "Ignore" }).isDisabled(),
        true,
        "a reason is required",
      );
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-ignore-dialog.png` });
      await dlg.getByRole("radio").nth(1).check();
      await dlg.getByRole("textbox").fill("the forecast is meant");
      await dlg.getByRole("button", { name: "Ignore" }).click();
      await dlg.waitFor({ state: "detached" });

      // it left the list and the counts; it shows under Ignored by you with the reason
      await qa.getByText(/Ignored by you \(1 decision, 1 finding now\)/).waitFor();
      assert.equal(
        await qa.locator("li.qa-item", { hasText: "the narration says 14.3" }).count(),
        0,
        "out of the warnings",
      );
      await qa.locator("summary", { hasText: "Ignored by you" }).click();
      await qa.getByText("“the forecast is meant”").waitFor();
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-ignored.png` });

      // the popup lists it too; Stop ignoring brings it back
      await qa.getByRole("button", { name: "Stop ignoring" }).click();
      await qa.locator("li.qa-item", { hasText: "the narration says 14.3" }).waitFor();
      assert.equal(await qa.getByText(/Ignored by you/).count(), 0);
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
