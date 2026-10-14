/**
 * S5 part 3 — stage chain (D30/D33) and project input log (D42/D43):
 * lineage from artifacts, chain-checked approvals, cascade reset, stale flags,
 * schema 1 → 2 migration, input log append/mark/fold, project context.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { projectContext } from "../src/workdir/context.ts";
import { formatInputs, markInput, readInputs, recordInput } from "../src/workdir/inputs.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { STAGES, type Stage, parentOf, stageStatus, stageVersions } from "../src/workdir/stages.ts";
import {
  acceptTake,
  acceptedTakeId,
  approve,
  approveStage,
  readState,
  setPhase,
} from "../src/workdir/state.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-stages-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Minimal artifacts: just enough for lineage (the stores aren't needed). */
const art = {
  storyboard(dir: string, v: number) {
    fs.mkdirSync(path.join(dir, "storyboard"), { recursive: true });
    fs.writeFileSync(path.join(dir, "storyboard", `v${v}.yaml`), `version: ${v}\n`);
  },
  take(dir: string, n: number, storyboardVersion: number) {
    const t = path.join(dir, "takes", `take-${String(n).padStart(3, "0")}`);
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(
      path.join(t, "take.json"),
      JSON.stringify({ take: path.basename(t), storyboardVersion }),
    );
  },
  vo(dir: string, v: number, take: number) {
    fs.mkdirSync(path.join(dir, "vo"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "vo", `script.v${v}.md`),
      `---\ntake: take-${String(take).padStart(3, "0")}\n---\n## 01-a\nhello\n`,
    );
  },
  json(dir: string, stage: "annotations" | "render", v: number, parent: number) {
    fs.mkdirSync(path.join(dir, stage), { recursive: true });
    const key = stage === "annotations" ? "vo" : "annotations";
    fs.writeFileSync(
      path.join(dir, stage, `v${v}.json`),
      JSON.stringify({ version: v, basedOn: { [key]: parent } }),
    );
  },
};

function project() {
  return ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" }).dir;
}

test("lineage is read from the artifacts themselves", () => {
  const dir = project();
  art.storyboard(dir, 1);
  art.storyboard(dir, 2);
  art.take(dir, 1, 1);
  art.take(dir, 2, 2);
  fs.mkdirSync(path.join(dir, "takes", "take-003")); // no take.json → not a recording version
  art.vo(dir, 1, 1);
  art.vo(dir, 2, 2);
  art.json(dir, "annotations", 1, 2);
  art.json(dir, "render", 1, 1);
  assert.deepEqual(stageVersions(dir, "storyboard"), [1, 2]);
  assert.deepEqual(stageVersions(dir, "recording"), [1, 2]);
  assert.deepEqual(stageVersions(dir, "vo"), [1, 2]);
  assert.equal(parentOf(dir, "storyboard", 1), undefined);
  assert.equal(parentOf(dir, "recording", 2), 2);
  assert.equal(parentOf(dir, "vo", 1), 1);
  assert.equal(parentOf(dir, "annotations", 1), 2);
  assert.equal(parentOf(dir, "render", 1), 1);
  assert.equal(parentOf(dir, "vo", 9), undefined);
});

test("approvals must chain up; a new upstream approval resets what no longer chains (cascade)", () => {
  const dir = project();
  art.storyboard(dir, 1);
  art.take(dir, 1, 1);
  art.vo(dir, 1, 1);
  assert.throws(() => acceptTake(dir, "take-001"), /approve the storyboard first/);
  assert.throws(() => approve(dir, "storyboard", 3), /storyboard v3 does not exist/);
  approve(dir, "storyboard", 1);
  setPhase(dir, "recording");
  assert.throws(() => approve(dir, "vo", 1), /approve the recording first/);
  acceptTake(dir, "take-001");
  assert.equal(readState(dir)?.phase, "vo-review");
  assert.equal(acceptedTakeId(readState(dir) as never), "take-001");
  approve(dir, "vo", 1);
  setPhase(dir, "voice-edit");

  // A VO based on another take can't be approved while take-001 is accepted.
  art.take(dir, 2, 1);
  art.vo(dir, 2, 2);
  assert.throws(
    () => approve(dir, "vo", 2),
    /voice-over v2 is based on recording take-002, but recording take-001 is approved/,
  );

  // Re-approving the same storyboard resets nothing.
  assert.deepEqual(approveStage(dir, "storyboard", 1).resets, []);

  // A new storyboard version: the recording (based on v1) and the VO below it are reset.
  art.storyboard(dir, 2);
  const { state, resets } = approveStage(dir, "storyboard", 2);
  assert.deepEqual(
    resets.map((r) => [r.stage, r.version]),
    [
      ["recording", 1],
      ["vo", 1],
    ],
  );
  assert.match(resets[0]?.reason ?? "", /based on storyboard v1, but storyboard v2 is approved/);
  assert.match(resets[1]?.reason ?? "", /recording is no longer approved/);
  assert.deepEqual(state.approved, { storyboard: 2 });
  assert.equal(state.phase, "recording", "phase moves back to the first stage that needs work");
  const ev = state.history.filter((h) => h.event === "approval-reset");
  assert.equal(ev.length, 2);
  assert.equal(ev[0]?.detail?.because, "storyboard v2");

  // Going back to v1 is allowed; the old recording is then approvable again (nothing was deleted).
  approve(dir, "storyboard", 1);
  acceptTake(dir, "take-002");
  approve(dir, "vo", 2);
  assert.deepEqual(readState(dir)?.approved, { storyboard: 1, recording: 2, vo: 2 });
});

test("stage status flags stale drafts (latest not based on the approved parent)", () => {
  const dir = project();
  art.storyboard(dir, 1);
  art.storyboard(dir, 2);
  art.take(dir, 1, 1);
  art.vo(dir, 1, 1);
  approve(dir, "storyboard", 2);
  const st = Object.fromEntries(
    stageStatus(dir, readState(dir)?.approved ?? {}).map((s) => [s.stage, s]),
  );
  assert.equal(st.storyboard?.stale, undefined);
  assert.match(st.recording?.stale ?? "", /based on storyboard v1; approved is storyboard v2/);
  assert.match(st.vo?.stale ?? "", /no approved recording/);
  assert.equal(st.annotations?.versions.length, 0);
});

test("invariant: no sequence of approvals leaves a downstream approval off its approved parent", () => {
  // Seeded random graphs and approval sequences.
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let round = 0; round < 25; round++) {
    const dir = fs.mkdtempSync(path.join(root, "r-"));
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        schema: 2,
        project: "r",
        app: "a",
        phase: "brief",
        createdAt: "x",
        updatedAt: "x",
        approved: {},
        history: [],
      }),
    );
    const n = { storyboard: 3, recording: 4, vo: 4, annotations: 3, render: 3 };
    for (let v = 1; v <= n.storyboard; v++) art.storyboard(dir, v);
    for (let v = 1; v <= n.recording; v++) art.take(dir, v, 1 + rnd(n.storyboard));
    for (let v = 1; v <= n.vo; v++) art.vo(dir, v, 1 + rnd(n.recording));
    for (let v = 1; v <= n.annotations; v++) art.json(dir, "annotations", v, 1 + rnd(n.vo));
    for (let v = 1; v <= n.render; v++) art.json(dir, "render", v, 1 + rnd(n.annotations));
    for (let step = 0; step < 40; step++) {
      const stage = STAGES[rnd(STAGES.length)] as Stage;
      try {
        approve(dir, stage, 1 + rnd(n[stage]));
      } catch {
        // refused approvals are fine; the invariant must still hold
      }
      const a = readState(dir)?.approved ?? {};
      for (const s of STAGES) {
        const parent = {
          storyboard: undefined,
          recording: "storyboard",
          vo: "recording",
          annotations: "vo",
          render: "annotations",
        }[s] as Stage | undefined;
        if (!parent || a[s] === undefined) continue;
        assert.equal(
          parentOf(dir, s, a[s] as number),
          a[parent],
          `round ${round} step ${step}: ${s} v${a[s]} off its parent`,
        );
      }
    }
  }
});

test("schema 1 → 2 migration: backup, accepted take → recording, inconsistent approvals dropped, reviews → input log", () => {
  const dir = project();
  art.storyboard(dir, 1);
  art.take(dir, 1, 1);
  art.take(dir, 2, 1);
  art.vo(dir, 1, 1);
  art.vo(dir, 2, 2);
  const v1 = {
    schema: 1,
    project: "p",
    app: "acme",
    phase: "voice-edit",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    approved: { storyboard: 1, vo: 1 }, // vo v1 is based on take-001, but take-002 is accepted
    acceptedTake: "take-002",
    reviews: {
      "1": {
        scenes: { "01-a": { status: "changes", note: "slower", at: "x" } },
        note: "calmer",
        submittedAt: "2026-10-02T10:00:00.000Z",
      },
    },
    voReviews: { "1": { scenes: { "01-a": { status: "approved", at: "x" } } } }, // draft: not imported
    history: [{ at: "2026-10-01T00:00:00.000Z", event: "project-created" }],
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(v1));
  const s = readState(dir);
  assert.ok(s);
  assert.equal(s.schema, 2);
  assert.deepEqual(
    s.approved,
    { storyboard: 1, recording: 2 },
    "the off-chain VO approval is dropped",
  );
  assert.equal((s as unknown as { acceptedTake?: string }).acceptedTake, undefined);
  assert.ok(fs.existsSync(path.join(dir, "state.v1.json")));
  const mig = s.history.at(-1);
  assert.equal(mig?.event, "state-migrated");
  assert.equal((mig?.detail?.resets as unknown[]).length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).schema,
    2,
    "persisted",
  );
  const inputs = readInputs(dir);
  assert.equal(inputs.length, 1, "only submitted reviews become inputs");
  assert.deepEqual(
    {
      stage: inputs[0]?.stage,
      version: inputs[0]?.version,
      source: inputs[0]?.source,
      kind: inputs[0]?.kind,
      at: inputs[0]?.at,
    },
    {
      stage: "storyboard",
      version: 1,
      source: "panel",
      kind: "review",
      at: "2026-10-02T10:00:00.000Z",
    },
  );
  assert.equal(inputs[0]?.text, "01-a: changes — slower\noverall: calmer");
  readState(dir);
  assert.equal(readInputs(dir).length, 1, "migration runs once");
});

test("input log: append-only, mark outdated / restore, torn lines, validation", () => {
  const dir = project();
  const a = recordInput(dir, {
    stage: "discovery",
    source: "command",
    kind: "direction",
    text: "focus on the churn view",
  });
  const b = recordInput(dir, {
    stage: "vo",
    version: 2,
    source: "chat",
    kind: "nudge",
    text: "calmer",
    refs: ["vo/script.v2.md"],
  });
  assert.equal(
    recordInput(dir, { stage: "vo", source: "chat", kind: "nudge", text: "   " }),
    undefined,
    "empty input ignored",
  );
  assert.deepEqual([a?.id, b?.id], ["in-0001", "in-0002"]);
  assert.throws(
    () => recordInput(dir, { stage: "nope" as never, source: "chat", kind: "nudge", text: "x" }),
    /unknown input stage/,
  );
  assert.throws(() => markInput(dir, "in-0001", true), /needs a reason/);
  assert.throws(() => markInput(dir, "in-0099", true, "x"), /no input in-0099/);

  markInput(dir, "in-0002", true, "user changed their mind");
  assert.deepEqual(
    readInputs(dir).map((e) => e.id),
    ["in-0001"],
  );
  const all = readInputs(dir, { includeOutdated: true });
  assert.equal(all[1]?.outdated?.reason, "user changed their mind");
  assert.equal(all[1]?.text, "calmer", "the entry itself is never edited");
  markInput(dir, "in-0002", false);
  assert.equal(readInputs(dir).length, 2, "restored");

  fs.appendFileSync(path.join(dir, "inputs.jsonl"), '{"id":"in-0003","at":"x","sta'); // torn write
  assert.equal(readInputs(dir).length, 2);
  const c = recordInput(dir, {
    stage: "brief",
    source: "agent",
    kind: "brief",
    text: "brief v2 saved",
  });
  assert.equal(c?.id, "in-0003");
  assert.match(formatInputs(readInputs(dir)), /\[brief\][\s\S]*\[discovery\][\s\S]*\[vo\]/);
});

test("project context: brief, lineage, active inputs only", () => {
  const dir = project();
  fs.writeFileSync(
    path.join(dir, "brief.md"),
    "# Demo brief: p\n\n- **Goal / key message:** churn is visible in a minute\n",
  );
  art.storyboard(dir, 1);
  approve(dir, "storyboard", 1);
  recordInput(dir, {
    stage: "storyboard",
    source: "chat",
    kind: "direction",
    text: "keep scene 2 under 20 s",
  });
  const gone = recordInput(dir, {
    stage: "storyboard",
    source: "chat",
    kind: "direction",
    text: "add a login scene",
  });
  markInput(dir, gone?.id as string, true, "login is out of scope");
  const ctx = projectContext(dir, "p");
  assert.match(ctx, /churn is visible in a minute/);
  assert.match(ctx, /storyboard\s+1 version\(s\), latest v1; approved v1/);
  assert.match(ctx, /keep scene 2 under 20 s/);
  assert.doesNotMatch(ctx, /add a login scene/);
  assert.match(ctx, /1 active, 1 marked outdated and left out/);
});
