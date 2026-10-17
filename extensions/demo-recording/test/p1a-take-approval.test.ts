/**
 * P1a PR 1 (F15): the agent can't approve a recording. `demo_rec_take propose` leaves a visible
 * suggestion; only the panel's Approve & use changes `accepted`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventBus } from "../src/bus.ts";
import { registerTakeTool } from "../src/tools/take.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { acceptedTakeId, readState } from "../src/workdir/state.ts";

const SRC = path.join(import.meta.dirname, "..", "src");

// biome-ignore lint/suspicious/noExplicitAny: a fake pi and runtime: only what the tool touches
type Loose = any;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1a-take-"));
  const p = ensureProject(root, { project: "demo", appName: "Demo", appUrl: "https://x.example" });
  const takeDir = path.join(p.dir, "takes", "take-001");
  fs.mkdirSync(takeDir, { recursive: true });
  fs.writeFileSync(
    path.join(takeDir, "take.json"),
    JSON.stringify({ take: "take-001", status: "ok", storyboardVersion: 1, durationMs: 1000 }),
  );
  const bus = new EventBus();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  bus.subscribe((e: Loose) => events.push({ type: e.type, data: e.data }));
  const rt = {
    bindUi() {},
    requireProject: () => p,
    bus,
  } as Loose;
  const tools: Loose[] = [];
  registerTakeTool({ registerTool: (t: unknown) => tools.push(t) } as Loose, rt);
  return { p, tool: tools[0], events };
}

test("propose records a suggestion and approves nothing", async () => {
  const { p, tool, events } = fixture();
  const r = await tool.execute("id", { action: "propose" }, undefined, undefined, {});
  assert.match(r.content[0].text, /Suggested take-001 for approval\. You cannot approve it/);
  assert.equal(acceptedTakeId(readState(p.dir) ?? p.state), undefined, "nothing is accepted");
  const e = events.find((x) => x.type === "take.proposed");
  assert.ok(e, "a take.proposed event is published");
  assert.equal(e.data.by, "agent");
  assert.equal(
    events.some((x) => x.type === "take.accepted"),
    false,
  );
});

test("propose refuses a take that is not complete", async () => {
  const { p, tool } = fixture();
  fs.writeFileSync(
    path.join(p.dir, "takes", "take-001", "take.json"),
    JSON.stringify({ take: "take-001", status: "failed", storyboardVersion: 1 }),
  );
  await assert.rejects(
    tool.execute("id", { action: "propose", take: "take-001" }, undefined, undefined, {}),
    /not complete/,
  );
});

test("the tool offers no accept action, and no tool code approves", () => {
  const { tool } = fixture();
  const values = JSON.stringify(tool.parameters.properties.action);
  assert.doesNotMatch(values, /accept/);
  assert.match(values, /propose/);
  // approving a recording is the panel's route; no tool may call acceptTake
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (/\.ts$/.test(f.name) && /\bacceptTake\(/.test(fs.readFileSync(full, "utf8")))
        offenders.push(path.relative(SRC, full));
    }
  };
  walk(path.join(SRC, "tools"));
  assert.deepEqual(offenders, [], "no agent tool may call acceptTake");
});
