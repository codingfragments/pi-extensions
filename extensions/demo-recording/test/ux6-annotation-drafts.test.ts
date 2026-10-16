/**
 * UX6a (D115, D121, D122): annotation drafts on the draft contract. One draft per base version, every write
 * carrying the revision it was based on, idempotent Save new version, base-change flags, the old single
 * `annotations/draft.json` read once, and Reset to suggested. Engine and routes, no browser, no model: the
 * suggestions are a fixed set (what a stub designer returns).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { type Suggestion, suggestAnnotations } from "../src/annotations/design.ts";
import { canReset } from "../src/annotations/draft.ts";
import { annotationVersions, readAnnotations, writeAnnotations } from "../src/annotations/file.ts";
import type { AnnotationItem } from "../src/annotations/types.ts";
import { resolveConfig } from "../src/config.ts";
import {
  annotationDraftFlags,
  discardAnnotationDraft,
  editAnnotationDraft,
  listAnnotationDrafts,
  readAnnotationDraft,
  saveAnnotationDraftAsVersion,
} from "../src/drafts/annotations.ts";
import { DraftConflict } from "../src/drafts/store.ts";
import { Runtime } from "../src/runtime.ts";
import { unacceptStage } from "../src/workdir/state.ts";
import { TIMELINE, makeProject } from "./helpers/annotation-project.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const sg = (o: Partial<Suggestion> & Pick<Suggestion, "type">): Suggestion => ({
  scene: "01-dash",
  anchor: { mark: "m1" },
  value: 3,
  reason: "test",
  ...o,
});
const STUB: Suggestion[] = [
  sg({
    id: "zoom-kpi",
    type: "zoom",
    target: { layout: "t1000#e2" },
    value: 4,
    reason: "the headline",
  }),
  sg({ id: "co-kpi", type: "callout", text: "Headline churn", value: 3, reason: "names it" }),
  sg({
    id: "zoom-row",
    type: "zoom",
    anchor: { mark: "m2" },
    target: { step: 1 },
    alternatives: [{ layout: "t3000#e4" }],
    value: 4,
    reason: "the story",
  }),
  sg({
    id: "ch-1",
    type: "chapter",
    anchor: { sceneStart: true },
    text: "Where churn hides",
    value: 2,
    reason: "structure",
  }),
];

function project() {
  const dir = makeProject();
  suggestAnnotations({ projectDir: dir, timeline: TIMELINE, suggestions: STUB });
  return dir;
}
const edit = (
  dir: string,
  base: number,
  op: Parameters<typeof editAnnotationDraft>[2],
  expected: number | null,
  author = "tab-a",
) => editAnnotationDraft(dir, base, op, { expected, author });
const item = (f: { items: AnnotationItem[] }, id: string) =>
  f.items.find((x) => x.id === id) as AnnotationItem;

test("a draft is one file per base; editing another version never replaces it (the old single draft did)", () => {
  const dir = project();
  const d1 = edit(dir, 1, { op: "toggle", id: "co-kpi" }, null) as NonNullable<
    ReturnType<typeof edit>
  >;
  assert.deepEqual([d1.revision, d1.changes, d1.base], [1, 1, 1]);
  // a second version exists, and it gets its own draft
  const saved = saveAnnotationDraftAsVersion(dir, 1, 1);
  assert.equal(saved.version, 2);
  edit(dir, 1, { op: "text", id: "co-kpi", text: "Edited on v1" }, null);
  edit(dir, 2, { op: "text", id: "ch-1", text: "Edited on v2" }, null);
  assert.deepEqual(
    listAnnotationDrafts(dir).map((d) => [d.base, d.changes]),
    [
      [1, 1],
      [2, 1],
    ],
  );
  assert.equal(item(readAnnotationDraft(dir, 1)?.file as never, "co-kpi").text, "Edited on v1");
  assert.equal(item(readAnnotationDraft(dir, 2)?.file as never, "ch-1").text, "Edited on v2");
  assert.deepEqual(fs.readdirSync(path.join(dir, "drafts", "annotations")).sort(), [
    "v1.json",
    "v1.last.json",
    "v2.json",
  ]);
  assert.equal(
    readAnnotations(dir, 1)?.items.find((x) => x.id === "co-kpi")?.text,
    "Headline churn",
    "the saved versions are untouched",
  );
});

test("a stale revision is rejected with the current draft, for edit, discard and Save new version", () => {
  const dir = project();
  edit(dir, 1, { op: "toggle", id: "co-kpi" }, null, "tab-a");
  const theirs = edit(dir, 1, { op: "toggle", id: "ch-1" }, 1, "tab-b") as NonNullable<
    ReturnType<typeof edit>
  >;
  const conflict = (fn: () => unknown, current: number | null) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof DraftConflict, String(err));
      assert.equal((err.current as { revision: number } | null)?.revision ?? null, current);
      return;
    }
    assert.fail("expected a conflict");
  };
  conflict(() => edit(dir, 1, { op: "toggle", id: "zoom-kpi" }, 1), theirs.revision);
  conflict(() => edit(dir, 1, { op: "toggle", id: "zoom-kpi" }, null), theirs.revision);
  conflict(() => discardAnnotationDraft(dir, 1, 1), theirs.revision);
  conflict(() => saveAnnotationDraftAsVersion(dir, 1, 1), theirs.revision);
  assert.equal(
    readAnnotationDraft(dir, 1)?.revision,
    theirs.revision,
    "a rejected call wrote nothing",
  );
  assert.equal(readAnnotationDraft(dir, 1)?.author, "tab-b");
  discardAnnotationDraft(dir, 1, theirs.revision);
  conflict(() => edit(dir, 1, { op: "toggle", id: "zoom-kpi" }, theirs.revision), null);
});

test("revisions never repeat for a base; Save new version is exactly once per revision", () => {
  const dir = project();
  edit(dir, 1, { op: "toggle", id: "co-kpi" }, null);
  edit(dir, 1, { op: "text", id: "co-kpi", text: "Twice edited" }, 1);
  discardAnnotationDraft(dir, 1, 2);
  const again = edit(dir, 1, { op: "toggle", id: "co-kpi" }, null) as NonNullable<
    ReturnType<typeof edit>
  >;
  assert.equal(again.revision, 3);
  assert.throws(() => edit(dir, 1, { op: "toggle", id: "ch-1" }, 2), DraftConflict);
  const first = saveAnnotationDraftAsVersion(dir, 1, 3);
  assert.deepEqual([first.version, first.repeated, first.changes], [2, false, 1]);
  const second = saveAnnotationDraftAsVersion(dir, 1, 3);
  assert.deepEqual(
    [second.version, second.repeated],
    [2, true],
    "a double click or a retry gives the same version",
  );
  assert.deepEqual(annotationVersions(dir), [1, 2]);
  assert.equal(readAnnotationDraft(dir, 1), undefined);
  assert.equal(readAnnotations(dir, 2)?.editedFrom, 1);
  assert.throws(() => saveAnnotationDraftAsVersion(dir, 1, null), /no longer exists/);
});

test("a refused edit leaves the draft as it was; an edit that changes nothing writes nothing", () => {
  const dir = project();
  const d = edit(dir, 1, { op: "toggle", id: "co-kpi" }, null) as NonNullable<
    ReturnType<typeof edit>
  >;
  const before = fs.readFileSync(path.join(dir, "drafts", "annotations", "v1.json"), "utf8");
  assert.throws(
    () => edit(dir, 1, { op: "text", id: "co-kpi", text: "x".repeat(61) }, d.revision),
    /≤ 60/,
  );
  assert.throws(
    () => edit(dir, 1, { op: "text", id: "zoom-kpi", text: "x" }, d.revision),
    /has no text/,
  );
  assert.throws(
    () => edit(dir, 1, { op: "toggle", id: "nope" }, d.revision),
    /not in this version/,
  );
  assert.equal(fs.readFileSync(path.join(dir, "drafts", "annotations", "v1.json"), "utf8"), before);
  const same = edit(
    dir,
    1,
    {
      op: "toggle",
      id: "co-kpi",
      enabled: readAnnotationDraft(dir, 1)?.file.items.find((x) => x.id === "co-kpi")?.enabled,
    },
    d.revision,
  );
  assert.equal(same?.revision, d.revision, "no new revision");
});

test("a draft stays on its base and is flagged: a newer version, approval withdrawn; never moved", () => {
  const { dir } = seedPanelProject();
  const d = edit(dir, 1, { op: "toggle", id: "ch-dash" }, null) as NonNullable<
    ReturnType<typeof edit>
  >;
  assert.equal(d.baseApprovedAtStart, true, "v1 is approved in the seeded project");
  let f = annotationDraftFlags(dir, d);
  assert.deepEqual(
    [f.superseded, f.baseApproved, f.approvalChanged, f.notes],
    [null, true, false, []],
  );
  // a newer version appears
  const v1 = readAnnotations(dir, 1) as NonNullable<ReturnType<typeof readAnnotations>>;
  const { version: _v, ...rest } = v1;
  writeAnnotations(dir, { ...rest, by: "test" });
  f = annotationDraftFlags(
    dir,
    readAnnotationDraft(dir, 1) as NonNullable<ReturnType<typeof readAnnotationDraft>>,
  );
  assert.equal(f.superseded, 2);
  assert.deepEqual(f.notes, ["built on v1, v2 exists"]);
  // the approval is withdrawn
  unacceptStage(dir, "annotations", 1);
  f = annotationDraftFlags(
    dir,
    readAnnotationDraft(dir, 1) as NonNullable<ReturnType<typeof readAnnotationDraft>>,
  );
  assert.deepEqual([f.baseApproved, f.approvalChanged], [false, true]);
  assert.ok(f.notes.includes("the approval of v1 was withdrawn since you started this draft"));
  const kept = readAnnotationDraft(dir, 1);
  assert.equal(kept?.base, 1, "never moved");
  assert.equal(item(kept?.file as never, "ch-dash").enabled, true, "and its edit is kept");
});

test("the old single draft.json is read once as the draft of its base, then retired", () => {
  const dir = project();
  const file = readAnnotations(dir, 1) as NonNullable<ReturnType<typeof readAnnotations>>;
  const legacy = {
    base: 1,
    updatedAt: "2026-10-01T10:00:00.000Z",
    changes: 2,
    file: {
      ...file,
      items: file.items.map((x) => (x.id === "co-kpi" ? { ...x, text: "From the old draft" } : x)),
    },
  };
  fs.writeFileSync(path.join(dir, "annotations", "draft.json"), JSON.stringify(legacy));
  const d = readAnnotationDraft(dir, 1);
  assert.deepEqual([d?.revision, d?.author, d?.changes], [1, "migrated", 2]);
  assert.equal(item(d?.file as never, "co-kpi").text, "From the old draft");
  assert.equal(fs.existsSync(path.join(dir, "annotations", "draft.json")), false, "retired");
  assert.equal(listAnnotationDrafts(dir).length, 1);
  // it can be edited and saved like any other
  const e = edit(dir, 1, { op: "toggle", id: "ch-1" }, 1) as NonNullable<ReturnType<typeof edit>>;
  assert.equal(e.changes, 3);
  assert.equal(saveAnnotationDraftAsVersion(dir, 1, e.revision).version, 2);
});

test("Reset to suggested: every recorded change of the item undone; manual items and unchanged ones refuse", () => {
  const dir = project();
  const v1 = readAnnotations(dir, 1) as NonNullable<ReturnType<typeof readAnnotations>>;
  const was = item(v1, "co-kpi");
  let rev: number | null = null;
  const op = (o: Parameters<typeof editAnnotationDraft>[2]) => {
    const d = edit(dir, 1, o, rev);
    rev = d?.revision ?? rev;
    return d;
  };
  assert.equal(canReset(was), false, "nothing changed yet");
  assert.throws(() => op({ op: "reset", id: "co-kpi" }), /has not been changed/);
  op({ op: "toggle", id: "co-kpi" });
  op({ op: "text", id: "co-kpi", text: "Changed text" });
  op({ op: "nudge", id: "co-kpi", field: "start", deltaMs: 500 });
  op({ op: "nudge", id: "co-kpi", field: "duration", deltaMs: 500 });
  const edited = item(readAnnotationDraft(dir, 1)?.file as never, "co-kpi");
  assert.equal(canReset(edited), true);
  assert.equal(edited.origin, "edited");
  const d = op({ op: "reset", id: "co-kpi" }) as NonNullable<ReturnType<typeof op>>;
  const back = item(d.file, "co-kpi");
  assert.deepEqual(
    [back.enabled, back.text, back.anchor.offsetMs ?? 0, back.durMs, back.origin, back.edits],
    [was.enabled, was.text, was.anchor.offsetMs ?? 0, was.durMs, "suggested", undefined],
  );
  assert.equal(canReset(back), false);
  // a target swap goes back with its alternatives
  op({ op: "target", id: "zoom-row", alternative: 0 });
  assert.deepEqual(item(readAnnotationDraft(dir, 1)?.file as never, "zoom-row").target, {
    layout: "t3000#e4",
  });
  const d2 = op({ op: "reset", id: "zoom-row" }) as NonNullable<ReturnType<typeof op>>;
  assert.deepEqual(item(d2.file, "zoom-row").target, { step: 1 });
  assert.deepEqual(item(d2.file, "zoom-row").alternatives, [{ layout: "t3000#e4" }]);
  // it works after the draft is saved as a version too: the edits are recorded in the saved item
  op({ op: "text", id: "ch-1", text: "New chapter title" });
  const saved = saveAnnotationDraftAsVersion(dir, 1, rev);
  const inV2 = item(readAnnotations(dir, saved.version) as never, "ch-1");
  assert.equal(canReset(inV2), true);
  const r2 = editAnnotationDraft(
    dir,
    saved.version,
    { op: "reset", id: "ch-1" },
    { expected: null, author: "tab-a" },
  );
  assert.equal(item(r2?.file as never, "ch-1").text, "Where churn hides");
  // a hand-made item has no suggested version
  const manual = readAnnotationDraft(dir, saved.version)?.file as NonNullable<
    ReturnType<typeof readAnnotations>
  >;
  assert.equal(canReset({ ...item(manual, "ch-1"), origin: "manual" }), false);
});

test("reset of a zoom that was switched off respects the cap of two zooms", () => {
  const dir = project();
  const v1 = readAnnotations(dir, 1) as NonNullable<ReturnType<typeof readAnnotations>>;
  const on = v1.items.filter((x) => x.type === "zoom" && x.enabled).map((x) => x.id);
  if (on.length < 1) return; // the stub's recommendation decides; nothing to prove then
  let rev: number | null = null;
  const op = (o: Parameters<typeof editAnnotationDraft>[2]) => {
    const d = edit(dir, 1, o, rev);
    rev = d?.revision ?? rev;
  };
  op({ op: "toggle", id: on[0] as string, enabled: false });
  const others = v1.items.filter((x) => x.type === "zoom" && !x.enabled).map((x) => x.id);
  for (const id of others.slice(0, 2 - (on.length - 1))) op({ op: "toggle", id, enabled: true });
  const zoomsNow = (readAnnotationDraft(dir, 1)?.file.items ?? []).filter(
    (x) => x.type === "zoom" && x.enabled,
  ).length;
  if (zoomsNow >= 2)
    assert.throws(() => op({ op: "reset", id: on[0] as string }), /at most 2 zooms/);
});

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
  const events: { type: string; data?: unknown }[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = (t) => notes.push(t);
  rt.bus.subscribe((e: { type: string; data?: unknown }) => events.push(e));
  rt.setActiveProject(seed.slug);
  const t = rt.routeTables();
  // biome-ignore lint/suspicious/noExplicitAny: the tests index into replies of many shapes
  type Reply = Record<string, any>;
  const post = async (name: string, body: Record<string, unknown>) =>
    (await (t.post[name] as (b: Record<string, unknown>) => unknown)(body)) as Reply;
  const get = (name: string, q: Record<string, string> = {}) =>
    (t.get[name] as (q: URLSearchParams) => Reply)(new URLSearchParams(q));
  return { dir: seed.dir, rt, post, get, turns, notes, events };
}

test("routes: revision is required; a conflict is data with the server's view; save and discard take the base", async () => {
  const { dir, rt, post, get } = setup();
  try {
    await assert.rejects(
      post("annotations-edit", { version: 1, op: "toggle", id: "co-kpi" }),
      /"revision" is required/,
    );
    const a = await post("annotations-edit", {
      version: 1,
      revision: null,
      author: "tab-a",
      op: "toggle",
      id: "co-kpi",
    });
    assert.deepEqual(
      [a.saved, a.draft.revision, a.draft.changes, a.draft.author],
      [true, 1, 1, "tab-a"],
    );
    assert.deepEqual(a.resettable, ["co-kpi"]);
    const late = await post("annotations-edit", {
      version: 1,
      revision: null,
      author: "tab-b",
      op: "toggle",
      id: "ch-dash",
    });
    assert.deepEqual(
      [late.saved, late.conflict, late.draft.revision, late.draft.author],
      [false, true, 1, "tab-a"],
    );
    assert.match(late.message, /changed since you last saw it/);
    assert.equal(
      a.file.items.find((x: { id: string }) => x.id === "ch-dash").enabled,
      late.file.items.find((x: { id: string }) => x.id === "ch-dash").enabled,
      "the view shows the server's draft, not the rejected edit",
    );
    const view = get("annotations", { version: "1" });
    assert.deepEqual([view.draft.revision, view.otherDrafts], [1, []]);
    // reset through the route
    const r = await post("annotations-edit", {
      version: 1,
      revision: 1,
      op: "reset",
      id: "co-kpi",
    });
    assert.deepEqual([r.saved, r.draft.changes, r.resettable], [true, 2, []]);
    // save: the base and the revision; a stale save is data, a repeated one gives the same version
    const stale = await post("annotations-save", { version: 1, revision: 1 });
    assert.deepEqual([stale.saved, stale.conflict], [false, true]);
    const s1 = await post("annotations-save", { version: 1, revision: 2 });
    assert.deepEqual([s1.saved, s1.version, s1.repeated, s1.draft], [true, 2, false, null]);
    const s2 = await post("annotations-save", { version: 1, revision: 2 });
    assert.deepEqual([s2.version, s2.repeated], [2, true]);
    assert.deepEqual(annotationVersions(dir), [1, 2]);
    // discard names what is lost, and a stale discard is rejected
    await post("annotations-edit", { version: 2, revision: null, op: "toggle", id: "ch-dash" });
    const bad = await post("annotations-discard", { version: 2, revision: 9 });
    assert.deepEqual([bad.conflict, bad.discarded], [true, null]);
    const gone = await post("annotations-discard", { version: 2, revision: 1 });
    assert.deepEqual([gone.discarded.base, gone.discarded.changes, gone.draft], [2, 1, null]);
  } finally {
    await rt.shutdown();
  }
});

test("private until saved: no Director turn, no note, no text in any event; the tool refuses to read a draft", async () => {
  const { rt, post, turns, notes, events, dir } = setup();
  try {
    const secret = "SECRET-CALLOUT-77";
    const a = await post("annotations-edit", {
      version: 1,
      revision: null,
      op: "text",
      id: "co-kpi",
      text: secret,
    });
    await post("annotations-edit", {
      version: 1,
      revision: a.draft.revision,
      op: "toggle",
      id: "ch-dash",
    });
    assert.deepEqual([turns, notes], [[], []]);
    assert.equal(JSON.stringify(events).includes(secret), false, "no event carries the draft text");
    assert.ok(events.some((e) => e.type === "annotations.updated"));
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../src/tools/annotations.ts"),
      "utf8",
    );
    assert.match(src, /private until they save them as a version/);
    // nothing outside drafts/ holds the text
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, n.name);
        if (n.isDirectory()) walk(f);
        else if (fs.readFileSync(f, "utf8").includes(secret)) hits.push(path.relative(dir, f));
      }
    };
    walk(dir);
    assert.deepEqual(
      hits.filter((h) => !h.startsWith("drafts/annotations/")),
      [],
    );
  } finally {
    await rt.shutdown();
  }
});
