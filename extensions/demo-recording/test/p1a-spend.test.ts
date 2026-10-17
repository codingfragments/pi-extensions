/**
 * P1a PR 3 (F17): the Director asks before it spends. A voice synthesis or a take that the
 * Director starts on its own is refused with the estimate and filed as a request; the user's
 * click in a dialog (Re-record) is the permission; the approval messages say to ask, not to go on.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { approvalMessage } from "../src/panel/bridge.ts";
import { Runtime } from "../src/runtime.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import { registerTtsTool, startTts } from "../src/tools/tts.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { acceptTake, approve } from "../src/workdir/state.ts";
import { makeProject } from "./helpers/annotation-project.ts";

const STORYBOARD = `version: 1
app: x
start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }
`;

// biome-ignore lint/suspicious/noExplicitAny: a fake pi: only registerTool is used
type Loose = any;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-spend-"));
  const sent: string[] = [];
  const rt = new Runtime(
    () => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }),
    { sendUserMessage: (t) => sent.push(t), sendMessage: () => {} },
  );
  const p = ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
  fs.cpSync(makeProject(), p.dir, { recursive: true });
  writeStoryboard(p.dir, STORYBOARD as never);
  approve(p.dir, "storyboard", 1);
  acceptTake(p.dir, "take-001");
  approve(p.dir, "vo", 1);
  rt.setActiveProject("p");
  const events: { type: string; data: Record<string, unknown> }[] = [];
  rt.bus.subscribe((e: Loose) => events.push({ type: e.type, data: e.data }));
  return { root, rt, p, sent, events };
}

test("the voice tool refuses without a grant, files a request and starts nothing", async () => {
  const { rt, events } = setup();
  const tools: Loose[] = [];
  registerTtsTool({ registerTool: (t: unknown) => tools.push(t) } as Loose, rt);
  const r = await tools[0].execute("1", { action: "start" }, undefined, undefined, {});
  const said = r.content[0].text as string;
  assert.match(said, /^NOT STARTED\./);
  assert.match(said, /synthesize voice-over v1/);
  assert.match(said, /STOP/);
  assert.equal(rt.jobs.latest("tts"), undefined, "no job started");
  const open = rt.grants.pending("p");
  assert.equal(open.length, 1);
  assert.deepEqual([open[0]?.kind, open[0]?.target], ["tts", "vo:1"]);
  const asked = events.find((e) => e.type === "confirm.requested");
  assert.ok(asked, "the panel is told");
  assert.equal(asked.data.id, open[0]?.id);
  // asking twice does not pile up requests
  await tools[0].execute("2", { action: "start" }, undefined, undefined, {});
  assert.equal(rt.grants.pending("p").length, 1);
});

test("the engine start refuses an agent start without a grant, even if a tool forgot to ask", () => {
  const { rt } = setup();
  assert.throws(() => startTts(rt, 1, { by: "agent" }), /not allowed: tts vo:1/);
  assert.equal(rt.jobs.latest("tts"), undefined);
});

test("Re-record: the user's click is the permission for exactly that take", async () => {
  const { rt, sent } = setup();
  assert.equal(rt.grants.has("take", "p", "storyboard:1"), false);
  const post = rt.routeTables().post;
  await post.rerecord?.({ storyboard: 1 });
  assert.equal(rt.grants.has("take", "p", "storyboard:1"), true);
  assert.equal(rt.grants.has("take", "p", "storyboard:2"), false, "only that storyboard");
  assert.match(sent.at(-1) ?? "", /ALLOWED the recording/);
});

test("the approval messages tell the Director to ask and stop, not to go on", () => {
  const sb = approvalMessage("p", "storyboard", 2);
  assert.match(sb, /asks the user to allow it/);
  assert.match(sb, /stop until they answer/);
  const vo = approvalMessage("p", "vo", 3);
  assert.match(vo, /bills voice credits/);
  assert.match(vo, /stop until they answer/);
  assert.doesNotMatch(`${sb}${vo}`, /is unlocked \(demo_rec/);
});
