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

interface Tool {
  name: string;
  parameters: { properties: Record<string, { enum?: string[]; anyOf?: unknown[] }> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: { type: string; text?: string }[];
    details: Record<string, unknown>;
  }>;
}

async function load(opts: { hasUI?: boolean } = {}) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const sent: { text: string; options?: Record<string, unknown> }[] = [];
  const messages: { text: string; options?: Record<string, unknown> }[] = [];
  const statuses: (string | undefined)[] = [];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const pi = {
    on: (name: string, h: Handler) => events.set(name, h),
    registerCommand: (name: string, c: Command) => commands.set(name, c),
    registerTool: (t: Tool) => tools.set(t.name, t),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string, options?: Record<string, unknown>) =>
      sent.push({ text, ...(options ? { options } : {}) }),
    sendMessage: (message: { content: string }, options?: Record<string, unknown>) =>
      messages.push({ text: message.content, ...(options ? { options } : {}) }),
  };
  const mod = await import(`../index.ts?${Date.now()}`);
  mod.default(pi);
  const notes: { msg: string; level?: string }[] = [];
  const ctx = {
    hasUI: opts.hasUI ?? false,
    ui: {
      notify: (msg: string, level?: string) => notes.push({ msg, level }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
    sessionManager: { getEntries: () => entries },
  };
  return { events, commands, tools, sent, messages, statuses, entries, notes, ctx };
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

const textOf = (r: { content: { text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("\n");

test("S2 tools: registered; storyboard tool cannot approve; record refuses without approval", async () => {
  const { tools, events, ctx } = await load();
  assert.deepEqual([...tools.keys()].sort(), [
    "demo_rec_brand",
    "demo_rec_browser",
    "demo_rec_config",
    "demo_rec_edit",
    "demo_rec_project",
    "demo_rec_record",
    "demo_rec_storyboard",
    "demo_rec_take",
    "demo_rec_tts",
    "demo_rec_vo",
  ]);
  const sbTool = tools.get("demo_rec_storyboard");
  assert.ok(sbTool);
  const actionSchema = JSON.stringify(sbTool.parameters.properties.action);
  assert.match(actionSchema, /"write"/);
  assert.doesNotMatch(actionSchema, /approve/i, "approval is a panel-only human gate");

  const project = tools.get("demo_rec_project");
  assert.ok(project);
  await assert.rejects(project.execute("1", { action: "status" }), /no active demo project/);
  const created = await project.execute("2", {
    action: "create",
    project: "tool-proj",
    app_name: "Acme Pulse",
    app_url: "http://127.0.0.1:9/",
  });
  assert.match(textOf(created), /Created project "tool-proj"/);
  await project.execute("3", {
    action: "write_brief",
    content: "# Demo brief: tool-proj\n\n- **Audience:** CFOs\n",
  });
  assert.match(textOf(await project.execute("4", { action: "read_brief" })), /CFOs/);
  assert.ok(fs.existsSync(path.join(root, "projects", "tool-proj", "brief", "v1.md")));

  await assert.rejects(
    sbTool.execute("5", { action: "write", yaml: "start_url: /\nscenes: []\n" }),
    /scenes: must be a non-empty list/,
  );
  const written = await sbTool.execute("6", {
    action: "write",
    yaml: "start_url: /\nscenes:\n  - id: 01-a\n    title: A\n    steps: [{ do: hover, target: { role: link, name: Search } }]\n",
  });
  assert.match(textOf(written), /Stored storyboard v1/);
  assert.match(textOf(written), /01-a: no screen thumbnail/);
  assert.match(
    textOf(await sbTool.execute("7", { action: "get" })),
    /storyboard v1 .*accepted: none; working line: none/,
  );
  const status = textOf(await project.execute("8", { action: "status" }));
  assert.match(status, /phase: {3}storyboard-review/);

  const record = tools.get("demo_rec_record");
  assert.ok(record);
  await assert.rejects(
    record.execute("9", {}),
    /no accepted storyboard on the working line .* accept one in the demo panel first/,
  );
  await events.get("session_shutdown")?.({}, ctx);
});

test("/demo new hands off to the demo-brief skill; /demo discover to demo-recording", async () => {
  const { commands, sent, events, ctx } = await load({ hasUI: true });
  const demo = commands.get("demo");
  assert.ok(demo);
  await demo.handler("new brief-proj http://127.0.0.1:9/ Acme Pulse", ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? "", /^\/skill:demo-brief Demo project "brief-proj"/);
  assert.deepEqual(sent[0]?.options, { expandPromptTemplates: true });

  await demo.handler("discover focus on the assistant", ctx);
  assert.match(
    sent[1]?.text ?? "",
    /^\/skill:demo-recording Discover Acme Pulse .*Extra notes from me: focus on the assistant/,
  );

  // Re-opening an existing project does not re-trigger the brief.
  await demo.handler("new brief-proj http://127.0.0.1:9/ Acme Pulse", ctx);
  assert.equal(sent.length, 2);
  await events.get("session_shutdown")?.({}, ctx);
});

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const recordSkip = !(await chromiumAvailable()) && "needs Playwright Chromium";

test(
  "S3 record tool: background job, footer progress, completion message into the session",
  { skip: recordSkip, timeout: 120_000 },
  async () => {
    const { serveFixture } = await import("../src/fixture/server.ts");
    const { approve } = await import("../src/workdir/state.ts");
    const fixture = await serveFixture(0);
    const { tools, messages, statuses, events, ctx } = await load();
    try {
      const project = tools.get("demo_rec_project");
      const sbTool = tools.get("demo_rec_storyboard");
      const record = tools.get("demo_rec_record");
      assert.ok(project && sbTool && record);
      await project.execute("1", {
        action: "create",
        project: "bg",
        app_name: "Acme Pulse",
        app_url: fixture.url,
      });
      await sbTool.execute("2", {
        action: "write",
        yaml: "start_url: /\nscenes:\n  - id: 01-a\n    title: A\n    steps:\n      - { do: hover, target: { role: link, name: Search }, mark: hovered }\n      - { do: click, target: { role: link, name: Search } }\n",
      });
      approve(path.join(root, "projects", "bg"), "storyboard", 1);

      const t0 = Date.now();
      const started = await record.execute("3", {}, undefined, undefined, ctx as never);
      assert.ok(Date.now() - t0 < 3000, "start returns immediately");
      assert.match(textOf(started), /Recording started \(record-1\)/);
      await assert.rejects(
        record.execute("4", {}, undefined, undefined, ctx as never),
        /already running/,
      );
      assert.match(textOf(await record.execute("5", { action: "status" })), /record-1: running/);

      const deadline = Date.now() + 90_000;
      while (!messages.length && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 200));
      assert.equal(messages.length, 1, "exactly one completion message");
      assert.match(
        messages[0]?.text ?? "",
        /^\[demo-recording\] Recorded take-001 of storyboard v1/,
      );
      assert.match(messages[0]?.text ?? "", /hovered @ /);
      assert.deepEqual(messages[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
      assert.ok(
        statuses.some((s) => s?.startsWith("🎬")),
        "footer showed recording progress",
      );
      assert.equal(statuses.at(-1), undefined, "footer cleared at the end");
      assert.match(textOf(await record.execute("6", { action: "status" })), /record-1: done/);
    } finally {
      await events.get("session_shutdown")?.({}, ctx);
      await fixture.close();
    }
  },
);

test("S5 config tool: two-phase write (diff first), project scope; /demo voiceover|render kick off the skill", async () => {
  const { tools, commands, sent, events, ctx } = await load({ hasUI: true });
  const cfgTool = tools.get("demo_rec_config");
  assert.ok(cfgTool);
  const shown = textOf(await cfgTool.execute("1", { action: "show", key: "improvise" }));
  assert.match(
    shown,
    /improvise\.models = \["anthropic\/claude-haiku-4-5","openai\/gpt-5\.4-mini"\] {3}\[default\]/,
  );

  const planned = await cfgTool.execute("2", {
    action: "set",
    key: "improvise.hesitateMs",
    value: "4500",
  });
  assert.match(textOf(planned), /NOT written yet[\s\S]*improvise\.hesitateMs: \(not set\) → 4500/);
  assert.ok(!fs.existsSync(path.join(root, "no-config.json")), "planning writes nothing");
  await cfgTool.execute("3", {
    action: "set",
    key: "improvise.hesitateMs",
    value: "4500",
    confirm: true,
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "no-config.json"), "utf8")).improvise.hesitateMs,
    4500,
  );
  await assert.rejects(
    cfgTool.execute("4", { action: "set", key: "fps", value: "0", confirm: true }),
    /"fps" must be a positive integer/,
  );
  await assert.rejects(
    cfgTool.execute("5", { action: "set", key: "voiceName", value: "x", scope: "project" }),
    /no active project/,
  );

  const demo = commands.get("demo");
  assert.ok(demo);
  await demo.handler("new cfgproj http://127.0.0.1:9/ Acme Pulse", ctx);
  await cfgTool.execute("6", {
    action: "set",
    key: "voiceName",
    value: "Project Voice",
    scope: "project",
    confirm: true,
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "projects", "cfgproj", "config.json"), "utf8"))
      .voiceName,
    "Project Voice",
  );
  assert.match(
    textOf(await cfgTool.execute("7", { action: "show", key: "voiceName" })),
    /voiceName = "Project Voice" {3}\[project\]/,
  );
  await assert.rejects(
    cfgTool.execute("8", { action: "set", key: "root", value: "/tmp/x", scope: "project" }),
    /only be set globally/,
  );

  await demo.handler("voiceover keep it punchy", ctx);
  assert.match(
    sent.at(-1)?.text ?? "",
    /^\/skill:demo-voiceover Analyze the latest complete take of "cfgproj".*Notes from me: keep it punchy/,
  );
  await demo.handler("render", ctx);
  assert.match(
    sent.at(-1)?.text ?? "",
    /^\/skill:demo-voiceover .*demo_rec_tts check.*demo_rec_edit start/,
  );
  await events.get("session_shutdown")?.({}, ctx);
});

test("S5 brand tool + /demo brand: list, show, duplicate, update (preview optional), two-phase use, new/rerender kick-offs", async () => {
  const { tools, commands, sent, events, ctx, notes } = await load({ hasUI: false });
  const brand = tools.get("demo_rec_brand");
  assert.ok(brand);
  assert.match(
    textOf(await brand.execute("1", { action: "list" })),
    /▶ neutral \(built-in\)[\s\S]*default brand: neutral/,
  );
  assert.match(
    textOf(await brand.execute("2", { action: "show", name: "neutral" })),
    /"inset": 0\.92/,
  );
  await assert.rejects(brand.execute("3", { action: "show" }), /show needs name/);
  await assert.rejects(
    brand.execute("4", { action: "update", name: "neutral", settings: '{"frame":{"radius":4}}' }),
    /built in/,
  );

  assert.match(
    textOf(await brand.execute("5", { action: "duplicate", name: "neutral", to: "mine" })),
    /Duplicated into "mine"/,
  );
  // Update writes even when no preview can be rendered (e.g. no Chromium); preview failure is reported, not thrown.
  const updated = textOf(
    await brand.execute("6", {
      action: "update",
      name: "mine",
      settings: '{"colors":{"accent":"#ff8800"}}',
    }),
  );
  assert.match(updated, /Updated "mine"/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "brands", "mine", "brand.json"), "utf8")).colors
      .accent,
    "#ff8800",
  );
  await assert.rejects(
    brand.execute("7", { action: "update", name: "mine", settings: "{not json" }),
    /settings must be JSON/,
  );

  const cfgFile = path.join(root, "no-config.json");
  assert.match(
    textOf(await brand.execute("8", { action: "use", name: "mine" })),
    /NOT written yet[\s\S]*brand/,
  );
  assert.ok(!fs.existsSync(cfgFile));
  await brand.execute("9", { action: "use", name: "mine", confirm: true });
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, "utf8")).brand, "mine");
  await assert.rejects(brand.execute("10", { action: "use", name: "missing" }), /missing/);

  const demo = commands.get("demo");
  assert.ok(demo);
  await demo.handler("brand", ctx);
  assert.match(notes.at(-1)?.msg ?? "", /▶ mine[\s\S]*default: mine/);
  await demo.handler("brand new ~/Downloads/acme.zip", ctx);
  assert.match(sent.at(-1)?.text ?? "", /^\/skill:demo-brand .*from ~\/Downloads\/acme\.zip/);
  await demo.handler("brand use neutral", ctx);
  assert.match(notes.at(-1)?.msg ?? "", /no UI to confirm/);
  assert.equal(
    JSON.parse(fs.readFileSync(cfgFile, "utf8")).brand,
    "mine",
    "nothing written without confirmation",
  );
  await demo.handler("new brandproj http://127.0.0.1:9/ Acme Pulse", ctx);
  await demo.handler("brand rerender neutral", ctx);
  assert.match(
    sent.at(-1)?.text ?? "",
    /Re-render the latest edit of "brandproj" with brand "neutral".*rerender/,
  );
  await demo.handler("brand frobnicate", ctx);
  assert.match(notes.at(-1)?.msg ?? "", /usage: \/demo brand/);
  await events.get("session_shutdown")?.({}, ctx);
});

test("S5 project memory: /demo notes and chat notes are logged, context excludes outdated, open/restore prime the agent", async () => {
  const { tools, commands, messages, entries, events, ctx } = await load({ hasUI: false });
  const demo = commands.get("demo");
  const proj = tools.get("demo_rec_project");
  assert.ok(demo && proj);
  await demo.handler("new memproj http://127.0.0.1:9/ Acme Pulse", ctx);
  await demo.handler("discover focus on the churn view, skip settings", ctx);
  await demo.handler("voiceover evaluator tone, no hype", ctx);
  await demo.handler("discover", ctx); // no notes → nothing logged

  const noted = textOf(
    await proj.execute("1", {
      action: "note",
      text: "keep the whole demo under 3 minutes",
      kind: "direction",
      stage: "storyboard",
    }),
  );
  assert.match(noted, /Recorded in-0003 \(storyboard, direction\)/);
  await proj.execute("2", {
    action: "note",
    text: "pricing page: https://acme.test/pricing",
    kind: "source",
    refs: ["https://acme.test/pricing"],
  });
  await proj.execute("3", {
    action: "write_brief",
    content: "# Demo brief: memproj\n\n- **Goal / key message:** churn in a minute\n",
  });
  await assert.rejects(proj.execute("4", { action: "mark", id: "in-0002" }), /needs a reason/);
  assert.match(
    textOf(
      await proj.execute("5", { action: "mark", id: "in-0002", reason: "tone decided later" }),
    ),
    /in-0002 marked outdated/,
  );

  const context = textOf(await proj.execute("6", { action: "context" }));
  assert.match(context, /churn in a minute/);
  assert.match(context, /\[discovery\][\s\S]*\/demo discover: focus on the churn view/);
  assert.match(context, /keep the whole demo under 3 minutes/);
  assert.match(context, /source\/chat: pricing page.*refs: https:\/\/acme\.test\/pricing/);
  assert.match(context, /brief v1 saved/);
  assert.doesNotMatch(context, /evaluator tone/, "outdated input left out");
  assert.match(context, /4 active, 1 marked outdated/);

  // /demo open primes the next turn with the same memory, without triggering a turn.
  const before = messages.length;
  await demo.handler("open memproj", ctx);
  const primed = messages.slice(before).find((m) => /Project context: memproj/.test(m.text));
  assert.ok(primed, "context primed on /demo open");
  assert.deepEqual(primed.options, { triggerTurn: false, deliverAs: "nextTurn" });
  assert.doesNotMatch(primed.text, /evaluator tone/);
  await events.get("session_shutdown")?.({}, ctx);

  // Session restore primes it too.
  const second = await load();
  second.entries.push(...entries);
  await second.events.get("session_start")?.({ reason: "resume" }, second.ctx);
  assert.ok(second.messages.some((m) => /Project context: memproj/.test(m.text)));
  await second.events.get("session_shutdown")?.({}, second.ctx);
});
