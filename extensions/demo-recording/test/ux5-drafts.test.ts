/**
 * UX5a (D115, D121): working drafts. The engine and the routes, on the seeded project (voice-over v1
 * approved, v2 a newer draft version): a draft is the user's own unsaved edit, private until saved, never a
 * version, never rebased or dropped silently, and Save new version creates exactly one version.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import {
  DraftConflict,
  discardDraft,
  draftFlags,
  draftSections,
  listDrafts,
  readDraft,
  saveDraft,
  saveDraftAsVersion,
} from "../src/drafts/store.ts";
import { buildGraph } from "../src/graph/build.ts";
import { ROUTE_COST } from "../src/panel/cost.ts";
import { Runtime } from "../src/runtime.ts";
import { readVo, voVersions } from "../src/vo/store.ts";
import { approveVersion, readState, unacceptStage } from "../src/workdir/state.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const INTRO = "01-dash";
const save = (
  dir: string,
  base: number,
  expected: number | null,
  edits: Record<string, string | null>,
  author = "tab-a",
) => saveDraft(dir, "vo", base, { expected, edits, author });

test("a draft is one file per base, written atomically; revisions count up; an edit equal to the base is dropped", () => {
  const { dir } = seedPanelProject();
  const d1 = save(dir, 1, null, {
    [INTRO]: "Headline churn is 5 percent. [@m1] Steady. [@m2] EMEA is off.",
  });
  assert.equal(d1.revision, 1);
  assert.deepEqual(Object.keys(d1.edits), [INTRO]);
  assert.ok(fs.existsSync(path.join(dir, "drafts", "vo", "v1.json")));
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "drafts", "vo")),
    ["v1.json"],
    "no temp file is left behind",
  );
  const d2 = save(dir, 1, 1, { _intro: "A different opening." });
  assert.equal(d2.revision, 2);
  assert.equal(d2.createdAt, d1.createdAt);
  assert.deepEqual(Object.keys(d2.edits).sort(), ["01-dash", "_intro"]);
  // writing the base text back, or null, removes the edit: `changes` is what really differs
  const base = readVo(dir, 1)?.validated.script.sections.find((s) => s.key === "_intro")
    ?.body as string;
  const d3 = save(dir, 1, 2, { _intro: `${base}\n` });
  assert.deepEqual(Object.keys(d3.edits), ["01-dash"]);
  const d4 = save(dir, 1, 3, { [INTRO]: null });
  assert.deepEqual(d4.edits, {});
  assert.equal(d4.revision, 4, "an empty draft keeps counting");
  assert.deepEqual(listDrafts(dir, "vo"), [], "a draft with no changes is not listed");
});

test("scoped to the base: another version's draft never overwrites it; the immutable versions are untouched", () => {
  const { dir } = seedPanelProject();
  const v1 = fs.readFileSync(path.join(dir, "vo", "script.v1.md"), "utf8");
  const v2 = fs.readFileSync(path.join(dir, "vo", "script.v2.md"), "utf8");
  save(dir, 1, null, { _outro: "Outro for v1." });
  save(dir, 2, null, { _outro: "Outro for v2." });
  assert.equal(readDraft(dir, "vo", 1)?.edits._outro, "Outro for v1.");
  assert.equal(readDraft(dir, "vo", 2)?.edits._outro, "Outro for v2.");
  assert.deepEqual(
    listDrafts(dir, "vo").map((d) => d.base),
    [1, 2],
  );
  assert.equal(fs.readFileSync(path.join(dir, "vo", "script.v1.md"), "utf8"), v1);
  assert.equal(fs.readFileSync(path.join(dir, "vo", "script.v2.md"), "utf8"), v2);
  assert.deepEqual(voVersions(dir), [1, 2], "a draft is never a version");
});

test("a stale revision is rejected with the current draft, for save, discard and Save new version", () => {
  const { dir } = seedPanelProject();
  save(dir, 1, null, { _outro: "mine" }, "tab-a");
  const theirs = save(dir, 1, 1, { _intro: "theirs" }, "tab-b");
  const conflict = (fn: () => unknown, current: number | null) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof DraftConflict, String(err));
      assert.equal(err.current?.revision ?? null, current);
      return;
    }
    assert.fail("expected a conflict");
  };
  conflict(() => save(dir, 1, 1, { _outro: "late" }), theirs.revision);
  conflict(() => save(dir, 1, null, { _outro: "I thought there was none" }), theirs.revision);
  conflict(() => discardDraft(dir, "vo", 1, 1), theirs.revision);
  conflict(() => saveDraftAsVersion(dir, "vo", 1, 1), theirs.revision);
  assert.equal(
    readDraft(dir, "vo", 1)?.revision,
    theirs.revision,
    "nothing was written by a rejected call",
  );
  assert.equal(readDraft(dir, "vo", 1)?.author, "tab-b");
  // a tab that thinks a draft exists after it was discarded is told it is gone
  discardDraft(dir, "vo", 1, theirs.revision);
  conflict(() => save(dir, 1, theirs.revision, { _outro: "ghost" }), null);
});

test("revisions never repeat for a base, so a stale tab is never mistaken for a current one", () => {
  const { dir } = seedPanelProject();
  save(dir, 1, null, { _outro: "a" });
  save(dir, 1, 1, { _outro: "b" });
  discardDraft(dir, "vo", 1, 2);
  const again = save(dir, 1, null, { _outro: "c" });
  assert.equal(again.revision, 3);
  assert.throws(() => save(dir, 1, 2, { _outro: "from the old tab" }), DraftConflict);
});

test("Save new version creates exactly one version, once per revision; the draft is then gone", () => {
  const { dir } = seedPanelProject();
  const d = save(dir, 1, null, {
    [INTRO]: "Headline churn is 5 percent. [@m1] Steady. [@m2] EMEA is off.",
  });
  const first = saveDraftAsVersion(dir, "vo", 1, d.revision);
  assert.deepEqual([first.version, first.repeated, first.sections], [3, false, [INTRO]]);
  const again = saveDraftAsVersion(dir, "vo", 1, d.revision);
  assert.deepEqual(
    [again.version, again.repeated],
    [3, true],
    "a double click or a retry gives the same version",
  );
  assert.deepEqual(voVersions(dir), [1, 2, 3]);
  assert.equal(readDraft(dir, "vo", 1), undefined);
  assert.match(readVo(dir, 3)?.text ?? "", /Headline churn is 5 percent/);
  assert.match(
    readVo(dir, 3)?.text ?? "",
    /Two questions, one answer\./,
    "the rest of the script is carried over",
  );
  // a new draft on the same base starts a new revision and can be saved on its own
  const d2 = save(dir, 1, null, { _outro: "Another outro." });
  assert.equal(d2.revision, d.revision + 1);
  assert.equal(saveDraftAsVersion(dir, "vo", 1, d2.revision).version, 4);
});

test("a failed Save new version keeps the draft: validation errors consume no version", () => {
  const { dir } = seedPanelProject();
  // anchors are only allowed in scene sections, so this does not validate
  const d = save(dir, 1, null, { _outro: "An anchor where none may be. [@m1]" });
  assert.throws(
    () => saveDraftAsVersion(dir, "vo", 1, d.revision),
    /not stored|anchors are only allowed/,
  );
  assert.deepEqual(voVersions(dir), [1, 2], "no version was consumed");
  const kept = readDraft(dir, "vo", 1);
  assert.equal(kept?.revision, d.revision, "the draft is untouched");
  assert.equal(kept?.edits._outro, "An anchor where none may be. [@m1]");
  // fix the text and save again: now it works, once
  const fixed = save(dir, 1, d.revision, { _outro: "No anchor here." });
  assert.equal(saveDraftAsVersion(dir, "vo", 1, fixed.revision).version, 3);
  assert.deepEqual(voVersions(dir), [1, 2, 3]);
});

test("a draft stays on its base and is flagged, never moved: newer version, approval changed, or withdrawn", () => {
  const { dir } = seedPanelProject();
  const d = save(dir, 2, null, { _outro: "Edits on v2, a draft version." });
  let f = draftFlags(dir, d);
  assert.deepEqual(
    [f.base, f.latest, f.superseded, f.baseApproved, f.approvalChanged, f.notes],
    [2, 2, null, false, false, []],
  );
  // base approved after the draft was started
  approveVersion(dir, "vo", 2, "only");
  f = draftFlags(dir, readDraft(dir, "vo", 2) as NonNullable<ReturnType<typeof readDraft>>);
  assert.deepEqual([f.baseApproved, f.approvalChanged], [true, true]);
  assert.deepEqual(f.notes, ["v2 was approved since you started this draft"]);
  // a newer version appears
  const v3 = save(dir, 1, null, { _outro: "v3 text" });
  saveDraftAsVersion(dir, "vo", 1, v3.revision);
  f = draftFlags(dir, readDraft(dir, "vo", 2) as NonNullable<ReturnType<typeof readDraft>>);
  assert.equal(f.superseded, 3);
  assert.ok(f.notes.includes("built on v2, v3 exists"));
  // still on its base, text unchanged, and compare shows the newest version's section
  const kept = readDraft(dir, "vo", 2) as NonNullable<ReturnType<typeof readDraft>>;
  assert.equal(kept.base, 2);
  assert.equal(kept.edits._outro, "Edits on v2, a draft version.");
  const [section] = draftSections(dir, kept);
  assert.deepEqual(
    [section?.key, section?.draft, section?.latest],
    ["_outro", "Edits on v2, a draft version.", "v3 text"],
  );
  // withdrawing the approval is noted as well
  const d1 = save(dir, 1, null, { _intro: "x" });
  assert.equal(d1.baseApprovedAtStart, true);
  unacceptStage(dir, "vo", 1);
  f = draftFlags(dir, readDraft(dir, "vo", 1) as NonNullable<ReturnType<typeof readDraft>>);
  assert.deepEqual([f.baseApproved, f.approvalChanged], [false, true]);
  assert.ok(f.notes.includes("the approval of v1 was withdrawn since you started this draft"));
  assert.equal(readDraft(dir, "vo", 1)?.edits._intro, "x", "the draft is never dropped");
});

test("limits and validation: unknown section, too long, wrong types", () => {
  const { dir } = seedPanelProject();
  assert.throws(() => save(dir, 1, null, { "no-such": "x" }), /not in voice-over v1/);
  assert.throws(() => save(dir, 1, null, { _outro: "x".repeat(20_001) }), /longer than/);
  assert.throws(() => save(dir, 1, null, { _outro: 5 as unknown as string }), /text or null/);
  assert.throws(() => save(dir, 9, null, { _outro: "x" }), /v9 does not exist/);
  assert.equal(fs.existsSync(path.join(dir, "drafts")), false, "a rejected save writes nothing");
});

/** A route's JSON reply, read freely by the assertions below (test code only). */
// biome-ignore lint/suspicious/noExplicitAny: the tests index into replies of many shapes
type Reply = Record<string, any>;

function setup() {
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
  const t = rt.routeTables();
  const post = async (name: string, body: Record<string, unknown>) =>
    (await (t.post[name] as (b: Record<string, unknown>) => unknown)(body)) as Reply;
  const get = (name: string, q: Record<string, string>) =>
    (t.get[name] as (q: URLSearchParams) => Reply)(new URLSearchParams(q));
  return { seed, rt, turns, notes, post, get };
}

test("routes: save, conflict as data, list, view, discard naming what is lost, Save new version", async () => {
  const { seed, rt, post, get } = setup();
  try {
    const s1 = await post("draft-save", {
      stage: "vo",
      base: 1,
      revision: null,
      author: "tab-a",
      edits: { _outro: "Outro A" },
    });
    assert.deepEqual(
      [s1.saved, s1.draft.revision, s1.draft.changes, s1.flags.notes],
      [true, 1, 1, ["built on v1, v2 exists"]],
    );
    const late = await post("draft-save", {
      stage: "vo",
      base: 1,
      revision: null,
      author: "tab-b",
      edits: { _intro: "B" },
    });
    assert.deepEqual(
      [late.saved, late.conflict, late.current.draft.revision, late.current.draft.author],
      [false, true, 1, "tab-a"],
    );
    assert.match(late.message, /changed since you last saw it/);
    const list = get("drafts", { stage: "vo" });
    assert.deepEqual(
      list.drafts.map((d: { base: number; changes: number }) => [d.base, d.changes]),
      [[1, 1]],
    );
    const one = get("draft", { stage: "vo", base: "1" });
    assert.equal(one.edits._outro, "Outro A");
    assert.deepEqual(
      one.sections.map((s: { key: string; base: string }) => [s.key, s.base]),
      [["_outro", "Two questions, one answer."]],
    );
    assert.equal(get("draft", { stage: "vo", base: "2" }).draft, null);
    // discard names what is lost; a stale discard is rejected
    const stale = await post("draft-discard", { stage: "vo", base: 1, revision: 5 });
    assert.equal(stale.conflict, true);
    const gone = await post("draft-discard", { stage: "vo", base: 1, revision: 1 });
    assert.deepEqual(
      [gone.discarded.base, gone.discarded.sections, gone.discarded.changes],
      [1, ["_outro"], 1],
    );
    assert.deepEqual(
      (await post("draft-discard", { stage: "vo", base: 1, revision: 1 })).discarded,
      null,
      "already gone",
    );
    // Save new version through the route: one version, an input recorded, repeated gives the same one
    const s2 = await post("draft-save", {
      stage: "vo",
      base: 1,
      revision: null,
      edits: { _outro: "Final outro" },
    });
    const v = await post("draft-version", { stage: "vo", base: 1, revision: s2.draft.revision });
    assert.deepEqual([v.saved, v.version, v.repeated, v.sections], [true, 3, false, ["_outro"]]);
    const v2 = await post("draft-version", { stage: "vo", base: 1, revision: s2.draft.revision });
    assert.deepEqual([v2.version, v2.repeated], [3, true]);
    assert.deepEqual(voVersions(seed.dir), [1, 2, 3]);
    const inputs = fs.readFileSync(path.join(seed.dir, "inputs.jsonl"), "utf8");
    assert.equal(
      inputs.split("\n").filter((l) => l.includes("v1 → v3")).length,
      1,
      "recorded once",
    );
    await assert.rejects(
      post("draft-save", { stage: "storyboard", base: 1, edits: {} }),
      /only the voice-over/,
    );
    await assert.rejects(
      post("draft-save", { stage: "vo", base: 1, edits: [] }),
      /must map a section/,
    );
    await assert.rejects(post("draft-save", { stage: "vo", base: 0, edits: {} }), /version number/);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("private until saved: no agent turn, no note, no event carries the text; the map and History do not see a draft", async () => {
  const { seed, rt, post, turns, notes } = setup();
  try {
    const seen: { type: string; data: unknown }[] = [];
    rt.bus.subscribe((e: { type: string; data?: unknown }) =>
      seen.push({ type: e.type, data: e.data }),
    );
    const secret = "SECRET-DRAFT-TEXT-91";
    const state = () => readState(seed.dir) as NonNullable<ReturnType<typeof readState>>;
    const graphBefore = buildGraph(seed.dir, seed.slug, state()).rev;
    const stateBefore = fs.readFileSync(path.join(seed.dir, "state.json"), "utf8");
    const s = await post("draft-save", {
      stage: "vo",
      base: 2,
      revision: null,
      edits: { _outro: secret },
    });
    await post("draft-save", {
      stage: "vo",
      base: 2,
      revision: s.draft.revision,
      edits: { _intro: `${secret} again` },
    });
    await post("draft-discard", { stage: "vo", base: 2, revision: 2 });
    await post("draft-save", { stage: "vo", base: 2, revision: null, edits: { _outro: secret } });
    assert.deepEqual([turns, notes], [[], []], "the Director is not told");
    const types = seen.map((e) => e.type);
    assert.ok(types.includes("draft.changed"));
    assert.equal(JSON.stringify(seen).includes(secret), false, "no event carries the draft text");
    assert.equal(
      buildGraph(seed.dir, seed.slug, state()).rev,
      graphBefore,
      "the map does not change",
    );
    assert.equal(
      fs.readFileSync(path.join(seed.dir, "state.json"), "utf8"),
      stateBefore,
      "approval and the line are untouched",
    );
    assert.deepEqual(voVersions(seed.dir), [1, 2]);
    // nothing outside drafts/ holds the text
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, n.name);
        if (n.isDirectory()) walk(f);
        else if (fs.readFileSync(f, "utf8").includes(secret)) hits.push(path.relative(seed.dir, f));
      }
    };
    walk(seed.dir);
    assert.deepEqual(hits, ["drafts/vo/v2.json"]);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("every draft route has cost class none", () => {
  for (const r of ["draft-save", "draft-discard", "draft-version"])
    assert.deepEqual(ROUTE_COST[r], ["none"], r);
});

test("over HTTP: GET needs the token, POST needs the Bearer header; a conflict is a 200 with data", async () => {
  const { seed, rt } = setup();
  try {
    const panel = await rt.ensurePanel();
    const u = new URL(panel.url);
    const token = u.searchParams.get("token") as string;
    const base = `${u.origin}/api`;
    assert.equal((await fetch(`${base}/drafts?stage=vo`)).status, 401);
    const empty = await fetch(`${base}/drafts?stage=vo&token=${token}`);
    assert.deepEqual(await empty.json(), { project: seed.slug, drafts: [] });
    const post = (body: unknown, auth = true) =>
      fetch(`${base}/draft-save`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ stage: "vo", base: 1, edits: {} }, false)).status, 401);
    const ok = await post({ stage: "vo", base: 1, revision: null, edits: { _outro: "x" } });
    assert.equal(ok.status, 200);
    const stale = await post({ stage: "vo", base: 1, revision: null, edits: { _outro: "y" } });
    assert.equal(stale.status, 200);
    assert.equal(((await stale.json()) as { conflict: boolean }).conflict, true);
    assert.equal((await post({ stage: "vo", base: 1, edits: [] })).status, 400);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
