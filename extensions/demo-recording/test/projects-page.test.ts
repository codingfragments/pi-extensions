/**
 * Item 14 (E, D146): the Projects page in the browser. The list, switching, archive (with the result shown), and delete behind a dialog that waits for the
 * project's name; the way in from the header and from the Project page. Plus the pure words.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import {
  canTryWithoutDrafts,
  deleteText,
  sinceWords,
  sizeWords,
} from "../src/panel/public/projects-core.js";
import { SCREENS, parseRoute } from "../src/panel/public/route.js";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

test("the words: sizes, how long ago, what the delete dialog says, when the lean archive is offered", () => {
  assert.equal(sizeWords(0), "0 B");
  assert.equal(sizeWords(900), "900 B");
  assert.equal(sizeWords(2048), "2 KB");
  assert.equal(sizeWords(150 * 1024 * 1024), "150.0 MB");
  assert.equal(sizeWords(3.1 * 1024 ** 3), "3.1 GB");
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.equal(sinceWords("2026-10-21T11:59:30Z", now), "just now");
  assert.equal(sinceWords("2026-10-21T11:30:00Z", now), "30 min ago");
  assert.equal(sinceWords("2026-10-21T07:00:00Z", now), "5 h ago");
  assert.equal(sinceWords("2026-10-18T12:00:00Z", now), "3 days ago");
  assert.equal(sinceWords("2026-08-01T12:00:00Z", now), "2026-08-01");
  assert.equal(sinceWords("nonsense", now), "");
  const t = deleteText({ slug: "keycraft", bytes: 150 * 1024 * 1024, active: true });
  assert.match(
    t,
    /makes a zip of "keycraft" \(150\.0 MB on disk\), reads it back to check it, and only then removes the project's folder/,
  );
  assert.match(t, /saved login is not put into the zip/);
  assert.match(t, /This is the active project: there will be none until you open or create one\./);
  assert.doesNotMatch(deleteText({ slug: "x", bytes: 1, active: false }), /active project/);
  assert.equal(
    canTryWithoutDrafts(
      '"p" is 5.0 GiB, too big for one zip (the writer stops at 4 GiB): try again without the draft renders',
    ),
    true,
  );
  assert.equal(canTryWithoutDrafts("a tts job is running"), false);
  assert.ok(SCREENS.includes("projects"));
  assert.equal(parseRoute("#/projects")?.valid, true);
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
  "in the browser: the list, switch, archive, and delete that waits for the name",
  { skip: !browserType && "needs Playwright Chromium", timeout: 150_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    ensureProject(seed.root, {
      project: "second",
      appName: "Other app",
      appUrl: "https://other.example",
    });
    const entries: unknown[][] = [];
    const rt = new Runtime(
      () => ({
        ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
        root: seed.root,
        panelPort: 0,
      }),
      {
        sendUserMessage: () => undefined,
        sendMessage: () => undefined,
        appendEntry: (...a: unknown[]) => entries.push(a),
      } as never,
    );
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // the way in: the project's name in the header, and the Project page
      await page.goto(`${panel.url}#/project`);
      await page.waitForSelector("a.ds-brand-sub");
      assert.equal(await page.locator("a.ds-brand-sub").getAttribute("href"), "#/projects");
      assert.equal(await page.locator("[data-act=all-projects]").count(), 1);
      await page.click("a.ds-brand-sub");
      await page.waitForSelector("[data-projlist]");
      // the list: both projects, the active one marked and without "Switch to it"
      assert.deepEqual(
        await page
          .locator("[data-project]")
          .evaluateAll((els) =>
            els.map((e) => (e as unknown as { dataset: { project: string } }).dataset.project),
          ),
        ["keycraft", "second"],
      );
      const active = page.locator("[data-project=keycraft]");
      assert.match(await active.innerText(), /Active/);
      assert.equal(await active.locator("[data-act=switch]").count(), 0);
      assert.match(
        await page.locator("[data-project=second]").innerText(),
        /Other app · brief · [\d.]+ (KB|MB|B) · changed /,
      );
      // switch: the other one becomes active, the header says so, it is remembered
      await page.locator("[data-project=second] [data-act=switch]").click();
      await page.waitForSelector("[data-project=second][data-active=true]");
      assert.equal(rt.activeProjectSlug, "second");
      assert.equal(await page.locator("a.ds-brand-sub").innerText(), "second");
      assert.deepEqual(entries.at(-1), ["demo-recording.active", { project: "second" }]);
      // archive: a zip, the result under the list, the project stays
      await page.locator("[data-project=keycraft] [data-act=archive]").click();
      await page.waitForSelector("[data-last]");
      const said = await page.locator("[data-last]").innerText();
      assert.match(said, /Archived keycraft: \d+ files, [\d.]+ (KB|MB), read back and checked\./);
      assert.match(said, /archive\/keycraft-\d{8}-\d{6}\.zip/);
      assert.equal(
        fs.readdirSync(path.join(seed.root, "archive")).filter((f) => f.endsWith(".zip")).length,
        1,
      );
      assert.equal(
        await page.locator("[data-project=keycraft]").count(),
        1,
        "archiving keeps the project",
      );
      // delete: the button in the dialog waits for the exact name
      await page.locator("[data-project=keycraft] [data-act=delete]").click();
      await page.waitForSelector(".modal.dialog");
      const confirm = page.locator(".modal.dialog [data-confirm]");
      assert.equal(await confirm.isDisabled(), true, "nothing typed");
      assert.match(await page.locator(".modal.dialog").innerText(), /makes a zip of "keycraft"/);
      await page.fill(".modal.dialog input", "keycra");
      assert.equal(await confirm.isDisabled(), true, "a part of the name is not the name");
      assert.match(
        await page.locator(".modal.dialog .ds-field-error").innerText(),
        /Type keycraft exactly to continue\./,
      );
      await page.fill(".modal.dialog input", "keycraft");
      assert.equal(await confirm.isDisabled(), false);
      await page.keyboard.press("Escape"); // cancelling deletes nothing
      await page.waitForSelector(".modal.dialog", { state: "detached" });
      assert.equal(await page.locator("[data-project=keycraft]").count(), 1);
      await page.locator("[data-project=keycraft] [data-act=delete]").click();
      await page.fill(".modal.dialog input", "keycraft");
      await page.click(".modal.dialog [data-confirm]");
      await page.waitForSelector("[data-project=keycraft]", { state: "detached" });
      assert.match(await page.locator("[data-last]").innerText(), /Deleted keycraft: \d+ files/);
      assert.equal(fs.existsSync(seed.dir), false, "the folder is gone");
      assert.equal(
        fs.readdirSync(path.join(seed.root, "archive")).filter((f) => f.endsWith(".zip")).length,
        2,
        "the delete made its own zip",
      );
      assert.equal(
        rt.activeProjectSlug,
        "second",
        "deleting another project leaves the active one",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
