/**
 * P1a PR 6 (F12): environment overrides are listed: what they set, what they hide, which test switches are on;
 * in `/demo doctor`, the notice when a project opens, `/api/config` and the Config screen.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { layerFiles } from "../src/config-edit.ts";
import { defaultConfig, resolveConfig } from "../src/config.ts";
import { type DoctorProbes, formatDoctor, runDoctor } from "../src/doctor.ts";
import { envNotice, envOverrides, formatOverride } from "../src/env-overrides.ts";
import { configRoutes } from "../src/panel/config-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

function files(config: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1a-env-"));
  const global = path.join(dir, "config.json");
  fs.writeFileSync(global, JSON.stringify(config));
  return { dir, global, files: { global } };
}

test("nothing set: nothing listed", () => {
  const f = files({ voiceName: "Stefan v2" });
  assert.deepEqual(envOverrides(f.files, {}, f.dir), []);
  assert.equal(envNotice([]), undefined);
});

test("a setting variable: its value, and the value from the file it hides", () => {
  const f = files({ voiceName: "Stefan v2", panelPort: 4000 });
  const env = { DEMO_REC_CONFIG: f.global, DEMO_REC_VOICE: "Rachel", DEMO_REC_PANEL_PORT: "4000" };
  const list = envOverrides(f.files, env, f.dir);
  const voice = list.find((o) => o.variable === "DEMO_REC_VOICE");
  assert.deepEqual(
    [voice?.what, voice?.value, voice?.hides, voice?.strong],
    ["voiceName", "Rachel", "Stefan v2", false],
  );
  const port = list.find((o) => o.variable === "DEMO_REC_PANEL_PORT");
  assert.equal(port?.hides, undefined, "the same as the file: nothing hidden");
  assert.match(formatOverride(port as never), /same as the file or default/);
  assert.match(formatOverride(voice as never), /overrides voiceName, hiding Stefan v2/);
  // the redirected config file is listed too (not strong: it is a path, not a switch that removes behaviour)
  const cfgVar = list.find((o) => o.variable === "DEMO_REC_CONFIG");
  assert.equal(cfgVar?.strong, false);
});

test("a setting with no file value hides the default", () => {
  const f = files({});
  const list = envOverrides(
    f.files,
    { DEMO_REC_CONFIG: f.global, DEMO_REC_VOICE: "Rachel" },
    f.dir,
  );
  const voice = list.find((o) => o.variable === "DEMO_REC_VOICE");
  assert.equal(voice?.hides, "(not set)", "what applies without it: nothing");
});

test("the test switches are listed and warned about more strongly", () => {
  const f = files({});
  const env = { DEMO_REC_CONFIG: f.global, DEMO_REC_NO_OPEN: "1", DEMO_REC_NO_VOICE_LIST: "1" };
  const list = envOverrides(f.files, env, f.dir);
  assert.deepEqual(
    list.filter((o) => o.strong).map((o) => o.variable),
    ["DEMO_REC_NO_OPEN", "DEMO_REC_NO_VOICE_LIST"],
  );
  const note = envNotice(list) ?? "";
  assert.match(note, /3 environment override\(s\) in effect, they win over your config file/);
  assert.match(
    note,
    /‼ DEMO_REC_NO_OPEN=1: the panel is never opened in your browser \(a test switch\)/,
  );
  assert.match(note, /\/demo doctor lists them too/);
});

function probes(env: NodeJS.ProcessEnv, f: ReturnType<typeof files>): Partial<DoctorProbes> {
  return {
    run: (cmd, args) =>
      cmd === "ffmpeg" && args.includes("-encoders")
        ? { status: 0, stdout: " V....D libx264" }
        : { status: 0, stdout: `${cmd} 1\n` },
    env,
    nodeVersion: "24.1.0",
    chromiumPath: async () => "/fake/chromium",
    exists: () => true,
    freeBytes: () => 50 * 1024 ** 3,
    ensureWritable: () => {},
    files: f.files,
    home: f.dir,
  };
}

test("doctor: a pass when nothing is overridden, a warning per override otherwise", async () => {
  const f = files({ voiceName: "Stefan v2" });
  const cfg = { ...defaultConfig(f.dir), voiceName: "Stefan v2" };
  const clean = await runDoctor(cfg, probes({ ELEVENLABS_API_KEY: "k", OPENAI_API_KEY: "k" }, f));
  assert.equal(clean.find((r) => r.name === "environment overrides")?.status, "pass");

  const env = {
    DEMO_REC_CONFIG: f.global,
    DEMO_REC_VOICE: "Rachel",
    DEMO_REC_NO_OPEN: "1",
    ELEVENLABS_API_KEY: "sk-secret-123",
    OPENAI_API_KEY: "k",
  };
  const results = await runDoctor(cfg, probes(env, f));
  const warns = results.filter((r) => r.name.startsWith("env "));
  assert.deepEqual(warns.map((r) => r.name).sort(), [
    "env DEMO_REC_CONFIG",
    "env DEMO_REC_NO_OPEN",
    "env DEMO_REC_VOICE",
  ]);
  assert.ok(warns.every((r) => r.status === "warn"));
  assert.match(
    warns.find((r) => r.name === "env DEMO_REC_NO_OPEN")?.detail ?? "",
    /remove it unless you are testing/,
  );
  assert.match(
    warns.find((r) => r.name === "env DEMO_REC_VOICE")?.detail ?? "",
    /hiding Stefan v2/,
  );
  assert.doesNotMatch(formatDoctor(results), /sk-secret-123/, "keys are never printed");
});

test("/api/config carries the list for the Config screen", async () => {
  const f = files({ voiceName: "Stefan v2" });
  const env = { DEMO_REC_CONFIG: f.global, DEMO_REC_VOICE: "Rachel" };
  const routes = configRoutes({
    activeProject: () => undefined,
    reloadConfig: () => resolveConfig({ env, home: f.dir }),
    publish: () => {},
    env,
    home: f.dir,
  } as never);
  const view = (await routes.get.config?.(new URLSearchParams())) as {
    envOverrides: { variable: string }[];
  };
  assert.deepEqual(view.envOverrides.map((o) => o.variable).sort(), [
    "DEMO_REC_CONFIG",
    "DEMO_REC_VOICE",
  ]);
});

test("/api/config says when the configured brand is not under the working folder (R2-8)", async () => {
  const f = files({ brand: "datadog-poc" });
  const env = { DEMO_REC_CONFIG: f.global };
  const routes = configRoutes({
    activeProject: () => undefined,
    reloadConfig: () => ({ ...resolveConfig({ env, home: f.dir }), root: f.dir }),
    publish: () => {},
    env,
    home: f.dir,
  } as never);
  const view = (await routes.get.config?.(new URLSearchParams())) as {
    brandMissing: { name: string; used: string; root: string } | null;
  };
  assert.deepEqual(view.brandMissing, { name: "datadog-poc", used: "neutral", root: f.dir });
  const ok = configRoutes({
    activeProject: () => undefined,
    reloadConfig: () => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: files({}).global }, home: f.dir }),
      root: f.dir,
    }),
    publish: () => {},
    env,
    home: f.dir,
  } as never);
  assert.equal(
    ((await ok.get.config?.(new URLSearchParams())) as { brandMissing: unknown }).brandMissing,
    null,
  );
});

test("the runtime reports the overrides of the process environment", () => {
  const saved = process.env.DEMO_REC_NO_OPEN;
  process.env.DEMO_REC_NO_OPEN = "1";
  try {
    const rt = new Runtime(() => defaultConfig(os.homedir()));
    assert.ok(rt.envOverrides().some((o) => o.variable === "DEMO_REC_NO_OPEN" && o.strong));
    assert.ok(Array.isArray((rt.snapshot() as { envOverrides: unknown }).envOverrides));
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "DEMO_REC_NO_OPEN");
    else process.env.DEMO_REC_NO_OPEN = saved;
  }
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
  "the Config screen lists the overrides",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const saved = {
      c: process.env.DEMO_REC_CONFIG,
      v: process.env.DEMO_REC_VOICE,
      o: process.env.DEMO_REC_NO_OPEN,
    };
    process.env.DEMO_REC_CONFIG = cfg;
    process.env.DEMO_REC_VOICE = "Rachel";
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(`${panel.url}#/config`);
      await page.waitForSelector(".ds-cfg-env");
      const text = await page.locator(".ds-cfg-env").innerText();
      // seedPanelProject also sets DEMO_REC_NO_VOICE_LIST
      assert.match(text, /4 environment overrides in effect/);
      assert.match(text, /DEMO_REC_VOICE = Rachel/);
      assert.match(text, /DEMO_REC_NO_OPEN = 1\s+test switch/);
      assert.match(text, /DEMO_REC_NO_VOICE_LIST = 1\s+test switch/);
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-env.png` });
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      for (const [k, v] of [
        ["DEMO_REC_CONFIG", saved.c],
        ["DEMO_REC_VOICE", saved.v],
        ["DEMO_REC_NO_OPEN", saved.o],
      ] as const) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
