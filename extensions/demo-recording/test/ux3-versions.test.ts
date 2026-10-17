/**
 * UX3 (D118): the version actions. Approve & use, Approve only, Use for next steps and Withdraw approval
 * each have a free plan with an explicit consequence for the production line, and are applied once, and
 * only if the project is still as planned. Browsing (the history) writes nothing. Engine and routes, on
 * the seeded project (test/helpers/panel-seed.ts): storyboard v1 approved and v2 a newer draft, take-001,
 * voice-over v1 approved and v2 a newer draft, annotations v1 approved, finals v1 (QA-blocked), v2
 * (passed, approved) and v3 (files deleted), drafts v4–v7. The line runs through all of it to final v2.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import {
  StalePlanError,
  applyVersionAction,
  planVersionAction,
  versionHistory,
} from "../src/panel/version-actions.ts";
import { Runtime } from "../src/runtime.ts";
import { approveVersion, readState } from "../src/workdir/state.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const plan = (
  dir: string,
  stage: Parameters<typeof planVersionAction>[2]["stage"],
  version: number,
  intent: Parameters<typeof planVersionAction>[2]["intent"],
) =>
  planVersionAction(dir, readState(dir) as NonNullable<ReturnType<typeof readState>>, {
    stage,
    version,
    intent,
  });
const act = (
  dir: string,
  stage: Parameters<typeof planVersionAction>[2]["stage"],
  version: number,
  intent: Parameters<typeof planVersionAction>[2]["intent"],
) =>
  applyVersionAction(dir, {
    stage,
    version,
    intent,
    token: plan(dir, stage, version, intent).token,
  });

test("history: every version with its source, approval and where it stands, newest first; reading it writes nothing", () => {
  const { dir } = seedPanelProject();
  const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
  const state = readState(dir) as NonNullable<ReturnType<typeof readState>>;
  const sb = versionHistory(dir, state, "storyboard");
  assert.deepEqual(
    sb.map((r) => [r.short, r.approved, r.inLine, r.basedOn]),
    [
      ["v2", false, false, null],
      ["v1", true, true, null],
    ],
  );
  const vo = versionHistory(dir, state, "vo");
  assert.deepEqual(
    vo.map((r) => [r.short, r.approved, r.inLine, r.basedOn?.short, r.onInput]),
    [
      ["v2", false, false, "take-001", true],
      ["v1", true, true, "take-001", true],
    ],
  );
  const renders = versionHistory(dir, state, "render");
  assert.equal(renders.length, 7);
  assert.deepEqual(renders.find((r) => r.version === 2)?.kind, "final");
  assert.equal(renders.find((r) => r.version === 5)?.kind, "draft");
  assert.equal(renders.find((r) => r.version === 2)?.inLine, true);
  assert.equal(
    fs.readFileSync(path.join(dir, "state.json"), "utf8"),
    before,
    "browsing changes nothing",
  );
});

test("plan: Approve & use shows the production line before and after, including what leaves it", () => {
  const { dir } = seedPanelProject();
  const p = plan(dir, "storyboard", 2, "approve-use");
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.approval, { before: false, after: true });
  assert.equal(
    p.line.before,
    "storyboard v1 → recording take-001 → voice-over v1 → annotations v1 → render v2",
  );
  assert.equal(p.line.after, "storyboard v2");
  // downstream selections change, and the plan says which
  assert.deepEqual(
    p.line.changes.map((c) => [c.stage, c.from, c.to]),
    [
      ["storyboard", "v1", "v2"],
      ["recording", "take-001", null],
      ["vo", "v1", null],
      ["annotations", "v1", null],
      ["render", "v2", null],
    ],
  );
  // a plan changes nothing
  assert.equal(readState(dir)?.line.storyboard, 1);
});

test("plan: Approve only leaves the line exactly as it is, or says why it can't", () => {
  const { dir } = seedPanelProject();
  const alt = plan(dir, "storyboard", 2, "approve-only");
  assert.deepEqual(alt.blockers, []);
  assert.deepEqual(alt.line.changes, [], "an alternative: the line does not move");
  assert.equal(alt.line.before, alt.line.after);
  assert.deepEqual(alt.approval, { before: false, after: true });

  // nothing on the line for the recording stage: approving would make it the line
  act(dir, "recording", 1, "withdraw");
  const first = plan(dir, "recording", 1, "approve-only");
  assert.match(
    first.blockers.join(" "),
    /Approve only is not available.*would make it the line.*Approve & use/,
  );
  assert.deepEqual(first.line.changes, [], "the refused plan shows no change");
  // and Approve & use is fine
  assert.deepEqual(plan(dir, "recording", 1, "approve-use").blockers, []);
  assert.throws(
    () => approveVersion(dir, "recording", 1, "only"),
    /cannot be approved without changing the production line/,
  );
  assert.equal(
    readState(dir)?.accepted.recording?.["1"],
    undefined,
    "the refused action wrote nothing",
  );
});

test("apply: Approve & use is one state write; Approve only keeps the line; nothing approved elsewhere is touched", () => {
  const { dir } = seedPanelProject();
  const historyBefore = readState(dir)?.history.length ?? 0;
  const only = act(dir, "storyboard", 2, "approve-only");
  assert.deepEqual(only.state.line, readState(dir)?.line);
  assert.equal(readState(dir)?.line.storyboard, 1, "the line stayed on v1");
  assert.deepEqual(Object.keys(readState(dir)?.accepted.storyboard ?? {}), ["1", "2"]);
  assert.equal(readState(dir)?.history.length, historyBefore + 1, "one entry, one write");

  const used = act(dir, "storyboard", 2, "use");
  assert.equal(used.state.line.storyboard, 2);
  assert.equal(
    used.state.line.recording,
    undefined,
    "take-001 is based on v1, so it leaves the line…",
  );
  assert.ok(readState(dir)?.accepted.recording?.["1"], "…but it stays approved");
  assert.ok(readState(dir)?.accepted.vo?.["1"] && readState(dir)?.accepted.annotations?.["1"]);
  // back again: the whole chain returns
  act(dir, "storyboard", 1, "use");
  assert.deepEqual(readState(dir)?.line, {
    storyboard: 1,
    recording: 1,
    vo: 1,
    annotations: 1,
    render: 2,
  });
});

test("apply: a plan made for another state of the project is refused, never applied", () => {
  const { dir } = seedPanelProject();
  const stale = plan(dir, "vo", 2, "approve-use");
  act(dir, "storyboard", 2, "approve-only"); // the project moves on
  assert.throws(
    () =>
      applyVersionAction(dir, {
        stage: "vo",
        version: 2,
        intent: "approve-use",
        token: stale.token,
      }),
    StalePlanError,
  );
  assert.equal(readState(dir)?.accepted.vo?.["2"], undefined, "nothing was written");
  // a fresh plan works
  assert.doesNotThrow(() => act(dir, "vo", 2, "approve-use"));
});

test("plan: Use for next steps only for an approved, usable version that is not already on the line", () => {
  const { dir } = seedPanelProject();
  assert.match(plan(dir, "vo", 2, "use").blockers.join(" "), /voice-over v2 is not approved/);
  assert.match(plan(dir, "vo", 1, "use").blockers.join(" "), /already in the production line/);
  assert.match(plan(dir, "vo", 1, "approve-use").blockers.join(" "), /already approved/);
  // blocked by dependency: withdraw the storyboard and what is built on it can't be used
  act(dir, "storyboard", 1, "withdraw");
  const blocked = plan(dir, "recording", 1, "use");
  assert.match(blocked.blockers.join(" "), /blocked by dependency: storyboard v1 is not approved/);
  assert.equal(
    versionHistory(dir, readState(dir) as NonNullable<ReturnType<typeof readState>>, "recording")[0]
      ?.blocked,
    "storyboard v1 is not approved",
  );
});

test("plan and apply: Withdraw approval lists what becomes blocked by dependency, keeps every file, and can be undone", () => {
  const { dir } = seedPanelProject();
  const p = plan(dir, "recording", 1, "withdraw");
  assert.deepEqual(p.blocked.map((b) => b.label).sort(), [
    "annotations v1",
    "render v2",
    "voice-over v1",
  ]);
  assert.deepEqual(
    p.line.changes.map((c) => c.stage),
    ["recording", "vo", "annotations", "render"],
  );
  const files = fs.readdirSync(path.join(dir, "vo"));
  const done = act(dir, "recording", 1, "withdraw");
  assert.equal(done.orphaned.length, 3);
  assert.ok(readState(dir)?.accepted.vo?.["1"], "voice-over v1 is still approved, only blocked");
  assert.deepEqual(fs.readdirSync(path.join(dir, "vo")), files, "no file was deleted");
  // approving the take again brings everything back
  act(dir, "recording", 1, "approve-use");
  assert.deepEqual(readState(dir)?.line, {
    storyboard: 1,
    recording: 1,
    vo: 1,
    annotations: 1,
    render: 2,
  });
});

test("gates: the checks that decided what may be approved still decide it", () => {
  const { dir } = seedPanelProject();
  assert.match(
    plan(dir, "render", 1, "approve-use").blockers.join(" "),
    /hard stop/i,
    "the QA gate",
  );
  assert.match(
    plan(dir, "render", 3, "approve-use").blockers.join(" "),
    /already approved|no files any more/,
  );
  assert.match(
    plan(dir, "render", 5, "approve-use").blockers.join(" "),
    /only final renders can be approved/,
  );
  assert.match(plan(dir, "storyboard", 9, "approve-use").blockers.join(" "), /does not exist/);
  // a version whose parent is not approved can't be approved
  act(dir, "storyboard", 1, "withdraw");
  assert.match(
    plan(dir, "recording", 1, "approve-use").blockers.join(" "),
    /already approved|not accepted|storyboard/,
  );
});

// ---------------------------------------------------------------- routes

async function setup() {
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
  const base = `http://127.0.0.1:${panel.port}`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async (n: string) =>
    (await (await fetch(`${base}/api/${n}`, { headers: auth })).json()) as Record<string, unknown>;
  const post = async (n: string, body: unknown) => {
    const res = await fetch(`${base}/api/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  rt.bus.subscribe((e) => events.push(e));
  return {
    seed,
    rt,
    turns,
    notes,
    get,
    post,
    events,
    close: async () => {
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    },
  };
}

test("routes: who is told. Approve & use starts a turn; the rest leave a quiet note. Browsing and planning tell no one", async () => {
  const { seed, turns, notes, get, post, events, close } = await setup();
  try {
    const stateBefore = fs.readFileSync(path.join(seed.dir, "state.json"), "utf8");
    const h = (await get("history?stage=vo")) as { rows: { short: string }[] };
    assert.deepEqual(
      h.rows.map((r) => r.short),
      ["v2", "v1"],
    );
    const planned = await post("version-plan", {
      stage: "storyboard",
      version: 2,
      intent: "approve-only",
    });
    assert.equal(planned.status, 200);
    assert.deepEqual(planned.json.blockers, []);
    assert.equal(
      fs.readFileSync(path.join(seed.dir, "state.json"), "utf8"),
      stateBefore,
      "history and plan write nothing",
    );
    assert.deepEqual([turns.length, notes.length], [0, 0], "and tell no one");

    // approve only: quiet note, no turn
    const only = await post("version-act", {
      stage: "storyboard",
      version: 2,
      intent: "approve-only",
      token: planned.json.token,
    });
    assert.equal(only.status, 200);
    assert.deepEqual([turns.length, notes.length], [0, 1]);
    assert.match(
      notes[0] ?? "",
      /APPROVED storyboard v2 .* as an alternative and left the production line unchanged: storyboard v1/,
    );
    assert.ok(events.some((e) => e.type === "storyboard.approved" && e.data?.onLine === false));

    // approve & use: one turn, from the final state
    const p2 = await post("version-plan", { stage: "vo", version: 2, intent: "approve-use" });
    const used = await post("version-act", {
      stage: "vo",
      version: 2,
      intent: "approve-use",
      token: p2.json.token,
    });
    assert.equal(used.status, 200);
    assert.deepEqual([turns.length, notes.length], [1, 1]);
    assert.match(
      turns[0] ?? "",
      /Voice-over script v2 .* APPROVED[\s\S]*Production line: storyboard v1 → recording take-001 → voice-over v2/,
    );
    assert.equal(readState(seed.dir)?.line.vo, 2);

    // use for next steps and withdraw: quiet notes
    const p3 = await post("version-plan", { stage: "vo", version: 1, intent: "use" });
    await post("version-act", { stage: "vo", version: 1, intent: "use", token: p3.json.token });
    assert.match(notes.at(-1) ?? "", /switched the production line .* voice-over v1/);
    const p4 = await post("version-plan", { stage: "storyboard", version: 2, intent: "withdraw" });
    await post("version-act", {
      stage: "storyboard",
      version: 2,
      intent: "withdraw",
      token: p4.json.token,
    });
    assert.match(notes.at(-1) ?? "", /WITHDREW the approval of storyboard v2/);
    assert.equal(turns.length, 1, "only Approve & use started a turn");
  } finally {
    await close();
  }
});

test("routes: a stale plan is answered with a fresh plan, not an error; a refused action is a 400 and writes nothing", async () => {
  const { seed, post, close } = await setup();
  try {
    const p = await post("version-plan", { stage: "vo", version: 2, intent: "approve-use" });
    await post("version-act", {
      stage: "storyboard",
      version: 2,
      intent: "approve-only",
      token: (
        await post("version-plan", { stage: "storyboard", version: 2, intent: "approve-only" })
      ).json.token,
    });
    const stale = await post("version-act", {
      stage: "vo",
      version: 2,
      intent: "approve-use",
      token: p.json.token,
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.json.stale, true);
    assert.notEqual(
      (stale.json.plan as { token: string }).token,
      p.json.token,
      "a fresh plan to look at",
    );
    assert.equal(readState(seed.dir)?.accepted.vo?.["2"], undefined);

    const refused = await post("version-act", {
      stage: "render",
      version: 1,
      intent: "approve-use",
      token: (await post("version-plan", { stage: "render", version: 1, intent: "approve-use" }))
        .json.token,
    });
    assert.equal(refused.status, 400);
    assert.match(String(refused.json.error), /hard stop/i);
    assert.equal(
      (await post("version-plan", { stage: "nowhere", version: 1, intent: "use" })).status,
      400,
    );
    assert.equal(
      (await post("version-plan", { stage: "vo", version: 1, intent: "teleport" })).status,
      400,
    );
  } finally {
    await close();
  }
});
