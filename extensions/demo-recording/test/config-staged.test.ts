/**
 * Item 6 (D-R2-9) in the browser: with a project open a row edits THAT project's value ("Editing for <project>"),
 * edits are staged (nothing is written), one bar reviews all of them in one dialog with one diff per file, and
 * saves them all at once; leaving with staged edits asks.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { resolveConfig } from "../src/config.ts";
import {
  countWord,
  stageId,
  toBatch,
  withChange,
  without,
} from "../src/panel/public/config-stage-core.js";
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = (f: string) =>
  fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>) : {};
const row = (key: string) => `.ds-srow[data-key='${key}']`;
const bar = ".ds-cfg-stagebar";

async function setup(opts: { project?: boolean; width?: number } = {}) {
  const saved = {
    cfg: process.env.DEMO_REC_CONFIG,
    open: process.env.DEMO_REC_NO_OPEN,
    voice: process.env.DEMO_REC_VOICE,
  };
  const seed = seedPanelProject();
  const globalFile = path.join(seed.root, "global-config.json");
  fs.writeFileSync(
    globalFile,
    `${JSON.stringify({ fps: 30, voiceName: "Global_voice" }, null, 2)}\n`,
  );
  process.env.DEMO_REC_CONFIG = globalFile;
  process.env.DEMO_REC_NO_OPEN = "1";
  Reflect.deleteProperty(process.env, "DEMO_REC_VOICE");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.tellAgent = () => undefined;
  if (opts.project !== false) rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width: opts.width ?? 1400, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dlg = answerDialogs(page);
  const open = async (p: Page, hash: string) => {
    await p.goto(`${panel.url}${hash}`);
    await p.waitForSelector(".ds-srow");
  };
  return {
    page,
    open,
    dlg,
    errors,
    globalFile,
    projectFile: path.join(seed.dir, "config.json"),
    close: async () => {
      dlg.stop();
      await browser.close();
      await rt.shutdown();
      for (const [k, v] of [
        ["DEMO_REC_CONFIG", saved.cfg],
        ["DEMO_REC_NO_OPEN", saved.open],
        ["DEMO_REC_VOICE", saved.voice],
      ] as const) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
      fs.rmSync(seed.root, { recursive: true, force: true });
    },
  };
}

test(
  "a row edits the open project's value directly; the edit is staged, not written; discarding and putting the saved value back unstage it",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, globalFile, projectFile, close } = await setup();
    try {
      await open(page, "#/config?q=voiceName");
      const edit = page.locator(`${row("voiceName")} [data-act=edit-row]`);
      assert.equal(
        (await edit.innerText()).trim(),
        "Edit for keycraft",
        "the project is the default target",
      );
      assert.equal(await edit.getAttribute("data-scope"), "project");
      assert.equal(await page.locator(bar).count(), 0, "no bar while nothing is staged");
      await edit.click();
      assert.match(
        await page.locator(`${row("voiceName")} .ds-srow-edit label`).innerText(),
        /^Editing for keycraft/,
      );
      await page.fill("#edit-voiceName", "Project_voice");
      await page.click(`${row("voiceName")} [data-act=stage]`);
      // staged: the row says so, the bar counts it, no file moved
      assert.match(
        await page.locator(`${row("voiceName")} .ds-staged`).innerText(),
        /Staged\s*project: Project_voice/,
      );
      assert.match(await page.locator(bar).innerText(), /1 change staged/);
      assert.equal(readJson(projectFile).voiceName, undefined);
      assert.equal(readJson(globalFile).voiceName, "Global_voice");
      assert.equal(await page.locator(row("voiceName")).getAttribute("data-staged"), "true");
      // discard
      await page.click(`${row("voiceName")} [data-act=unstage]`);
      assert.equal(await page.locator(bar).count(), 0);
      // staging the saved value again is no change at all: it unstages
      await page.click(`${row("voiceName")} [data-act=edit-row]`);
      await page.fill("#edit-voiceName", "Project_voice");
      await page.click(`${row("voiceName")} [data-act=stage]`);
      await page.click(`${row("voiceName")} [data-act=edit-row]`);
      assert.equal(
        await page.inputValue("#edit-voiceName"),
        "Project_voice",
        "the editor opens on the staged value",
      );
      await page.fill("#edit-voiceName", "Global_voice");
      assert.equal(await page.locator(`${row("voiceName")} [data-act=stage]`).isDisabled(), false);
      await page.click(`${row("voiceName")} [data-act=cancel]`);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "several staged edits (both files, an override removed) are reviewed in ONE dialog with one diff per file and written together",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, dlg, errors, globalFile, projectFile, close } = await setup();
    try {
      fs.writeFileSync(projectFile, `${JSON.stringify({ voiceName: "Calm narrator" }, null, 2)}\n`);
      await open(page, "#/config");
      await page.fill(".config-search input[type=search]", "fps");
      await page.waitForSelector(row("fps"));
      // 1: fps for the project (the row's own button)
      await page.click(`${row("fps")} [data-act=edit-row]`);
      await page.fill("#edit-fps", "24");
      await page.click(`${row("fps")} [data-act=stage]`);
      // 2: the global value, one click away under Scopes
      await page.click(`${row("fps")} [data-toggle]`);
      await page.click(`${row("fps")} [data-act=edit-global]`);
      assert.match(
        await page.locator(`${row("fps")} .ds-srow-edit label`).innerText(),
        /^Editing the global value/,
      );
      await page.fill("#edit-fps", "25");
      await page.click(`${row("fps")} [data-act=stage]`);
      // 3: an override removed (in the project file)
      await page.fill(".config-search input[type=search]", "voiceName");
      await page.waitForSelector(row("voiceName"));
      await page.click(`${row("voiceName")} [data-toggle]`);
      await page.click(`${row("voiceName")} [data-act=remove-project]`);
      assert.match(await page.locator(bar).innerText(), /3 changes staged/);
      assert.match(
        await page.locator(bar).innerText(),
        /fps, voiceName/,
        "the bar names what is staged",
      );
      assert.equal(readJson(globalFile).fps, 30, "nothing written yet");
      // review once: cancel keeps everything staged and everything unwritten
      dlg.answer.accept = false;
      const seen = dlg.seen.length;
      await page.click(`${bar} [data-act=review]`);
      for (let i = 0; i < 100 && dlg.seen.length === seen; i++) await wait(50);
      dlg.answer.accept = true;
      const text = dlg.seen[seen] ?? "";
      assert.equal(dlg.seen.length, seen + 1, "ONE dialog for all three");
      assert.match(text, /Save 3 changes\?/);
      assert.match(text, /fps \(keycraft\): not set → 24/);
      assert.match(text, /fps \(global\): 30 → 25/);
      assert.match(text, /voiceName \(keycraft\): Calm narrator → removed/);
      assert.match(text, /── Global · [\s\S]*"fps": 25/);
      assert.match(text, /── Project keycraft · [\s\S]*"fps": 24/);
      assert.match(text, /-\s+"voiceName": "Calm narrator"/);
      assert.match(
        text,
        /fps: no effect right now, it is overridden by project/,
        "the global fps is shadowed by the project fps staged in the same batch",
      );
      assert.equal((text.match(/── /g) ?? []).length, 2, "one diff per file");
      assert.match(
        await page.locator(bar).innerText(),
        /3 changes staged/,
        "cancelled: still staged",
      );
      assert.equal(readJson(globalFile).fps, 30);
      // review again and save
      await page.click(`${bar} [data-act=review]`);
      await page.waitForSelector(bar, { state: "detached" });
      assert.equal(readJson(globalFile).fps, 25);
      const project = readJson(projectFile);
      assert.deepEqual([project.fps, project.voiceName], [24, undefined]);
      assert.equal(await page.locator(".ds-staged").count(), 0, "nothing stays staged");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "a refused change names its setting, writes nothing and keeps everything staged; a shadowed one says so in the review",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, dlg, errors, globalFile, projectFile, close } = await setup();
    try {
      fs.writeFileSync(projectFile, `${JSON.stringify({ voiceName: "Calm narrator" }, null, 2)}\n`);
      await open(page, "#/config?q=fps");
      await page.click(`${row("fps")} [data-act=edit-row]`);
      await page.fill("#edit-fps", "0");
      await page.click(`${row("fps")} [data-act=stage]`);
      await page.fill(".config-search input[type=search]", "voiceName");
      await page.waitForSelector(row("voiceName"));
      await page.click(`${row("voiceName")} [data-toggle]`);
      await page.click(`${row("voiceName")} [data-act=edit-global]`);
      await page.fill("#edit-voiceName", "Other_voice");
      await page.click(`${row("voiceName")} [data-act=stage]`);
      await page.click(`${bar} [data-act=review]`);
      await page.waitForSelector(".toast.error, .ds-toast[role=alert]");
      assert.match(
        await page.locator(".ds-toast[role=alert]").first().innerText(),
        /fps:/,
        "the error names the setting",
      );
      assert.equal(dlg.seen.length, 0, "no dialog: nothing to confirm");
      assert.match(await page.locator(bar).innerText(), /2 changes staged/);
      assert.equal(readJson(globalFile).voiceName, "Global_voice");
      // put the bad one right: discard it, then the shadowed global edit alone is reviewed and says it has no effect now
      await page.fill(".config-search input[type=search]", "fps");
      await page.waitForSelector(row("fps"));
      await page.click(`${row("fps")} [data-act=unstage]`);
      await page.click(`${bar} [data-act=review]`);
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await wait(50);
      assert.match(
        dlg.seen[0] ?? "",
        /voiceName: no effect right now, it is overridden by project/,
      );
      await page.waitForSelector(bar, { state: "detached" });
      assert.equal(readJson(globalFile).voiceName, "Other_voice", "stored, though shadowed");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "leaving Config with staged edits asks (Stay keeps them, Leave drops them); the Brands tab keeps them; Discard all asks",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, dlg, errors, globalFile, close } = await setup();
    try {
      await open(page, "#/config?q=fps");
      await page.click(`${row("fps")} [data-act=edit-row]`);
      await page.fill("#edit-fps", "24");
      await page.click(`${row("fps")} [data-act=stage]`);
      // the Brands tab is inside Config: the staged edit is still there on return
      await page.click("[role=tab]:has-text('Brands')");
      await page.waitForSelector("[role=tab][aria-selected=true]:has-text('Brands')");
      await page.click("[role=tab]:has-text('Settings')");
      await page.waitForSelector(bar);
      // a link to another screen: asked; Stay
      dlg.answer.accept = false;
      await page.click("nav.steps a[data-tab=voice]");
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await wait(50);
      assert.match(dlg.seen[0] ?? "", /Leave Config with 1 change not saved\?/);
      assert.match(await page.evaluate("location.hash"), /^#\/config/, "Stay: still on Config");
      assert.equal(await page.locator(bar).count(), 1, "Stay: still staged");
      // Leave
      dlg.answer.accept = true;
      await page.click("nav.steps a[data-tab=voice]");
      await page.waitForFunction("location.hash.startsWith('#/voice')");
      assert.equal(readJson(globalFile).fps, 30, "dropped, never written");
      await page.click("a.ds-btn:has-text('Config')");
      await page.waitForSelector(".ds-srow");
      assert.equal(await page.locator(bar).count(), 0, "the staged edit was dropped by leaving");
      // a link to Config itself never asks
      await page.fill(".config-search input[type=search]", "fps");
      await page.waitForSelector(row("fps"));
      await page.click(`${row("fps")} [data-act=edit-row]`);
      await page.fill("#edit-fps", "20");
      await page.click(`${row("fps")} [data-act=stage]`);
      const n = dlg.seen.length;
      await page.click("a.ds-btn:has-text('Config')");
      await wait(300);
      assert.equal(dlg.seen.length, n, "links to the same screen do not ask");
      // Discard all asks, and then drops
      await page.click(`${bar} [data-act=discard-all]`);
      for (let i = 0; i < 100 && dlg.seen.length === n; i++) await wait(50);
      assert.match(dlg.seen[n] ?? "", /Discard 1 change\?/);
      await page.waitForSelector(bar, { state: "detached" });
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "without a project the row edits the global value ('Edit'); a global-only setting does too, with a project open",
  { skip, timeout: 90_000 },
  async () => {
    const none = await setup({ project: false });
    try {
      await none.open(none.page, "#/config?q=fps");
      const edit = none.page.locator(`${row("fps")} [data-act=edit-row]`);
      assert.equal((await edit.innerText()).trim(), "Edit");
      assert.equal(await edit.getAttribute("data-scope"), "global");
      await edit.click();
      assert.match(
        await none.page.locator(`${row("fps")} .ds-srow-edit label`).innerText(),
        /^Editing the global value/,
      );
      assert.deepEqual(none.errors, []);
    } finally {
      await none.close();
    }
    const withProject = await setup();
    try {
      await withProject.open(withProject.page, "#/config?q=root");
      const edit = withProject.page.locator(`${row("root")} [data-act=edit-row]`);
      assert.equal(
        await edit.getAttribute("data-scope"),
        "global",
        "root decides where projects live: global only",
      );
      assert.match((await edit.getAttribute("title")) ?? "", /Global only/);
    } finally {
      await withProject.close();
    }
  },
);

test("the staged list: one value per setting and scope (a newer replaces the older), removal by id, the batch body", () => {
  let list = withChange([], { key: "fps", scope: "global", value: 25 });
  list = withChange(list, { key: "fps", scope: "project", value: 24 });
  list = withChange(list, { key: "voiceName", scope: "project", unset: true });
  list = withChange(list, { key: "fps", scope: "global", value: 26 });
  assert.deepEqual(
    list.map((x) => [x.id, x.value]),
    [
      [stageId("project", "fps"), 24],
      [stageId("project", "voiceName"), undefined],
      [stageId("global", "fps"), 26],
    ],
  );
  assert.deepEqual(toBatch(list), [
    { key: "fps", scope: "project", value: 24 },
    { key: "voiceName", scope: "project", unset: true },
    { key: "fps", scope: "global", value: 26 },
  ]);
  assert.equal(without(list, stageId("project", "fps")).length, 2);
  assert.deepEqual([countWord(1), countWord(2)], ["1 change", "2 changes"]);
});
