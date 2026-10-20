/**
 * Item 12a (F28): the "Logo bug" checkbox of New render says what it does. A brand shows the logo bug only when it has it turned on AND a logo
 * file; otherwise the checkbox has nothing to do, so it is disabled and says why (and where to change it).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { logoBugStatus } from "../src/brand/assets.ts";
import { resolveBrand } from "../src/brand/brand.ts";
import { createBrand } from "../src/brand/manage.ts";
import { resolveConfig } from "../src/config.ts";
import { logoBugNote } from "../src/panel/public/logo-bug-core.js";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

function makeBrands(root: string) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "logo-src-"));
  fs.writeFileSync(
    path.join(src, "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#fff"/></svg>',
  );
  createBrand(root, {
    name: "acme",
    source: src,
    logoLight: "logo.svg",
    settings: { logoBug: { enabled: true, position: "bottom-left" } },
  });
  createBrand(root, { name: "quiet", source: src, logoLight: "logo.svg" });
  createBrand(root, { name: "nofile", settings: { logoBug: { enabled: true } } });
  fs.rmSync(src, { recursive: true, force: true });
}

test("a brand shows the logo bug only with it turned on AND a logo file", () => {
  const seed = seedPanelProject();
  try {
    makeBrands(seed.root);
    assert.deepEqual(logoBugStatus(resolveBrand(seed.root, "acme")), {
      state: "shows",
      position: "bottom-left",
    });
    assert.deepEqual(logoBugStatus(resolveBrand(seed.root, "quiet")), { state: "off" });
    assert.deepEqual(logoBugStatus(resolveBrand(seed.root, "nofile")), { state: "no-logo" });
    assert.equal(
      logoBugStatus(resolveBrand(seed.root, "neutral")).state,
      "off",
      "the built-in neutral brand has none",
    );
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the note: what the option does for the chosen brands, in words", () => {
  const brands = [
    { name: "acme", logoBug: { state: "shows" as const, position: "bottom-left" } },
    { name: "quiet", logoBug: { state: "off" as const } },
    { name: "nofile", logoBug: { state: "no-logo" as const } },
  ];
  assert.deepEqual(logoBugNote(brands, []), {
    disabled: true,
    text: "Choose a look first: the logo bug belongs to the brand.",
  });
  const none = logoBugNote(brands, ["quiet"]);
  assert.equal(none.disabled, true);
  assert.match(
    none.text,
    /^Nothing to show: quiet has it turned off\. The logo bug is a small logo in a corner of the full video; the brand decides if there is one\.$/,
  );
  assert.equal(none.fix, true);
  assert.match(
    logoBugNote(brands, ["quiet", "nofile"]).text,
    /quiet has it turned off; nofile has it turned on but no logo file/,
  );
  const some = logoBugNote(brands, ["acme"]);
  assert.deepEqual([some.disabled, some.fix], [false, false]);
  assert.equal(
    some.text,
    "Puts the brand's logo in the bottom left corner of the full video (acme).",
  );
  const mixed = logoBugNote(brands, ["acme", "quiet"]);
  assert.deepEqual([mixed.disabled, mixed.fix], [false, true]);
  assert.equal(
    mixed.text,
    "Puts the brand's logo in the bottom left corner of the full video (acme). Not shown for quiet (turned off).",
  );
  assert.equal(
    logoBugNote([{ name: "old" }], ["old"]).disabled,
    true,
    "a brand without the field (an older engine) shows nothing",
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
  "in the browser: the checkbox is disabled with the reason for a brand that shows nothing, enabled for one that does, and the render still starts",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    makeBrands(seed.root);
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
      const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const posts: Record<string, unknown>[] = [];
      await page.route("**/api/render", async (r) => {
        posts.push(JSON.parse(r.request().postData() ?? "{}"));
        await r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      await page.goto(`${panel.url}#/render`);
      await page.waitForSelector(".ds-runs .ds-run");
      await page.click("[data-act=new-render]");
      await page.waitForSelector("#new-render [data-act=render-now]");
      await page.click(".render-change > summary");
      const box = page.getByRole("checkbox", { name: "Logo bug" });
      const note = page.locator("#logo-bug-note");
      // the default look (neutral) has no logo bug: disabled, unchecked, with the reason and the way to change it
      assert.equal(await box.isDisabled(), true);
      assert.equal(await box.isChecked(), false);
      assert.match(await note.innerText(), /Nothing to show: neutral has it turned off\./);
      assert.equal(await page.locator("#logo-bug-note a[href='#/config?view=brands']").count(), 1);
      assert.equal(await note.getAttribute("data-logo-bug"), "off");
      // the checkbox is described by the note (a screen reader reads why)
      assert.equal(await box.getAttribute("aria-describedby"), "logo-bug-note");
      // tick acme as well: now it can show
      await page.getByRole("checkbox", { name: "acme" }).check();
      assert.equal(await box.isDisabled(), false);
      assert.equal(await box.isChecked(), true, "on by default, as before");
      assert.match(
        await note.innerText(),
        /Puts the brand's logo in the bottom left corner of the full video \(acme\)\. Not shown for neutral \(turned off\)\./,
      );
      await box.uncheck();
      await page.click("[data-act=render-now]");
      for (let i = 0; i < 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(
        (posts[0]?.options as { logoBug: boolean }).logoBug,
        false,
        "an explicit choice is sent",
      );
      assert.deepEqual(posts[0]?.brands, ["neutral", "acme"]);
      // only a brand that shows nothing: the option is not "no logo": the default is sent
      posts.length = 0;
      await page.getByRole("checkbox", { name: "acme" }).uncheck();
      assert.equal(await box.isDisabled(), true);
      await page.click("[data-act=render-now]");
      for (let i = 0; i < 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        (posts[0]?.options as { logoBug: boolean }).logoBug,
        true,
        "nothing to show: the default, so the variant name does not say 'no logo'",
      );
      // the two brands that show nothing for different reasons
      await page.getByRole("checkbox", { name: "nofile" }).check();
      await page.getByRole("checkbox", { name: "neutral" }).uncheck();
      assert.match(
        await note.innerText(),
        /Nothing to show: nofile has it turned on but no logo file\./,
      );
      await page.getByRole("checkbox", { name: "nofile" }).uncheck();
      assert.match(await note.innerText(), /Choose a look first/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
