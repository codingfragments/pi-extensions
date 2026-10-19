/**
 * UX5b in the browser (D100, D115, D121): the Voice over screen as a section list and one inspector, with a
 * working draft for the narration. Autosave and its states, reload, a failed save, a conflict from another
 * tab, a draft whose base moved, Save new version, Discard, and review kept apart from editing. Runs on the
 * seeded project (voice-over v1 approved, v2 a newer draft version; sections _intro, 01-dash, _outro).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { resolveConfig } from "../src/config.ts";
import { readDraft, saveDraft } from "../src/drafts/store.ts";
import { Runtime } from "../src/runtime.ts";
import { voVersions } from "../src/vo/store.ts";
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
  const notes: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = (t) => notes.push(t);
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dlg = answerDialogs(page);
  const open = async (p: Page, hash = "#/voice") => {
    await p.goto(`${panel.url}${hash}`);
    await p.waitForSelector(
      ".ds-split-detail textarea#narration-2-_intro, .ds-split-detail textarea[id^=narration]",
    );
  };
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, rt, panel, page, browser, dlg, errors, turns, notes, open, close };
}
const state = (p: Page) => p.locator(".ds-actionbar .ds-savestate").innerText();
const field = (p: Page) => p.locator(".ds-split-detail textarea[id^=narration]");
const until = (p: Page, text: RegExp) =>
  p.waitForFunction(
    `new RegExp(${JSON.stringify(text.source)}, ${JSON.stringify(text.flags)}).test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
  );

test(
  "list and inspector: sections as rows, the selection in the address, narrow width uses the select",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page);
      const keys = await page.evaluate(
        "[...document.querySelectorAll('.ds-split-list .ds-item')].map((e) => e.dataset.key)",
      );
      assert.deepEqual(keys, ["_intro", "01-dash", "_outro"]);
      assert.equal(
        await page.locator(".ds-item[aria-current=true]").getAttribute("data-key"),
        "_intro",
        "the first section is open",
      );
      await page.click(".ds-item[data-key='01-dash']");
      await page.waitForSelector(".ds-inspector h2:has-text('01-dash')");
      assert.match(await page.evaluate("location.hash"), /^#\/voice\?section=01-dash$/);
      assert.match(await field(page).inputValue(), /Headline churn reads 4\.2 percent/);
      // reload keeps the selection; Back leaves the screen instead of stepping through sections
      await page.reload();
      await page.waitForSelector(".ds-inspector h2:has-text('01-dash')");
      // the inspector is keyed to the section: another section shows its own text
      await page.click(".ds-item[data-key='_outro']");
      assert.equal(await field(page).inputValue(), "Two questions, one answer.");
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.waitForSelector(".ds-split-bar select");
      assert.equal(
        await page.locator(".ds-split-list").isVisible(),
        false,
        "narrow: the list folds into a select",
      );
      await page.selectOption(".ds-split-bar select", "_intro");
      await page.waitForSelector(".ds-inspector h2:has-text('_intro')");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "editing keeps a working draft: states, no version, reload restores it, Save new version makes exactly one",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, seed, turns, notes, errors, close } = await setup();
    try {
      await open(page);
      assert.match(
        await state(page),
        /No edits yet\. Editing keeps a working draft; it is not a new version/,
      );
      assert.equal(
        await page.locator("[data-act=save-version]").getAttribute("aria-disabled"),
        "true",
      );
      assert.match(await page.locator("#why-save").innerText(), /nothing to save/);
      await field(page).fill("A brand new opening line.");
      assert.match(await state(page), /Unsaved changes|Saving|Draft saved/);
      await until(page, /Draft saved .* not a new version yet/);
      assert.equal(readDraft(seed.dir, "vo", 2)?.edits._intro, "A brand new opening line.");
      assert.deepEqual(voVersions(seed.dir), [1, 2], "autosave never makes a version");
      assert.match(await page.locator(".ds-item[data-key=_intro]").innerText(), /Edited/);
      assert.match(await page.locator(".ds-split-list .ds-list-head").innerText(), /1 edited/);
      // reload: the draft comes back from the project
      await page.reload();
      await page.waitForSelector("textarea[id^=narration]");
      assert.equal(await field(page).inputValue(), "A brand new opening line.");
      assert.match(await state(page), /Working draft: 1 section changed/);
      // reverting the section to its text removes the edit
      await page.click("[data-act=revert]");
      await until(page, /Draft saved/);
      assert.deepEqual(readDraft(seed.dir, "vo", 2)?.edits, {});
      await field(page).fill("A brand new opening line.");
      await until(page, /Draft saved/);
      // Save new version: one version, the draft is gone, the screen shows the new latest
      await page.click("[data-act=save-version]");
      await page.waitForFunction(
        "document.body.innerText.includes('Viewing') && /v3/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
      );
      assert.deepEqual(voVersions(seed.dir), [1, 2, 3]);
      assert.equal(readDraft(seed.dir, "vo", 2), undefined);
      assert.match(
        fs.readFileSync(path.join(seed.dir, "vo", "script.v3.md"), "utf8"),
        /A brand new opening line\./,
      );
      assert.deepEqual(
        [turns, notes],
        [[], []],
        "editing and saving a version tell the Director nothing by themselves",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "a failed save keeps your text and says so; Retry saves it",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, seed, errors, close } = await setup();
    try {
      await open(page);
      await page.route("**/api/draft-save", (r) => r.abort("failed"));
      await field(page).fill("Text that cannot be saved yet.");
      await page.waitForSelector(".ds-notice:has-text('Save failed')");
      assert.match(await state(page), /Save failed: .* Your text is kept here\./);
      assert.equal(
        await field(page).inputValue(),
        "Text that cannot be saved yet.",
        "the text is still there",
      );
      assert.equal(readDraft(seed.dir, "vo", 2), undefined, "nothing claims to be saved");
      assert.equal(
        await page.locator("[data-act=save-version]").getAttribute("aria-disabled"),
        null,
      );
      await page.unroute("**/api/draft-save");
      await page.click("[data-act=retry]");
      await until(page, /Draft saved/);
      assert.equal(readDraft(seed.dir, "vo", 2)?.edits._intro, "Text that cannot be saved yet.");
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
  "a conflict from another tab: nothing is overwritten; compare, keep mine, take theirs",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, seed, errors, close } = await setup();
    try {
      await open(page);
      await field(page).fill("Mine, first.");
      await until(page, /Draft saved/);
      // another tab writes the draft (revision 2) while this page still holds revision 1
      saveDraft(seed.dir, "vo", 2, {
        expected: 1,
        edits: { _outro: "Theirs." },
        author: "other-tab",
      });
      await field(page).fill("Mine, second.");
      await page.waitForSelector(".ds-notice:has-text('changed in another tab')");
      assert.match(await state(page), /changed elsewhere/);
      assert.equal(await field(page).inputValue(), "Mine, second.", "my edit is kept");
      assert.equal(
        readDraft(seed.dir, "vo", 2)?.edits._intro,
        "Mine, first.",
        "my second edit did not overwrite the draft",
      );
      assert.equal(readDraft(seed.dir, "vo", 2)?.edits._outro, "Theirs.");
      assert.equal(
        await page.locator("[data-act=save-version]").getAttribute("aria-disabled"),
        "true",
      );
      await page.click(".ds-notice button:has-text('Compare')");
      const compare = await page.locator(".ds-compare").innerText();
      assert.match(compare, /_intro[\s\S]*Mine, second\./);
      assert.match(compare, /_outro[\s\S]*Theirs\./);
      // Keep mine: my sections win and the sections only they had are dropped
      await page.click("[data-act=keep-mine]");
      await until(page, /Draft saved/);
      assert.deepEqual(Object.keys(readDraft(seed.dir, "vo", 2)?.edits ?? {}), ["_intro"]);
      assert.equal(readDraft(seed.dir, "vo", 2)?.edits._intro, "Mine, second.");
      // a second conflict, resolved the other way
      saveDraft(seed.dir, "vo", 2, {
        expected: readDraft(seed.dir, "vo", 2)?.revision ?? null,
        edits: { _outro: "Theirs again." },
        author: "other-tab",
      });
      await field(page).fill("Mine, third.");
      await page.waitForSelector("[data-act=take-theirs]");
      await page.click("[data-act=take-theirs]");
      await page.waitForFunction("!document.querySelector('[data-act=take-theirs]')");
      assert.equal(
        await field(page).inputValue(),
        "Mine, second.",
        "theirs replaced my unsaved text: the draft as it is on the server",
      );
      await page.click(".ds-item[data-key=_outro]");
      assert.equal(await field(page).inputValue(), "Theirs again.");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "another tab's save is adopted while nothing of mine is at stake",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, panel, errors, close } = await setup();
    try {
      await open(page);
      // a second tab, through the same routes: its saves publish the event this page listens to
      const token = new URL(panel.url).searchParams.get("token") as string;
      const other = (revision: number | null, edits: Record<string, string>) =>
        fetch(new URL("/api/draft-save", panel.url), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ stage: "vo", base: 2, revision, author: "other-tab", edits }),
        }).then((r) => r.json());
      await other(null, { _intro: "Written in another tab." });
      await page.waitForFunction(
        "document.querySelector('.ds-item[data-key=_intro]')?.innerText.includes('Edited')",
      );
      assert.equal(await field(page).inputValue(), "Written in another tab.");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "a draft whose base moved is flagged, never moved: Compare, Save as new version, Discard names the draft",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, seed, dlg, errors, close } = await setup();
    try {
      await open(page, "#/voice/v1");
      await field(page).fill("Edited on the older version.");
      await until(page, /Draft saved/);
      await page.reload();
      await page.waitForSelector(".ds-notice:has-text('built on v1, v2 exists')");
      assert.match(
        await page.locator(".ds-notice[data-tone=warn]").innerText(),
        /It stays on v1; nothing was moved or merged/,
      );
      await page.click("button:has-text('Compare with v2')");
      assert.match(
        await page.locator(".ds-compare").innerText(),
        /_intro[\s\S]*Edited on the older version\./,
      );
      assert.equal(readDraft(seed.dir, "vo", 1)?.base, 1, "the draft is still on v1");
      // Discard names what it drops, and can be cancelled
      dlg.answer.accept = false;
      await page.click("[data-act=discard]");
      // the dialog opens, is answered (cancel) and closes: wait for that, not for a fixed time
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(dlg.seen.length, "the discard dialog appeared");
      await page.waitForSelector(".modal-backdrop", { state: "detached" });
      assert.match(
        dlg.seen.at(-1) ?? "",
        /Discard the working draft of v1\?[\s\S]*edits of _intro[\s\S]*saved version is not changed/,
      );
      assert.equal(
        readDraft(seed.dir, "vo", 1)?.edits._intro,
        "Edited on the older version.",
        "cancelled: nothing was lost",
      );
      // Save as new version from the note: exactly one version, built from v1
      await page.click("[data-act=save-as-new]");
      await page.waitForFunction(
        "/v3/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
      );
      assert.deepEqual(voVersions(seed.dir), [1, 2, 3]);
      assert.match(
        fs.readFileSync(path.join(seed.dir, "vo", "script.v3.md"), "utf8"),
        /Edited on the older version\./,
      );
      assert.equal(readDraft(seed.dir, "vo", 1), undefined);
      // and Discard when confirmed
      await open(page, "#/voice/v2");
      await field(page).fill("Throwaway.");
      await until(page, /Draft saved/);
      dlg.answer.accept = true;
      await page.click("[data-act=discard]");
      await page.waitForFunction("!document.querySelector('[data-act=discard]')");
      assert.equal(readDraft(seed.dir, "vo", 2), undefined);
      assert.equal(
        await field(page)
          .inputValue()
          .then((v) => /Throwaway/.test(v)),
        false,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "review and editing are separate acts: marking never edits, editing never marks, the old edit route is not used",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, seed, errors, close } = await setup();
    try {
      const posts: string[] = [];
      page.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
      await open(page);
      await field(page).fill("Edited but not reviewed.");
      await until(page, /Draft saved/);
      assert.match(
        await page.locator(".ds-item[data-key=_intro]").innerText(),
        /not reviewed/,
        "editing does not mark the section",
      );
      await page.click("[data-status=approved]");
      await page.waitForFunction(
        "/· Reviewed/.test(document.querySelector('.ds-item[data-key=_intro]')?.innerText ?? '')",
      );
      // the decision is a state now: highlighted with a Revoke, the other two still available, and a badge in the header
      assert.equal(await page.locator("[data-state=approved]").count(), 1);
      assert.equal(
        await page.locator("[data-status=approved]").count(),
        0,
        "the chosen action is the state",
      );
      assert.equal(await page.locator("[data-act=revoke]").count(), 1);
      assert.equal(await page.locator("[data-status=changes], [data-status=rerun]").count(), 2);
      assert.match(await page.locator("[data-review-badge=approved]").innerText(), /Reviewed/);
      assert.equal(
        readDraft(seed.dir, "vo", 2)?.edits._intro,
        "Edited but not reviewed.",
        "marking left the draft alone",
      );
      assert.deepEqual(voVersions(seed.dir), [1, 2]);
      assert.equal(posts.includes("/api/vo-edit"), false);
      assert.ok(posts.includes("/api/draft-save") && posts.includes("/api/review"));
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
