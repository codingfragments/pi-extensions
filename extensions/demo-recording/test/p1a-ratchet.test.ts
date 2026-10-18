/**
 * P1a PR 4: the ratchet behind "the Director cannot approve or spend on its own" (F15, F17).
 *
 * Every action of every agent tool is classified here. A new tool or action fails this test until
 * someone decides what it is:
 *   free       no credits, no recording time (local work, reading, writing project files)
 *   gated      spends credits or recording time: refused until the user allowed it (src/grants.ts)
 *   announced  starts by itself, but says so with what it costs (run-and-tell)
 *   proposal   leaves a suggestion; the user decides
 * There is deliberately no class for "approves": only the panel approves.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

type Kind = "free" | "gated" | "announced" | "proposal";

const POLICY: Record<string, Record<string, Kind>> = {
  demo_rec_annotations: {
    context: "free",
    suggest: "free",
    get: "free",
    write: "free",
    import: "free",
    preview: "free",
  },
  demo_rec_brand: {
    list: "free",
    show: "free",
    inspect: "free",
    create: "free",
    update: "free",
    duplicate: "free",
    preview: "free",
    use: "free",
  },
  demo_rec_browser: { open: "free", look: "free", act: "free", plan: "free", close: "free" },
  demo_rec_config: { show: "free", set: "free", unset: "free" },
  // start makes a draft render and then starts the annotation designer by itself: announced
  demo_rec_edit: { start: "announced", rerender: "free", status: "free", cancel: "free" },
  // the Director proposes how to fix what the user flagged; it cannot accept or apply
  demo_rec_qa: { context: "free", propose: "proposal", pending: "free", resolve: "free" },
  demo_rec_project: {
    status: "free",
    create: "free",
    open: "free",
    read_brief: "free",
    write_brief: "free",
    context: "free",
    note: "free",
    mark: "free",
    finding: "free",
    findings: "free",
    mark_finding: "free",
  },
  demo_rec_record: { start: "gated", status: "free", cancel: "free" },
  demo_rec_render: { start: "free", status: "free", cancel: "free", list: "free", qa: "free" },
  demo_rec_storyboard: { write: "free", get: "free" },
  demo_rec_take: { list: "free", analyze: "free", propose: "proposal" },
  demo_rec_tts: { check: "free", voices: "free", start: "gated", status: "free", cancel: "free" },
  demo_rec_vo: { template: "free", write: "free", get: "free" },
};

/** Job kinds the engine can start, and what guards each (a fragment that must appear in the file). */
const JOBS: Record<string, { file: string; guard: string | null }> = {
  record: { file: "tools/record.ts", guard: 'grants.consume("take"' },
  tts: { file: "tools/tts.ts", guard: 'grants.consume("tts"' },
  design: { file: "tools/designer.ts", guard: "design.announced" },
  edit: { file: "tools/edit.ts", guard: null }, // local ffmpeg: free
  render: { file: "tools/render.ts", guard: null }, // local ffmpeg: free
};

const SRC = path.join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) return f.name === "public" ? [] : sources(full);
    return f.name.endsWith(".ts") ? [full] : [];
  });
}

// biome-ignore lint/suspicious/noExplicitAny: a fake pi: only registerTool is used
type Loose = any;

async function registeredTools(): Promise<Map<string, Loose>> {
  const tools = new Map<string, Loose>();
  const pi = {
    on() {},
    registerCommand() {},
    registerTool: (t: Loose) => tools.set(t.name, t),
    appendEntry() {},
    sendUserMessage() {},
    sendMessage() {},
  };
  const mod = await import(`../index.ts?ratchet-${Date.now()}`);
  mod.default(pi);
  return tools;
}

const actionsOf = (tool: Loose): string[] => {
  const a = tool.parameters.properties.action;
  return a?.enum ?? [];
};

test("every action of every agent tool is classified; nothing approves", async () => {
  const tools = await registeredTools();
  assert.deepEqual([...tools.keys()].sort(), Object.keys(POLICY).sort(), "an unclassified tool");
  for (const [name, tool] of tools) {
    const policy = POLICY[name] ?? {};
    assert.deepEqual(
      actionsOf(tool).sort(),
      Object.keys(policy).sort(),
      `${name}: classify every action in POLICY (free, gated, announced or proposal)`,
    );
    for (const action of actionsOf(tool))
      assert.doesNotMatch(
        action,
        /accept|approve/i,
        `${name}.${action}: an agent tool may not approve; only the panel does`,
      );
  }
});

test("every job kind the engine starts is classified and guarded", () => {
  const found = new Map<string, string>();
  for (const file of sources(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/jobs\.start<[^>]*>\(\s*"([a-z]+)"/g))
      found.set(m[1] as string, path.relative(SRC, file));
  }
  assert.deepEqual(
    [...found.keys()].sort(),
    Object.keys(JOBS).sort(),
    "a new job kind: decide whether it spends, and guard it (src/grants.ts) or announce it",
  );
  for (const [kind, { file, guard }] of Object.entries(JOBS)) {
    assert.equal(found.get(kind), file, `${kind} is started from ${file}`);
    if (guard)
      assert.ok(
        fs.readFileSync(path.join(SRC, file), "utf8").includes(guard),
        `${file} must contain ${guard}: ${kind} spends and has to ask or announce itself`,
      );
  }
});

test("only the panel and the workdir approve: no tool, command or runtime code does", () => {
  const approving = /\b(approveVersion|acceptStage|acceptTake)\b|\bapprove\(/;
  const offenders = sources(SRC)
    .filter((f) => /[\\/](tools|commands)[\\/]|runtime\.ts$/.test(f))
    .filter((f) => approving.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f));
  assert.deepEqual(offenders, []);
});
