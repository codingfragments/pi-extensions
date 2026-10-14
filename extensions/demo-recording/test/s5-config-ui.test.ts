/**
 * S5 part 5b — ⚙ Config → Settings: the grouped settings view (types, order,
 * labels, per-layer values, env overrides), the two-phase set/unset routes for
 * global and project scope (validation, secrets, shadowing), reload / open in
 * editor, API-key presence, and a browser walk-through.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { layerFiles } from "../src/config-edit.ts";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { configRoutes, settingsView } from "../src/panel/config-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const noBrowser =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

let root: string;
let globalFile: string;
const saved = { cfg: process.env.DEMO_REC_CONFIG, open: process.env.DEMO_REC_NO_OPEN };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-cfgui-"));
  globalFile = path.join(root, "global.json");
  // Never touch the real ~/.config/demo-recording/config.json, never open an editor.
  process.env.DEMO_REC_CONFIG = globalFile;
  process.env.DEMO_REC_NO_OPEN = "1";
  fs.writeFileSync(
    globalFile,
    `${JSON.stringify({ _comment: "keep me", voiceName: "Stefan_trained", fps: 30 }, null, 2)}\n`,
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [
    ["DEMO_REC_CONFIG", saved.cfg],
    ["DEMO_REC_NO_OPEN", saved.open],
  ] as const) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

function project() {
  const p = ensureProject(root, { project: "kc", appName: "KeyCraft", appUrl: "https://k.test" });
  fs.writeFileSync(
    path.join(p.dir, "config.json"),
    `${JSON.stringify({ voiceName: "Calm narrator" }, null, 2)}\n`,
  );
  return p;
}

test("settings view: groups, priority order, labels, types, layers, env overrides, global-only", () => {
  const p = project();
  const env = { DEMO_REC_CONFIG: globalFile, DEMO_REC_BRAND: "neutral" };
  const groups = settingsView(layerFiles(env, os.homedir(), p.dir), env, os.homedir(), root);
  assert.deepEqual(
    groups.map((g) => g.id),
    ["voice", "models", "recording", "output", "annotations", "discovery", "general"],
  );
  const voice = groups.find((g) => g.id === "voice")?.settings ?? [];
  assert.deepEqual(
    voice.slice(0, 2).map((s) => s.key),
    ["ttsChain", "voiceName"],
    "most important first",
  );
  const by = (k: string) => groups.flatMap((g) => g.settings).find((s) => s.key === k);
  const auto = by("annotations.autoSuggest");
  assert.equal(auto?.type, "boolean");
  assert.equal(auto?.value, true, "on by default (D53)");
  assert.equal(by("ttsChain")?.type, "engines");
  assert.deepEqual(by("ttsChain")?.options, ["elevenlabs", "openai", "kokoro", "say"]);
  assert.equal(by("brand")?.type, "enum");
  assert.ok(by("brand")?.options?.includes("neutral"));
  assert.equal(by("improvise.models")?.type, "list");
  assert.equal(by("recording.keepFrames")?.type, "boolean");
  assert.equal(by("tts.elevenlabs.stability")?.type, "number", "optional keys get a type");
  assert.equal(by("tts.elevenlabs.model")?.label, "ElevenLabs · Model");
  assert.equal(by("tts.openai.model")?.label, "OpenAI · Model");
  assert.equal(by("voiceName")?.label, "Voice Name");
  assert.equal(by("ttsChain")?.label, "TTS Chain");
  assert.equal(by("budgets.discoveryActions")?.label, "Discovery · Actions");
  assert.equal(by("viewport.dpr")?.label, "Viewport · DPR");
  const vn = by("voiceName");
  assert.deepEqual(
    [vn?.source, vn?.value, vn?.layers.global, vn?.layers.project],
    ["project", "Calm narrator", "Stefan_trained", "Calm narrator"],
  );
  const brand = by("brand");
  assert.deepEqual([brand?.source, brand?.envVar, brand?.envSet], ["env", "DEMO_REC_BRAND", true]);
  assert.equal(by("root")?.globalOnly, true);
});

test("routes: two-phase set/unset in both scopes, validation, secrets, shadowing, reload, open, API keys", () => {
  const p = project();
  const published: string[] = [];
  const routes = configRoutes({
    activeProject: () => p,
    reloadConfig: () => ({
      ...resolveConfig({
        env: { DEMO_REC_CONFIG: globalFile },
        projectConfigFile: path.join(p.dir, "config.json"),
      }),
      root,
    }),
    publish: (type) => published.push(type),
    env: { DEMO_REC_CONFIG: globalFile, ELEVENLABS_API_KEY: "sk-123" },
    home: os.homedir(),
  });
  const get = routes.get.config as (q: URLSearchParams) => Record<string, unknown>;
  const post = (n: string, body: Record<string, unknown>) =>
    (routes.post[n] as (b: Record<string, unknown>) => Record<string, unknown>)(body);
  const view = get(new URLSearchParams()) as {
    files: { global: string; project: string };
    raw: { global: string; project: string };
    apiKeys: { name: string; set: boolean }[];
  };
  assert.equal(view.files.global, globalFile);
  assert.match(view.raw.global, /"_comment": "keep me"/);
  assert.match(view.raw.project, /Calm narrator/);
  assert.deepEqual(
    view.apiKeys.map((k) => [k.name, k.set]),
    [
      ["ELEVENLABS_API_KEY", true],
      ["OPENAI_API_KEY", false],
    ],
  );
  assert.doesNotMatch(JSON.stringify(view), /sk-123/, "never the key itself");

  // Global set, two-phase; the project shadows voiceName.
  const before = fs.readFileSync(globalFile, "utf8");
  const plan = post("config-set", { key: "voiceName", value: "Other voice" });
  assert.equal(plan.planned, true);
  assert.match(String(plan.diff), /\+.*Other voice/);
  assert.match(String(plan.shadowedBy), /project/);
  assert.equal(fs.readFileSync(globalFile, "utf8"), before, "planning writes nothing");
  post("config-set", { key: "fps", value: 25, confirm: true });
  const g = JSON.parse(fs.readFileSync(globalFile, "utf8"));
  assert.equal(g.fps, 25);
  assert.equal(g._comment, "keep me", "_comment kept");
  assert.ok(published.includes("config.changed"));

  // Project scope: set and unset.
  post("config-set", {
    key: "ttsChain",
    value: ["openai", "kokoro"],
    scope: "project",
    confirm: true,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, "config.json"), "utf8")).ttsChain, [
    "openai",
    "kokoro",
  ]);
  post("config-set", { key: "voiceName", unset: true, scope: "project", confirm: true });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(p.dir, "config.json"), "utf8")).voiceName,
    undefined,
  );

  // Refusals.
  assert.throws(
    () => post("config-set", { key: "root", value: "/tmp/x", scope: "project" }),
    /only be set globally/,
  );
  assert.throws(() => post("config-set", { key: "fps", value: 0 }), /fps/);
  assert.throws(
    () => post("config-set", { key: "elevenlabsApiKey", value: "x" }),
    /looks like a secret/,
  );
  assert.throws(() => post("config-set", { key: "nope", value: 1 }), /unknown setting/);
  assert.throws(() => post("config-set", { key: "fps" }), /"value" is required/);
  assert.throws(
    () => post("config-set", { key: "tts.say.voice", unset: true }),
    /not set in the global config/,
  );

  // Reload + open (DEMO_REC_NO_OPEN): the project file exists, nothing is opened.
  assert.ok(Array.isArray(post("config-reload", {}).sources));
  const opened = post("config-open", { scope: "project" });
  assert.equal(opened.opened, false);
  assert.equal(opened.file, path.join(p.dir, "config.json"));
});

test(
  "Settings in the browser: change a value via the diff, switch to the project scope, reset an override",
  { skip: noBrowser },
  async () => {
    const p = project();
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
      root,
      panelPort: 0,
    }));
    rt.setActiveProject("kc");
    const panel = await rt.ensurePanel();
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      const dialogs: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", async (d) => {
        dialogs.push(d.message());
        await d.accept();
      });
      await page.goto(panel.url);
      await page.locator("button.config-btn").click();
      await page.waitForSelector(".setting-group");
      assert.match(
        (await page.locator("pre.raw").textContent()) ?? "",
        /Stefan_trained/,
        "raw global file shown",
      );
      // fps 30 → 24 (global)
      const fps = page.locator(".setting", { has: page.locator(".mono", { hasText: /^fps$/ }) });
      await fps.locator("input").fill("24");
      await fps.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(600);
      assert.match(dialogs.at(-1) ?? "", /Set fps \(global\)\?[\s\S]*"fps": 24/);
      assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).fps, 24);
      // Project scope: reset the voiceName override
      await page.getByRole("button", { name: /^This project/ }).click();
      const vn = page.locator(".setting", {
        has: page.locator(".mono", { hasText: /^voiceName$/ }),
      });
      await vn.getByRole("button", { name: "reset" }).click();
      await page.waitForTimeout(600);
      assert.match(dialogs.at(-1) ?? "", /Reset voiceName \(project kc\)/);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(p.dir, "config.json"), "utf8")).voiceName,
        undefined,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
    }
  },
);
