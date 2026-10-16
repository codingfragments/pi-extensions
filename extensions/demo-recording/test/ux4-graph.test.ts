/**
 * UX4 (D112, D113): the project graph. Computed from the files, read-only, only recorded links,
 * statuses kept separate, unknown links said, cached until a record changes, and fast enough for a
 * large project. On the seeded project (test/helpers/panel-seed.ts) and on a generated 300-node one.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { buildGraph, projectGraph } from "../src/graph/build.ts";
import { applyVersionAction, planVersionAction } from "../src/panel/version-actions.ts";
import { normalizeOptions } from "../src/render/run.ts";
import { saveRecord, startRecord } from "../src/render/store.ts";
import { Runtime } from "../src/runtime.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { approve, readState } from "../src/workdir/state.ts";
import { bigProject } from "./helpers/big-project.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const graphOf = (dir: string, slug = "keycraft") =>
  buildGraph(dir, slug, readState(dir) as NonNullable<ReturnType<typeof readState>>);
const node = (g: ReturnType<typeof graphOf>, id: string) => {
  const n = g.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id}`);
  return n;
};
const act = (
  dir: string,
  stage: Parameters<typeof planVersionAction>[2]["stage"],
  version: number,
  intent: Parameters<typeof planVersionAction>[2]["intent"],
) => {
  const state = readState(dir) as NonNullable<ReturnType<typeof readState>>;
  return applyVersionAction(dir, {
    stage,
    version,
    intent,
    token: planVersionAction(dir, state, { stage, version, intent }).token,
  });
};

test("graph: the versions, QA nodes and a draft group, with the production line and the stages", () => {
  const { dir } = seedPanelProject();
  const g = graphOf(dir);
  assert.deepEqual(
    g.stages.map((s) => s.stage),
    ["storyboard", "recording", "vo", "annotations", "render"],
  );
  assert.deepEqual(g.line, {
    storyboard: "storyboard:1",
    recording: "recording:1",
    vo: "vo:1",
    annotations: "annotations:1",
    render: "render:2",
  });
  const ids = g.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, [
    "annotations:1",
    "drafts:render:annotations:1",
    "qa:render:1",
    "qa:render:2",
    "recording:1",
    "render:1",
    "render:2",
    "render:3",
    "render:4",
    "render:5",
    "render:6",
    "render:7",
    "storyboard:1",
    "storyboard:2",
    "vo:1",
    "vo:2",
  ]);
  assert.equal(node(g, "storyboard:2").label, "Storyboard v2");
  assert.equal(node(g, "recording:1").label, "Recording take-001");
  assert.equal(node(g, "render:2").label, "Final render v2");
  assert.equal(node(g, "render:5").label, "Draft render v5");
  assert.equal(node(g, "storyboard:2").meta, "3 scenes");
  assert.equal(node(g, "annotations:1").meta, "3 enabled");
  assert.equal(node(g, "drafts:render:annotations:1").label, "Drafts ×4");
});

test("graph: only recorded links, and the direction says who depends on whom", () => {
  const { dir } = seedPanelProject();
  const g = graphOf(dir);
  const dep = g.edges
    .filter((e) => e.rel === "depends-on")
    .map((e) => `${e.from} → ${e.to}`)
    .sort();
  assert.deepEqual(dep, [
    "annotations:1 → drafts:render:annotations:1",
    "annotations:1 → render:1",
    "annotations:1 → render:2",
    "annotations:1 → render:3",
    "annotations:1 → render:4",
    "annotations:1 → render:5",
    "annotations:1 → render:6",
    "annotations:1 → render:7",
    "recording:1 → vo:1",
    "recording:1 → vo:2",
    "storyboard:1 → recording:1",
    "vo:1 → annotations:1",
  ]);
  assert.ok(
    !dep.some((e) => e.includes("storyboard:2")),
    "storyboard v2 is newer, not a parent of anything",
  );
  assert.deepEqual(
    g.edges
      .filter((e) => e.rel === "contains")
      .map((e) => `${e.from} ⊃ ${e.to}`)
      .sort(),
    ["render:1 ⊃ qa:render:1", "render:2 ⊃ qa:render:2"],
  );
  assert.ok(
    g.nodes.every((n) => n.unknownLink === null),
    "every link of the seeded project is recorded",
  );
});

test("graph: statuses are separate fields, never one merged label", () => {
  const { dir } = seedPanelProject();
  const g = graphOf(dir);
  const sb2 = node(g, "storyboard:2");
  assert.deepEqual(
    [sb2.approved, sb2.usable, sb2.inLine, sb2.draft, sb2.review],
    [false, false, false, true, "waiting"],
  );
  const vo1 = node(g, "vo:1");
  assert.deepEqual(
    [vo1.approved, vo1.usable, vo1.inLine, vo1.draft, vo1.review, vo1.blocked],
    [true, true, true, false, null, null],
  );
  assert.equal(
    node(g, "vo:2").review,
    "waiting",
    "a draft newer than the newest approved one waits for review",
  );
  assert.equal(node(g, "render:3").availability, "deleted");
  assert.equal(node(g, "render:2").availability, "present");
  assert.deepEqual(node(g, "qa:render:1").qa, {
    status: "blocked",
    blocking: 1,
    warnings: 1,
    confirmed: 0,
  });
  assert.equal(node(g, "qa:render:1").label, "QA: 1 blocking");
  assert.equal(node(g, "qa:render:2").label, "QA passed");
  assert.equal(
    g.nodes.some((n) => n.id === "qa:render:3"),
    false,
    "no QA result, no QA node",
  );
  // the draft group folds its members, and the members know it
  const group = node(g, "drafts:render:annotations:1");
  assert.deepEqual(group.members, ["render:4", "render:5", "render:6", "render:7"]);
  assert.ok(group.members?.every((m) => node(g, m).group === group.id));
  assert.deepEqual(node(g, "render:4").render?.kind, "draft");
});

test("graph: an approval taken back leaves what depends on it approved but blocked, with the reason", () => {
  const { dir } = seedPanelProject();
  act(dir, "recording", 1, "withdraw");
  const g = graphOf(dir);
  const vo1 = node(g, "vo:1");
  assert.deepEqual(
    [vo1.approved, vo1.usable, vo1.blocked],
    [true, false, "recording take-001 is not approved"],
  );
  assert.equal(node(g, "annotations:1").blocked, "recording take-001 is not approved");
  assert.equal(node(g, "recording:1").approved, false);
  assert.equal(g.line.recording, undefined, "and it left the production line");
});

test("graph: a parent that is not recorded is said, not guessed; a draft before annotations links to its voice-over", () => {
  const { dir } = seedPanelProject();
  const mk = (basedOn: { annotations?: number }, voVersion: number) => {
    const rec = startRecord(dir, {
      kind: "draft",
      basedOn,
      timeline: 1,
      voVersion,
      take: "take-001",
      by: "edit",
      options: normalizeOptions({}),
      brands: ["neutral"],
      size: { width: 960, height: 540 },
    });
    rec.status = "done";
    saveRecord(dir, rec);
    return rec.version;
  };
  const early = mk({}, 1); // before annotations existed: records the voice-over it came from
  const lost = mk({}, 99); // records a voice-over that does not exist
  // a take whose take.json does not say which storyboard it came from
  const take = path.join(dir, "takes", "take-002");
  fs.mkdirSync(take, { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({ take: "take-002", status: "ok" }),
  );
  const g = graphOf(dir);
  const direct = g.edges.find((e) => e.to === `render:${early}`);
  assert.deepEqual([direct?.from, direct?.direct, direct?.rel], ["vo:1", true, "depends-on"]);
  assert.equal(node(g, `render:${early}`).unknownLink, null);
  const nl = node(g, `render:${lost}`);
  assert.match(nl.unknownLink ?? "", /does not record the annotations or voice-over/);
  assert.equal(
    g.edges.some((e) => e.to === nl.id),
    false,
    "no edge is invented",
  );
  const t2 = node(g, "recording:2");
  assert.match(t2.unknownLink ?? "", /does not record a storyboard version/);
  assert.equal(
    g.edges.some((e) => e.to === "recording:2"),
    false,
  );
});

test("graph: cached until a record changes; the revision tells when what is shown changed", () => {
  const { dir, slug } = seedPanelProject();
  const a = projectGraph(dir, slug);
  const b = projectGraph(dir, slug);
  assert.equal(a, b, "unchanged files: the same graph");
  assert.equal(
    buildGraph(dir, slug, readState(dir) as NonNullable<ReturnType<typeof readState>>).rev,
    a.rev,
    "the revision is a function of what is shown",
  );
  act(dir, "storyboard", 2, "approve-only");
  const c = projectGraph(dir, slug);
  assert.notEqual(c, a, "a state change invalidates it");
  assert.notEqual(c.rev, a.rev);
  assert.equal(node(c, "storyboard:2").approved, true);
  // a render record edited in place (same size) is noticed through its time
  const file = path.join(dir, "render", "v2.json");
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
  assert.notEqual(projectGraph(dir, slug), c);
});

test("graph: a project of about 300 nodes builds quickly", () => {
  const big = bigProject();
  try {
    const state = readState(big.dir) as NonNullable<ReturnType<typeof readState>>;
    const t0 = performance.now();
    const g = buildGraph(big.dir, big.slug, state);
    const ms = performance.now() - t0;
    assert.ok(g.nodes.length >= 290, `a large graph (${g.nodes.length} nodes)`);
    assert.ok(g.edges.length > 250);
    console.log(`graph: ${g.nodes.length} nodes, ${g.edges.length} edges in ${ms.toFixed(0)} ms`);
    assert.ok(ms < 2500, `built in ${ms.toFixed(0)} ms`);
    // a second call from the cache is far cheaper
    projectGraph(big.dir, big.slug, state);
    const t1 = performance.now();
    projectGraph(big.dir, big.slug, state);
    assert.ok(performance.now() - t1 < ms, "cached");
  } finally {
    fs.rmSync(big.root, { recursive: true, force: true });
  }
});

test("route: GET /api/graph serves it and writes nothing", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  try {
    const before = fs.readFileSync(path.join(seed.dir, "state.json"), "utf8");
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/graph`, {
      headers: { authorization: `Bearer ${panel.token}` },
    });
    assert.equal(res.status, 200);
    const g = (await res.json()) as {
      project: string;
      nodes: unknown[];
      line: Record<string, string>;
      rev: string;
    };
    assert.equal(g.project, "keycraft");
    assert.equal(g.nodes.length, 16);
    assert.equal(g.line.vo, "vo:1");
    assert.match(g.rev, /^[0-9a-f]{12}$/);
    assert.equal(fs.readFileSync(path.join(seed.dir, "state.json"), "utf8"), before);
    const noToken = await fetch(`http://127.0.0.1:${panel.port}/api/graph`);
    assert.equal(noToken.status, 401, "like every API route, it needs the token");
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
