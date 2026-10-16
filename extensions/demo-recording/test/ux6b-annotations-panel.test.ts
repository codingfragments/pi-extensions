/**
 * UX6b in the browser (D100, D115, D122): the Annotations screen as a list grouped by scene and one
 * inspector. Direct switches in the rows and their save states, a failed save, a conflict from another tab,
 * the privacy confirmation, Reset to suggested, Save new version and Discard, a draft whose base moved, and
 * filters. Runs on the seeded project (annotations v1 approved: zoom-kpi, hl-row, co-kpi on; ch-dash,
 * sp-row, rd-mail off). Previews are stubbed: rendering stills is covered by the preview tests.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { readAnnotations, writeAnnotations } from "../src/annotations/file.ts";
import { resolveConfig } from "../src/config.ts";
import { editAnnotationDraft, readAnnotationDraft } from "../src/drafts/annotations.ts";
import { Runtime } from "../src/runtime.ts";
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

async function setup(width = 1400) {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
    root: seed.root,
    panelPort: 0,
  }));
  const turns: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/annotation-preview", (r) =>
    r.fulfill({
      status: 400,
      contentType: "application/json",
      body: '{"error":"previews are stubbed in this test"}',
    }),
  );
  const dlg = answerDialogs(page);
  const open = async (p: Page, hash = "#/annotations") => {
    await p.goto(`${panel.url}${hash}`);
    await p.waitForSelector(".ds-split-list .ds-item");
  };
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, page, open, dlg, turns, errors, close };
}
const state = (p: Page) => p.locator(".ds-actionbar .ds-savestate").innerText();
const until = (p: Page, text: RegExp) =>
  p.waitForFunction(
    `new RegExp(${JSON.stringify(text.source)}, ${JSON.stringify(text.flags)}).test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
  );
const sw = (id: string) => `button[data-act=row-enabled][data-id='${id}']`;
const row = (id: string) => `.ds-item[data-key='${id}']`;
const on = async (p: Page, id: string) =>
  (await p.locator(sw(id)).getAttribute("aria-checked")) === "true";

test(
  "list grouped by scene, the selection in the address, an inspector with text, timing and reasons",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page);
      assert.ok((await page.locator(".ds-list-group").count()) >= 1, "scene headers");
      assert.match(
        await page.locator(".ds-list-group").first().innerText(),
        /01-dash.*\d+\/\d+ on/i,
      );
      const keys = (await page.evaluate(
        "[...document.querySelectorAll('.ds-split-list .ds-item')].map((e) => e.dataset.key)",
      )) as string[];
      assert.deepEqual([...keys].sort(), [
        "ch-dash",
        "co-kpi",
        "hl-row",
        "rd-mail",
        "sp-row",
        "zoom-kpi",
      ]);
      assert.equal(await page.locator(".ds-item[aria-current=true]").count(), 1);
      await page.click(row("co-kpi"));
      await page.waitForSelector(".ds-inspector h2:has-text('Callout')");
      assert.match(await page.evaluate("location.hash"), /^#\/annotations\?item=co-kpi$/);
      assert.ok(await page.locator("#ann-text-co-kpi").inputValue());
      assert.match(
        await page.locator(".ds-inspector").innerText(),
        /When[\s\S]*Start[\s\S]*Length/,
      );
      await page.click(row("rd-mail"));
      await page.waitForSelector(".ds-inspector h2:has-text('Redact')");
      assert.match(
        await page.locator(".ds-inspector").innerText(),
        /A redaction lasts to the end of the scene/,
      );
      assert.equal(
        await page.locator("button:has-text('Length')").count(),
        0,
        "no length for a redaction",
      );
      await page.reload();
      await page.waitForSelector(".ds-inspector h2:has-text('Redact')");
      // narrow: the list is a select
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.waitForSelector(".ds-split-bar select");
      assert.equal(await page.locator(".ds-split-list").isVisible(), false);
      await page.selectOption(".ds-split-bar select", "zoom-kpi");
      await page.waitForSelector(".ds-inspector h2:has-text('Zoom')");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "a switch in a row edits the working draft: states, no version, reload keeps it, Reset to suggested undoes it",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, seed, turns, errors, close } = await setup();
    try {
      await open(page);
      assert.match(await state(page), /No edits yet/);
      assert.equal(
        await page.locator("[data-act=save-version]").getAttribute("aria-disabled"),
        "true",
      );
      const was = await on(page, "co-kpi");
      await page.click(sw("co-kpi"));
      await until(page, /Draft saved .* not a new version yet/);
      assert.equal(await on(page, "co-kpi"), !was);
      assert.equal(readAnnotationDraft(seed.dir, 1)?.changes, 1);
      assert.equal(
        readAnnotationDraft(seed.dir, 1)?.file.items.find((x) => x.id === "co-kpi")?.enabled,
        !was,
      );
      assert.equal(
        readAnnotations(seed.dir, 1)?.items.find((x) => x.id === "co-kpi")?.enabled,
        was,
        "the saved version is untouched",
      );
      assert.match(await page.locator(".stage-summary").innerText(), /Working draft/);
      // nudges and text go into the same draft
      await page.click(row("co-kpi"));
      await page.click(".ds-inspector button[title='0.5 s later']");
      await until(page, /Draft saved/);
      await page.fill("#ann-text-co-kpi", "A new callout text");
      await page.locator("#ann-text-co-kpi").blur();
      await until(page, /Draft saved/);
      await page.waitForFunction("true");
      assert.equal(
        readAnnotationDraft(seed.dir, 1)?.file.items.find((x) => x.id === "co-kpi")?.text,
        "A new callout text",
      );
      assert.ok((readAnnotationDraft(seed.dir, 1)?.changes ?? 0) >= 3);
      assert.match(await page.locator(".ds-item[data-key='co-kpi']").innerText(), /Yours/);
      // reload: the draft is still there
      await page.reload();
      await page.waitForSelector(".ds-inspector h2");
      assert.match(await state(page), /Working draft: \d+ changes?/);
      assert.equal(await page.locator("#ann-text-co-kpi").inputValue(), "A new callout text");
      // Reset to suggested: every change of that annotation undone
      await page.click("[data-act=reset]");
      await page.waitForFunction("!document.querySelector('[data-act=reset]')");
      const item = readAnnotationDraft(seed.dir, 1)?.file.items.find((x) => x.id === "co-kpi");
      assert.equal(item?.enabled, was);
      assert.equal(item?.edits, undefined);
      assert.deepEqual(turns, [], "nothing here tells the Director anything");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "a failed save keeps the change and says so; Retry saves it",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, seed, errors, close } = await setup();
    try {
      await open(page);
      const was = await on(page, "sp-row");
      await page.route("**/api/annotations-edit", (r) => r.abort("failed"));
      await page.click(sw("sp-row"));
      await page.waitForSelector(".ds-notice:has-text('Save failed')");
      assert.match(await state(page), /Save failed: .* Your last change is kept here/);
      assert.equal(readAnnotationDraft(seed.dir, 1), undefined, "nothing claims to be saved");
      await page.unroute("**/api/annotations-edit");
      await page.click("[data-act=retry]");
      await until(page, /Draft saved/);
      assert.equal(
        readAnnotationDraft(seed.dir, 1)?.file.items.find((x) => x.id === "sp-row")?.enabled,
        !was,
      );
      assert.equal(await page.locator(".ds-notice:has-text('Save failed')").count(), 0);
      assert.deepEqual(
        errors.filter((e) => !/Failed to fetch|NetworkError/.test(e)),
        [],
      );
    } finally {
      await close();
    }
  },
);

test(
  "a conflict from another tab: the server's draft is shown, nothing overwritten; apply my change again or keep theirs",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, seed, errors, close } = await setup();
    try {
      await open(page);
      await page.click(sw("ch-dash"));
      await until(page, /Draft saved/);
      // another tab changes the draft (revision 2) while this page still holds revision 1
      const rev = readAnnotationDraft(seed.dir, 1)?.revision ?? null;
      editAnnotationDraft(
        seed.dir,
        1,
        { op: "toggle", id: "sp-row" },
        { expected: rev, author: "other-tab" },
      );
      const spBefore = readAnnotationDraft(seed.dir, 1)?.file.items.find(
        (x) => x.id === "sp-row",
      )?.enabled;
      await page.click(sw("zoom-kpi"));
      await page.waitForSelector(".ds-notice:has-text('changed in another tab')");
      assert.match(await state(page), /changed elsewhere/);
      assert.equal(
        await page.locator("[data-act=save-version]").getAttribute("aria-disabled"),
        "true",
      );
      const draft = readAnnotationDraft(seed.dir, 1)?.file.items;
      assert.equal(
        draft?.find((x) => x.id === "zoom-kpi")?.enabled,
        true,
        "my rejected change was not written",
      );
      assert.equal(draft?.find((x) => x.id === "sp-row")?.enabled, spBefore, "theirs is intact");
      assert.equal(
        await on(page, "sp-row"),
        !!spBefore,
        "the list shows the draft as the server has it",
      );
      // apply my change again, on top of theirs
      await page.click("[data-act=reapply]");
      await until(page, /Draft saved/);
      const after = readAnnotationDraft(seed.dir, 1)?.file.items;
      assert.equal(after?.find((x) => x.id === "zoom-kpi")?.enabled, false);
      assert.equal(after?.find((x) => x.id === "sp-row")?.enabled, spBefore);
      // a second conflict, resolved the other way
      editAnnotationDraft(
        seed.dir,
        1,
        { op: "toggle", id: "hl-row" },
        { expected: readAnnotationDraft(seed.dir, 1)?.revision ?? null, author: "other-tab" },
      );
      await page.click(sw("co-kpi"));
      await page.waitForSelector("[data-act=keep-theirs]");
      const coBefore = readAnnotationDraft(seed.dir, 1)?.file.items.find(
        (x) => x.id === "co-kpi",
      )?.enabled;
      await page.click("[data-act=keep-theirs]");
      await page.waitForFunction("!document.querySelector('[data-act=keep-theirs]')");
      assert.equal(
        readAnnotationDraft(seed.dir, 1)?.file.items.find((x) => x.id === "co-kpi")?.enabled,
        coBefore,
        "my change was dropped",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "turning off a redaction asks first, once; turning it on does not",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, dlg, seed, errors, close } = await setup();
    try {
      await open(page);
      assert.equal(await on(page, "rd-mail"), false);
      await page.click(sw("rd-mail")); // on: no dialog
      await until(page, /Draft saved/);
      assert.equal(dlg.seen.length, 0);
      // off: asks; cancel keeps it on
      dlg.answer.accept = false;
      await page.click(sw("rd-mail"));
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(dlg.seen[0] ?? "", /Turn off this redaction\?[\s\S]*stays visible in the video/);
      await page.waitForSelector(".modal-backdrop", { state: "detached" });
      assert.equal(await on(page, "rd-mail"), true);
      assert.equal(
        readAnnotationDraft(seed.dir, 1)?.file.items.find((x) => x.id === "rd-mail")?.enabled,
        true,
      );
      // off, confirmed
      dlg.answer.accept = true;
      await page.click(sw("rd-mail"));
      await page.waitForFunction(
        `document.querySelector("${sw("rd-mail")}")?.getAttribute("aria-checked") === "false"`,
      );
      // on and off again: already confirmed for this redaction, no second dialog
      const seen = dlg.seen.length;
      await page.click(sw("rd-mail"));
      await page.waitForFunction(
        `document.querySelector("${sw("rd-mail")}")?.getAttribute("aria-checked") === "true"`,
      );
      await page.click(sw("rd-mail"));
      await page.waitForFunction(
        `document.querySelector("${sw("rd-mail")}")?.getAttribute("aria-checked") === "false"`,
      );
      assert.equal(dlg.seen.length, seen, "asked once per redaction");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "Save new version makes exactly one version; Discard names what it drops; another version's draft is kept",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, dlg, seed, errors, close } = await setup();
    try {
      await open(page);
      await page.click(sw("ch-dash"));
      await until(page, /Draft saved/);
      // Discard names the annotations it drops, and can be cancelled
      dlg.answer.accept = false;
      await page.click("[data-act=discard]");
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(
        dlg.seen[0] ?? "",
        /Discard the working draft of v1\?[\s\S]*1 change to ch-dash[\s\S]*saved version is not changed/,
      );
      await page.waitForSelector(".modal-backdrop", { state: "detached" });
      assert.equal(readAnnotationDraft(seed.dir, 1)?.changes, 1, "cancelled: nothing lost");
      // Save new version: one version, built from v1, the draft gone, the new version shown
      await page.click("[data-act=save-version]");
      await page.waitForFunction(
        "/v2/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
      );
      assert.equal(readAnnotations(seed.dir, 2)?.editedFrom, 1);
      assert.equal(readAnnotationDraft(seed.dir, 1), undefined);
      assert.equal(
        fs.existsSync(path.join(seed.dir, "annotations", "v3.json")),
        false,
        "exactly one version",
      );
      // a draft on v1 is not replaced by editing v2
      await page.goto(`${page.url().split("#")[0]}#/annotations/v1`);
      await page.waitForSelector(".ds-split-list .ds-item");
      await page.click(sw("sp-row"));
      await until(page, /Draft saved/);
      await page.goto(`${page.url().split("#")[0]}#/annotations/v2`);
      await page.waitForSelector(".ds-split-list .ds-item");
      await page.waitForSelector(".ds-notice:has-text('Other working drafts')");
      assert.match(
        await page.locator(".ds-notice:has-text('Other working drafts')").innerText(),
        /v1 \(1 change\)/,
      );
      await page.click(sw("hl-row"));
      await until(page, /Draft saved/);
      assert.deepEqual(
        [readAnnotationDraft(seed.dir, 1)?.changes, readAnnotationDraft(seed.dir, 2)?.changes],
        [1, 1],
        "each version keeps its own draft",
      );
      // the draft on v1 now sits under a newer version: flagged, with Compare
      await page.goto(`${page.url().split("#")[0]}#/annotations/v1`);
      await page.waitForSelector(".ds-notice:has-text('built on v1, v2 exists')");
      await page.click("button:has-text('Compare with v2')");
      assert.match(await page.locator(".ds-compare").innerText(), /sp-row/);
      assert.equal(readAnnotationDraft(seed.dir, 1)?.base, 1);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "filters by type and state; a version without a match says so",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page);
      const keys = () =>
        page.evaluate(
          "[...document.querySelectorAll('.ds-split-list .ds-item')].map((e) => e.dataset.key)",
        ) as Promise<string[]>;
      await page.click(".filters button:has-text('Callout')");
      assert.deepEqual(await keys(), ["co-kpi"]);
      await page.click(".filters button:has-text('Callout')");
      await page.click(".filters button:has-text('enabled')");
      const enabled = await keys();
      assert.ok(enabled.includes("co-kpi") && !enabled.includes("rd-mail"));
      await page.click(".filters button:has-text('Zoom')");
      await page.click(".filters button:has-text('Highlight')");
      await page.click(".filters button:has-text('suggested, off')");
      assert.match(
        await page.locator(".ds-split-list").innerText(),
        /No annotation matches the filters/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
