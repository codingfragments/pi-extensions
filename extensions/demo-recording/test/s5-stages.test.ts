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
import {
  STAGES,
  type Stage,
  acceptedVersions,
  formatLine,
  formatStageStatus,
  isUsable,
  orphanReason,
  parentOf,
  stageStatus,
  stageVersions,
} from "../src/workdir/stages.ts";
import {
  type ProjectState,
  acceptTake,
  approve,
  readState,
  requireSelected,
  selectStage,
  setPhase,
  unacceptStage,
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

test("accept several versions; accepting resets nothing; the working line follows the latest decision", () => {
  const dir = project();
  art.storyboard(dir, 1);
  art.storyboard(dir, 2);
  art.take(dir, 1, 1);
  art.take(dir, 2, 2);
  art.take(dir, 3, 2);
  art.vo(dir, 1, 2);
  art.vo(dir, 2, 3);
  assert.throws(() => acceptTake(dir, "take-002"), /based on storyboard v2, which is not accepted/);
  assert.throws(() => approve(dir, "storyboard", 9), /storyboard v9 does not exist/);
  approve(dir, "storyboard", 1);
  approve(dir, "storyboard", 2);
  let st = readState(dir) as ProjectState;
  assert.deepEqual(
    acceptedVersions(st.accepted, "storyboard"),
    [1, 2],
    "both storyboards accepted",
  );
  assert.equal(st.line.storyboard, 2, "the most recent acceptance is the working line");
  setPhase(dir, "recording");
  acceptTake(dir, "take-002");
  acceptTake(dir, "take-003");
  approve(dir, "vo", 1); // on take-002 — not on the line (take-003 is)
  st = readState(dir) as ProjectState;
  assert.deepEqual(acceptedVersions(st.accepted, "recording"), [2, 3]);
  assert.deepEqual(
    st.line,
    { storyboard: 2, recording: 3 },
    "vo v1 is accepted, but not on take-003's line",
  );
  approve(dir, "vo", 2);
  st = readState(dir) as ProjectState;
  assert.deepEqual(st.line, { storyboard: 2, recording: 3, vo: 2 });
  assert.equal(st.phase, "vo-review", "accepting a take on the line moves recording → vo-review");
  assert.equal(
    st.history.filter((h: { event: string }) => h.event === "approval-reset").length,
    0,
    "nothing is ever reset",
  );

  // Switch the working line to take-002: its accepted VO follows.
  selectStage(dir, "recording", 2);
  assert.deepEqual(readState(dir)?.line, { storyboard: 2, recording: 2, vo: 1 });
  assert.equal(requireSelected(dir, readState(dir) as ProjectState, "vo"), 1);
  // Selecting take-001 needs it accepted; then the line moves up to storyboard v1.
  assert.throws(() => selectStage(dir, "recording", 1), /take-001 is not accepted/);
  acceptTake(dir, "take-001");
  selectStage(dir, "recording", 1);
  assert.deepEqual(
    readState(dir)?.line,
    { storyboard: 1, recording: 1 },
    "ancestors follow, no VO on take-001",
  );
  assert.throws(
    () => requireSelected(dir, readState(dir) as ProjectState, "vo"),
    /no accepted voice-over on the working line/,
  );
  assert.equal(
    requireSelected(dir, readState(dir) as ProjectState, "vo", 2),
    2,
    "an explicit usable version is allowed",
  );
});

test("un-accept: children stay accepted but become orphaned (not usable), the line re-picks", () => {
  const dir = project();
  art.storyboard(dir, 1);
  art.take(dir, 1, 1);
  art.take(dir, 2, 1);
  art.vo(dir, 1, 1);
  approve(dir, "storyboard", 1);
  acceptTake(dir, "take-002");
  acceptTake(dir, "take-001");
  approve(dir, "vo", 1);
  assert.deepEqual(readState(dir)?.line, { storyboard: 1, recording: 1, vo: 1 });
  const { state, orphaned } = unacceptStage(dir, "recording", 1);
  assert.deepEqual(
    orphaned.map((o) => o.label),
    ["voice-over v1"],
  );
  assert.deepEqual(acceptedVersions(state.accepted, "vo"), [1], "the VO keeps its own acceptance");
  assert.match(
    orphanReason(dir, state.accepted, "vo", 1) ?? "",
    /recording take-001 is not accepted/,
  );
  assert.deepEqual(
    state.line,
    { storyboard: 1, recording: 2 },
    "line re-picks take-002; the orphaned VO is not selectable",
  );
  assert.throws(
    () => selectStage(dir, "vo", 1),
    /can't be used: recording take-001 is not accepted/,
  );
  assert.throws(() => requireSelected(dir, state, "vo", 1), /can't be used/);
  assert.throws(() => unacceptStage(dir, "recording", 1), /not accepted/);
  // Accepting the take again revives the VO (nothing was lost).
  acceptTake(dir, "take-001");
  assert.equal(orphanReason(dir, readState(dir)?.accepted ?? {}, "vo", 1), undefined);
  assert.deepEqual(readState(dir)?.line, { storyboard: 1, recording: 1, vo: 1 });
});

test("stage status: accepted with lineage and orphan flags, versions on the working line's input", () => {
  const dir = project();
  art.storyboard(dir, 1);
  art.storyboard(dir, 2);
  art.take(dir, 1, 1);
  art.take(dir, 2, 2);
  art.vo(dir, 1, 1);
  approve(dir, "storyboard", 1);
  acceptTake(dir, "take-001");
  approve(dir, "vo", 1);
  unacceptStage(dir, "storyboard", 1);
  approve(dir, "storyboard", 2);
  const s = readState(dir) as ProjectState;
  const st = Object.fromEntries(stageStatus(dir, s.accepted, s.line).map((x) => [x.stage, x]));
  assert.deepEqual(
    st.recording?.accepted.map((a) => [a.version, a.basedOn, a.orphaned]),
    [[1, 1, "storyboard v1 is not accepted"]],
  );
  assert.deepEqual(st.vo?.accepted[0]?.orphaned, "storyboard v1 is not accepted");
  assert.equal(st.recording?.input, 2);
  assert.deepEqual(st.recording?.onInput, [2], "versions built on the selected input");
  assert.equal(st.recording?.selected, undefined);
  assert.match(
    formatStageStatus(stageStatus(dir, s.accepted, s.line)),
    /take-001 \(on v1\) ⚠ orphaned/,
  );
  assert.equal(formatLine(s.line), "storyboard v2");
});

test("invariant: the working line is always usable and consistent; orphans are never on it", () => {
  let seed = 11;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const PARENTS: Record<Stage, Stage | undefined> = {
    storyboard: undefined,
    recording: "storyboard",
    vo: "recording",
    annotations: "vo",
    render: "annotations",
  };
  for (let round = 0; round < 25; round++) {
    const dir = fs.mkdtempSync(path.join(root, "r-"));
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        schema: 3,
        project: "r",
        app: "a",
        phase: "brief",
        createdAt: "x",
        updatedAt: "x",
        accepted: {},
        line: {},
        history: [],
      }),
    );
    const n = { storyboard: 3, recording: 4, vo: 4, annotations: 3, render: 3 };
    for (let v = 1; v <= n.storyboard; v++) art.storyboard(dir, v);
    for (let v = 1; v <= n.recording; v++) art.take(dir, v, 1 + rnd(n.storyboard));
    for (let v = 1; v <= n.vo; v++) art.vo(dir, v, 1 + rnd(n.recording));
    for (let v = 1; v <= n.annotations; v++) art.json(dir, "annotations", v, 1 + rnd(n.vo));
    for (let v = 1; v <= n.render; v++) art.json(dir, "render", v, 1 + rnd(n.annotations));
    for (let step = 0; step < 60; step++) {
      const stage = STAGES[rnd(STAGES.length)] as Stage;
      const v = 1 + rnd(n[stage]);
      const op = rnd(3);
      try {
        if (op === 0) approve(dir, stage, v);
        else if (op === 1) unacceptStage(dir, stage, v);
        else selectStage(dir, stage, v);
      } catch {
        // refused operations are fine; the invariant must still hold
      }
      const s = readState(dir) as ProjectState;
      for (const st of STAGES) {
        const sel = s.line[st];
        if (sel === undefined) continue;
        assert.ok(
          isUsable(dir, s.accepted, st, sel),
          `round ${round} step ${step}: ${st} v${sel} on the line but not usable`,
        );
        const parent = PARENTS[st];
        if (parent)
          assert.equal(
            parentOf(dir, st, sel),
            s.line[parent],
            `round ${round} step ${step}: ${st} v${sel} off its line parent`,
          );
      }
    }
  }
});

test("migration: schema 1 → 3 (backup, accepted take, reviews → input log) and schema 2 → 3", () => {
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
    approved: { storyboard: 1, vo: 1 }, // vo v1 is on take-001, but take-002 is accepted
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
  const s = readState(dir) as ProjectState;
  assert.equal(s.schema, 3);
  assert.deepEqual(Object.fromEntries(STAGES.map((st) => [st, acceptedVersions(s.accepted, st)])), {
    storyboard: [1],
    recording: [2],
    vo: [1],
    annotations: [],
    render: [],
  });
  assert.match(
    orphanReason(dir, s.accepted, "vo", 1) ?? "",
    /take-001 is not accepted/,
    "kept, flagged — not silently dropped",
  );
  assert.deepEqual(s.line, { storyboard: 1, recording: 2 });
  assert.ok(fs.existsSync(path.join(dir, "state.v1.json")));
  assert.equal(s.history.at(-1)?.event, "state-migrated");
  const inputs = readInputs(dir);
  assert.equal(inputs.length, 1, "only submitted reviews become inputs");
  assert.equal(inputs[0]?.text, "01-a: changes — slower\noverall: calmer");
  readState(dir);
  assert.equal(readInputs(dir).length, 1, "migration runs once");

  // Schema 2 (keycraft after part 3): approvals → acceptances, line through them.
  const dir2 = fs.mkdtempSync(path.join(root, "v2-"));
  art.storyboard(dir2, 2);
  art.take(dir2, 6, 2);
  art.vo(dir2, 3, 6);
  art.take(dir2, 5, 2);
  // keycraft's real history: VO v3 approved, then cascade-reset when take-005 was approved, then take-006 again.
  const history = [
    { at: "2026-10-13T10:00:00.000Z", event: "approved", detail: { artifact: "vo", version: 3 } },
    {
      at: "2026-10-14T11:00:00.000Z",
      event: "approval-reset",
      detail: { stage: "vo", version: 3, reason: "x", because: "recording take-005" },
    },
    {
      at: "2026-10-14T11:00:00.000Z",
      event: "approved",
      detail: { artifact: "recording", version: 5 },
    },
    {
      at: "2026-10-14T11:01:00.000Z",
      event: "approved",
      detail: { artifact: "recording", version: 6 },
    },
  ];
  fs.writeFileSync(
    path.join(dir2, "state.json"),
    JSON.stringify({
      ...v1,
      schema: 2,
      approved: { storyboard: 2, recording: 6 },
      acceptedTake: undefined,
      history,
    }),
  );
  const s2 = readState(dir2) as ProjectState;
  assert.equal(s2.schema, 3);
  assert.equal(
    s2.accepted.vo?.["3"],
    "2026-10-13T10:00:00.000Z",
    "cascade-reset approval restored with its original time",
  );
  assert.deepEqual(s2.line, { storyboard: 2, recording: 6, vo: 3 });
  assert.deepEqual(s2.history.at(-1)?.detail?.restored, ["voice-over v3"]);
  assert.ok(fs.existsSync(path.join(dir2, "state.v2.json")));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir2, "state.json"), "utf8")).schema,
    3,
    "persisted",
  );
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
  assert.match(ctx, /working line: storyboard v1/);
  assert.match(ctx, /storyboard\s+1 version\(s\), latest v1; accepted: v1; working line: v1/);
  assert.match(ctx, /keep scene 2 under 20 s/);
  assert.doesNotMatch(ctx, /add a login scene/);
  assert.match(ctx, /1 active, 1 marked outdated and left out/);
});
