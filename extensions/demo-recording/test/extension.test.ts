/**
 * Drives the extension factory with a stub ExtensionAPI: verifies what gets
 * registered, that nothing long-lived starts in the factory, and that
 * /demo new → status → session_shutdown works against a temp root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface Command {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
}

let root: string;
const saved = {
  root: process.env.DEMO_REC_ROOT,
  cfg: process.env.DEMO_REC_CONFIG,
  port: process.env.DEMO_REC_PANEL_PORT,
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-ext-"));
  process.env.DEMO_REC_ROOT = root;
  process.env.DEMO_REC_CONFIG = path.join(root, "no-config.json");
  process.env.DEMO_REC_PANEL_PORT = "47770";
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [
    ["DEMO_REC_ROOT", saved.root],
    ["DEMO_REC_CONFIG", saved.cfg],
    ["DEMO_REC_PANEL_PORT", saved.port],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function load() {
  const events = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const pi = {
    on: (name: string, h: Handler) => events.set(name, h),
    registerCommand: (name: string, c: Command) => commands.set(name, c),
    registerTool: () => {},
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  };
  const mod = await import(`../index.ts?${Date.now()}`);
  mod.default(pi);
  const notes: { msg: string; level?: string }[] = [];
  const ctx = {
    hasUI: false,
    ui: { notify: (msg: string, level?: string) => notes.push({ msg, level }) },
    sessionManager: { getEntries: () => entries },
  };
  return { events, commands, entries, notes, ctx };
}

test("registers /demo, skills discovery and lifecycle hooks; no side effects at load", async () => {
  const { events, commands } = await load();
  assert.ok(commands.has("demo"));
  assert.deepEqual([...events.keys()].sort(), [
    "resources_discover",
    "session_shutdown",
    "session_start",
  ]);
  const res = (await events.get("resources_discover")?.({}, {})) as { skillPaths: string[] };
  assert.ok(res.skillPaths[0]?.endsWith(path.join("demo-recording", "skills")));
  assert.deepEqual(fs.readdirSync(root), [], "factory must not create files or start servers");
});

test("/demo new → status → session restore → shutdown", async () => {
  const { events, commands, entries, notes, ctx } = await load();
  const demo = commands.get("demo");
  assert.ok(demo);

  await demo.handler("new churn-poc http://127.0.0.1:9/ Acme Pulse", ctx);
  const created = notes.at(-1);
  assert.ok(created);
  assert.match(created.msg, /Created demo project "churn-poc"/);
  assert.match(created.msg, /panel: {2}http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  assert.ok(fs.existsSync(path.join(root, "projects", "churn-poc", "state.json")));
  assert.ok(fs.existsSync(path.join(root, "apps", "acme-pulse", "app.json")));
  assert.deepEqual(
    entries.map((e) => e.data),
    [{ project: "churn-poc" }],
  );

  await demo.handler("status", ctx);
  assert.match(notes.at(-1)?.msg ?? "", /project: churn-poc \(app: Acme Pulse/);
  assert.match(notes.at(-1)?.msg ?? "", /phase: {3}brief/);

  const completions = demo.getArgumentCompletions?.("open ch") as { label: string }[];
  assert.deepEqual(
    completions.map((c) => c.label),
    ["churn-poc"],
  );

  await events.get("session_shutdown")?.({}, ctx);

  // A fresh instance restores the active project from session entries.
  const second = await load();
  second.entries.push(...entries);
  await second.events.get("session_start")?.({ reason: "resume" }, second.ctx);
  await second.commands.get("demo")?.handler("status", second.ctx);
  assert.match(second.notes.at(-1)?.msg ?? "", /project: churn-poc/);

  await second.commands.get("demo")?.handler("bogus", second.ctx);
  assert.match(second.notes.at(-1)?.msg ?? "", /\/demo new/);
  await second.events.get("session_shutdown")?.({}, second.ctx);
});

test("errors surface as notifications, not exceptions", async () => {
  const { commands, notes, ctx } = await load();
  await commands.get("demo")?.handler("open does-not-exist", ctx);
  assert.equal(notes.at(-1)?.level, "error");
  assert.match(notes.at(-1)?.msg ?? "", /no demo project/);
});
