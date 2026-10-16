/**
 * UX9a in the browser (D125): the Config settings with their layers side by side and a search. A search
 * highlights and collapses, quick filters combine, each layer has its own action and ends in the diff
 * dialog, the environment is read-only, the shortcuts stay out of editing and dialogs, and secrets are never
 * shown. The real config is never touched: DEMO_REC_CONFIG points at a temp file.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { resolveConfig } from "../src/config.ts";
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

const ENV_KEYS = [
  "DEMO_REC_CONFIG",
  "DEMO_REC_NO_OPEN",
  "DEMO_REC_TTS_CHAIN",
  "DEMO_REC_VOICE",
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
];

async function setup(
  opts: { project?: boolean; env?: Record<string, string>; width?: number } = {},
) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const seed = seedPanelProject();
  const globalFile = path.join(seed.root, "global-config.json");
  process.env.DEMO_REC_CONFIG = globalFile;
  process.env.DEMO_REC_NO_OPEN = "1";
  // a clean slate: only what a test asks for is in the environment (restored in close)
  for (const k of ENV_KEYS.filter((k) => !["DEMO_REC_CONFIG", "DEMO_REC_NO_OPEN"].includes(k)))
    Reflect.deleteProperty(process.env, k);
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.tellAgent = () => undefined;
  if (opts.project !== false) rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width: opts.width ?? 1400, height: 1200 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dlg = answerDialogs(page);
  const open = async (p: Page, hash = "#/config") => {
    await p.goto(`${panel.url}${hash}`);
    await p.waitForSelector(".ds-setting");
  };
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return {
    seed,
    globalFile,
    projectFile: path.join(seed.dir, "config.json"),
    page,
    open,
    dlg,
    errors,
    close,
  };
}
const keys = (p: Page) =>
  p.evaluate("[...document.querySelectorAll('.ds-setting')].map((e) => e.dataset.key)") as Promise<
    string[]
  >;
const card = (key: string) => `.ds-setting[data-key='${key}']`;
const count = (p: Page) => p.locator("[data-count]").innerText();
const readJson = (f: string) =>
  fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "search: highlights, collapses to the groups that match, one result per setting, in the address, cleared with Escape",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page);
      const all = await keys(page);
      assert.ok(all.length > 20, "all the settings");
      assert.equal(new Set(all).size, all.length, "one card per setting");
      const total = all.length;
      assert.match(await count(page), new RegExp(`^${total} settings$`));
      await page.fill(".config-search input[type=search]", "voice");
      await page.waitForFunction(`document.querySelectorAll(".ds-setting").length < ${total}`);
      const found = await keys(page);
      assert.ok(found.includes("voiceName"));
      assert.ok(found.length >= 1 && found.length < total);
      assert.match(await count(page), new RegExp(`^${found.length} of ${total} settings$`));
      assert.ok((await page.locator("mark.ds-hit").count()) >= 1, "matches are highlighted");
      assert.match(await page.evaluate("location.hash"), /^#\/config\?q=voice$/);
      assert.ok(
        (await page.locator(".setting-group h3").count()) < 8,
        "groups that do not match are gone",
      );
      // a reload keeps the search; Escape clears it and restores everything
      await page.reload();
      await page.waitForSelector(".ds-setting");
      assert.equal(await page.inputValue(".config-search input[type=search]"), "voice");
      await page.focus(".config-search input[type=search]");
      await page.keyboard.press("Escape");
      await page.waitForFunction(`document.querySelectorAll(".ds-setting").length === ${total}`);
      assert.equal(await page.evaluate("location.hash"), "#/config");
      // no match: told apart from loading, with a way out
      await page.fill(".config-search input[type=search]", "zzzz-nothing");
      await page.waitForSelector(".ds-state");
      assert.match(
        await page.locator(".ds-state").innerText(),
        /No setting matches[\s\S]*zzzz-nothing/i,
      );
      await page.click("[data-act=clear-search]");
      await page.waitForFunction(`document.querySelectorAll(".ds-setting").length === ${total}`);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "each layer has its own action and ends in the diff dialog: Edit global, Add override for this project, Remove override",
  { skip, timeout: 120_000 },
  async () => {
    const { page, open, dlg, globalFile, projectFile, errors, close } = await setup();
    try {
      await open(page, "#/config?q=voiceName");
      const c = card("voiceName");
      assert.equal(await page.locator(`${c} [data-layer=global]`).count(), 1);
      assert.equal(await page.locator(`${c} [data-layer=project]`).count(), 1);
      assert.match(
        await page.locator(`${c} [data-layer=project]`).innerText(),
        /Project override \(keycraft\)[\s\S]*Not set[\s\S]*Add override for this project/,
      );
      assert.equal(
        await page.locator(".segmented button:has-text('This project')").count(),
        0,
        "no page-level scope switch",
      );
      // Edit global: the editor opens in the global cell only
      await page.click(`${c} [data-act=edit-global]`);
      assert.equal(await page.locator(`${c} [data-layer=global] input`).count(), 1);
      assert.equal(await page.locator(`${c} [data-layer=project] input`).count(), 0);
      await page.fill(`${c} [data-layer=global] input`, "Global_voice");
      await page.click(`${c} [data-layer=global] [data-act=save]`);
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await wait(50);
      assert.match(dlg.seen[0] ?? "", /Set voiceName\?[\s\S]*Global[\s\S]*Global_voice/);
      for (let i = 0; i < 100 && readJson(globalFile)?.voiceName !== "Global_voice"; i++)
        await wait(50);
      assert.equal(readJson(globalFile)?.voiceName, "Global_voice");
      assert.equal(readJson(projectFile)?.voiceName, undefined, "the project file is untouched");
      // Add override for this project: the project file, not the global one
      await page.waitForSelector(`${c} [data-act=add-override]`);
      await page.click(`${c} [data-act=add-override]`);
      await page.fill(`${c} [data-layer=project] input`, "Project_voice");
      await page.click(`${c} [data-layer=project] [data-act=save]`);
      for (let i = 0; i < 100 && readJson(projectFile)?.voiceName !== "Project_voice"; i++)
        await wait(50);
      assert.equal(readJson(projectFile)?.voiceName, "Project_voice");
      assert.equal(
        readJson(globalFile)?.voiceName,
        "Global_voice",
        "global unchanged by the override",
      );
      await page.waitForFunction(
        `/Project override/.test(document.querySelector("${c} [data-effective]")?.innerText ?? "")`,
      );
      assert.match(await page.locator(`${c} [data-effective]`).innerText(), /Project_voice/);
      // Remove override
      await page.click(`${c} [data-act=remove-project]`);
      for (let i = 0; i < 100 && readJson(projectFile)?.voiceName !== undefined; i++)
        await wait(50);
      assert.equal(readJson(projectFile)?.voiceName, undefined);
      assert.equal(readJson(globalFile)?.voiceName, "Global_voice");
      // cancel leaves everything as it was
      await page.waitForSelector(`${c} [data-act=edit-global]`);
      await page.click(`${c} [data-act=edit-global]`);
      await page.click(`${c} [data-layer=global] [data-act=cancel]`);
      assert.equal(await page.locator(`${c} [data-layer=global] input`).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "without a project the override actions are disabled with the reason; a global-only setting says so",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup({ project: false });
    try {
      await open(page, "#/config?q=voiceName");
      const c = card("voiceName");
      assert.equal(
        await page.locator(`${c} [data-act=add-override]`).getAttribute("aria-disabled"),
        "true",
      );
      assert.match(
        await page.locator(`${c} [data-layer=project] .ds-why`).innerText(),
        /Open a project to override this setting/,
      );
      await page.click(`${c} [data-act=add-override]`, { force: true });
      assert.equal(
        await page.locator(`${c} [data-layer=project] input`).count(),
        0,
        "a disabled action does nothing",
      );
      // a global-only setting (the recordings root)
      await page.fill(".config-search input[type=search]", "root");
      await page.waitForSelector(`${card("root")}`);
      assert.match(
        await page.locator(`${card("root")} [data-layer=project] .ds-why`).innerText(),
        /global only|Open a project/i,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "the environment is read-only and wins: stated on the card, found by its filter, and a saved file value warns",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, dlg, globalFile, errors, close } = await setup({
      env: { DEMO_REC_VOICE: "Env_voice" },
    });
    try {
      await open(page, "#/config?filter=env");
      assert.deepEqual(
        await keys(page),
        ["voiceName"],
        "the only setting an environment variable sets",
      );
      const c = card("voiceName");
      assert.match(
        await page.locator(`${c} [data-effective]`).innerText(),
        /Env_voice[\s\S]*Environment \(DEMO_REC_VOICE\)/,
      );
      assert.match(
        await page.locator(`${c} .ds-notice`).innerText(),
        /DEMO_REC_VOICE[\s\S]*wins over both files \(read-only here\)/,
      );
      assert.equal(await page.locator("[data-filter=env]").getAttribute("aria-pressed"), "true");
      assert.match(await page.evaluate("location.hash"), /^#\/config\?filter=env$/);
      // the environment itself has no edit action; the file layers do, and the dialog says it has no effect
      assert.equal(await page.locator(`${c} [data-layer=env]`).count(), 0);
      await page.click(`${c} [data-act=edit-global]`);
      await page.fill(`${c} [data-layer=global] input`, "File_voice");
      await page.click(`${c} [data-layer=global] [data-act=save]`);
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await wait(50);
      assert.match(dlg.seen[0] ?? "", /no effect right now[\s\S]*overridden by/i);
      for (let i = 0; i < 100 && readJson(globalFile)?.voiceName !== "File_voice"; i++)
        await wait(50);
      assert.equal(readJson(globalFile)?.voiceName, "File_voice", "stored, though shadowed");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "quick filters: Changed, Overridden here, From environment combine with each other and with the text",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, globalFile, projectFile, errors, close } = await setup({
      env: { DEMO_REC_TTS_CHAIN: "say" },
    });
    try {
      fs.writeFileSync(globalFile, JSON.stringify({ voiceName: "Global_voice", fps: 24 }));
      fs.writeFileSync(projectFile, JSON.stringify({ fps: 30 }));
      await open(page);
      const total = (await keys(page)).length;
      await page.click("[data-filter=changed]");
      await page.waitForFunction(`document.querySelectorAll(".ds-setting").length < ${total}`);
      const changed = await keys(page);
      assert.ok(changed.includes("voiceName") && changed.includes("ttsChain"), changed.join(","));
      assert.match(await page.evaluate("location.hash"), /filter=changed/);
      await page.click("[data-filter=changed]"); // off again
      await page.click("[data-filter=overridden]");
      await page.waitForFunction(`document.querySelectorAll(".ds-setting").length < ${total}`);
      assert.deepEqual(await keys(page), ["fps"], "only what this project overrides");
      await page.click("[data-filter=overridden]");
      await page.click("[data-filter=env]");
      await page.waitForFunction(`document.querySelectorAll(".ds-setting").length < ${total}`);
      assert.deepEqual(await keys(page), ["ttsChain"]);
      // both filters hold at once; the text narrows further
      await page.click("[data-filter=changed]");
      assert.deepEqual(await keys(page), ["ttsChain"]);
      await page.fill(".config-search input[type=search]", "narration");
      await page.waitForSelector(".ds-state");
      await page.click("[data-act=clear-search]");
      await page.waitForFunction(`document.querySelectorAll(".ds-setting").length === ${total}`);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "shortcuts: / and Cmd/Ctrl+K focus the search, but never inside an editable control or over a dialog",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup();
    try {
      await open(page);
      const focusedSearch = () => page.evaluate("document.activeElement?.type === 'search'");
      await page.evaluate("document.activeElement?.blur()");
      await page.keyboard.press("/");
      assert.equal(await focusedSearch(), true, "/ from nowhere");
      await page.evaluate("document.activeElement.blur()");
      await page.keyboard.press("Control+k");
      assert.equal(await focusedSearch(), true, "Ctrl+K from nowhere");
      // typing a slash into a setting's editor types a slash
      const vn = "[data-key='voiceName']";
      await page.click(`${vn} [data-act=edit-global]`);
      const input = page.locator(`${vn} .ds-layer-edit input`).first();
      await input.focus();
      await page.keyboard.type("a/b");
      assert.match(await input.inputValue(), /\//, "the slash went into the field");
      await page.keyboard.press("Control+k");
      assert.equal(await focusedSearch(), false, "Ctrl+K does not take focus from an editor");
      await page.click("[data-act=cancel]");
      // over a dialog: nothing
      await page.evaluate(
        "(() => { const d = document.createElement('div'); d.className = 'modal-backdrop'; d.id = 'fake'; document.body.appendChild(d); })()",
      );
      await page.evaluate("document.activeElement?.blur()");
      await page.keyboard.press("/");
      assert.equal(await focusedSearch(), false);
      await page.evaluate("document.getElementById('fake').remove()");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "secrets never appear: an API key in the environment is only 'set', is not searchable, and is nowhere on the page",
  { skip, timeout: 90_000 },
  async () => {
    const { page, open, errors, close } = await setup({
      env: { OPENAI_API_KEY: "sk-live-SECRET-999", ELEVENLABS_API_KEY: "xi-SECRET-123" },
    });
    try {
      await open(page);
      assert.match(await page.locator(".api-keys").innerText(), /OPENAI_API_KEY: set/i);
      for (const needle of ["sk-live", "SECRET-999", "xi-SECRET"]) {
        await page.fill(".config-search input[type=search]", needle);
        await page.waitForSelector(".ds-state");
        assert.match(await page.locator(".ds-state").innerText(), /No setting matches/i, needle);
      }
      await page.fill(".config-search input[type=search]", "");
      await page.waitForSelector(".ds-setting");
      const html = await page.content();
      assert.equal(
        /sk-live|SECRET-999|xi-SECRET/.test(html),
        false,
        "the page never contains the key",
      );
      await page.click("details.raw-files summary");
      assert.equal(
        /sk-live|SECRET-999|xi-SECRET/.test(await page.content()),
        false,
        "nor the raw files",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
