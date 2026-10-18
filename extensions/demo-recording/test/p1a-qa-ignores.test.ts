/**
 * P1a PR 12 (Q2): decisions are remembered. A finding is the same finding in the next render whatever its numbers do,
 * an ignore has a scope and a reason, covers the finding again, ends when its content changes, and never covers a
 * broken file. A leaking redaction that a project rule covers counts as confirmed, visibly.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { findingsFor } from "../src/qa/findings.ts";
import { placeFindings, sameFinding, sceneAt } from "../src/qa/identity.ts";
import {
  addIgnore,
  formatIgnores,
  listIgnores,
  refreshQa,
  removeIgnore,
} from "../src/qa/ignores.ts";
import { formatQa, qaFile, readQa } from "../src/qa/run.ts";
import { summarize } from "../src/qa/summary.ts";
import type { QaItem, QaReport } from "../src/qa/types.ts";
import { Runtime } from "../src/runtime.ts";
import { projectContext } from "../src/workdir/context.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

// --- identity ---------------------------------------------------------------------------

const drift = (anchor: string, phrase: string[], scene = "01-dash"): QaItem => ({
  id: "x",
  check: "drift",
  level: "warning",
  scene,
  message: "late",
  identity: { anchor, phrase },
});

test("the same drift finding: by the mark, or by the first three words when the mark was renamed; never across scenes", () => {
  const a = drift("emea-bar", ["then", "the", "chart", "shows"]);
  assert.equal(sameFinding(a, drift("emea-bar", [])), true, "the same mark");
  assert.equal(
    sameFinding(a, drift("renamed", ["then", "the", "chart"])),
    true,
    "renamed, same phrase",
  );
  assert.equal(sameFinding(a, drift("renamed", ["then", "a", "chart"])), false, "another phrase");
  assert.equal(
    sameFinding(a, drift("renamed", ["then", "the"])),
    false,
    "two words are not enough",
  );
  assert.equal(sameFinding(a, drift("emea-bar", [], "02-search")), false, "another scene");
  assert.equal(sameFinding(a, { ...a, check: "values" }), false, "another check");
});

test("values match by their normalised value; the same value in another segment is another finding", () => {
  const v = (value: string, anchor?: string, phrase?: string[]): QaItem => ({
    id: "v",
    check: "values",
    level: "warning",
    scene: "01-dash",
    message: "m",
    identity: { value, ...(anchor ? { anchor } : {}), ...(phrase ? { phrase } : {}) },
  });
  assert.equal(sameFinding(v("14.3", "m2"), v("14.3", "m2")), true);
  assert.equal(sameFinding(v("14.3", "m2"), v("14.2", "m2")), false, "another value");
  assert.equal(sameFinding(v("14.3", "m1"), v("14.3", "m2")), false, "said again elsewhere");
  assert.equal(
    sameFinding(v("14.3", "m1", ["a", "b", "c"]), v("14.3", "x", ["a", "b", "c"])),
    true,
    "renamed mark",
  );
  assert.equal(sameFinding(v("14.3"), v("14.3", "m2")), true, "an older item with no anchor");
});

test("findings with no anchor: the same kind within 1.5 s of where they were in the scene", () => {
  const m = (kind: string, relMs?: number): QaItem => ({
    id: "m",
    check: "media",
    level: "warning",
    scene: "02-search",
    message: "m",
    identity: { kind, ...(relMs !== undefined ? { relMs } : {}) },
  });
  assert.equal(sameFinding(m("pause", 4000), m("pause", 5400)), true);
  assert.equal(sameFinding(m("pause", 4000), m("pause", 5600)), false, "moved further than 1.5 s");
  assert.equal(sameFinding(m("pause", 4000), m("still", 4000)), false, "another kind");
});

test("footage findings match by their text, annotations by their id or text", () => {
  const f = (text: string): QaItem => ({
    id: "f",
    check: "footage",
    level: "warning",
    scene: "s",
    message: "m",
    identity: { text },
  });
  assert.equal(sameFinding(f("something went wrong"), f("something went wrong")), true);
  assert.equal(sameFinding(f("something went wrong"), f("saved")), false);
  const r = (ref: string): QaItem => ({
    id: "a",
    check: "annotations",
    level: "blocking",
    scene: "s",
    message: "m",
    identity: { ref },
  });
  assert.equal(sameFinding(r("r1"), r("r1")), true);
  assert.equal(sameFinding(r("r1"), r("r2")), false);
});

test("a media finding gets the scene it falls in and its place inside it", () => {
  const starts = { "01-a": 0, "02-b": 10000, "03-c": 25000 };
  assert.equal(sceneAt(starts, 12000), "02-b");
  assert.equal(sceneAt(starts, 25000), "03-c");
  const items: QaItem[] = [
    {
      id: "m",
      check: "media",
      level: "warning",
      atMs: 12500,
      message: "m",
      identity: { kind: "pause" },
    },
    { id: "v", check: "values", level: "warning", atMs: 12500, message: "m" },
  ];
  placeFindings(items, starts);
  assert.deepEqual([items[0]?.scene, items[0]?.identity?.relMs], ["02-b", 2500]);
  assert.equal(items[1]?.scene, undefined, "only media findings are placed");
});

// --- the ignore store -------------------------------------------------------------------

const REPORT = (extra: Partial<QaItem>[] = []): QaReport => ({
  render: 1,
  stage: "render",
  version: 1,
  variant: "neutral",
  createdAt: "2026-10-18T10:00:00.000Z",
  whisper: true,
  items: [
    {
      id: "values-1",
      check: "values",
      level: "warning",
      high: true,
      scene: "01-dash",
      atMs: 2100,
      message: "the narration says “fourteen point three” (14.3)",
      identity: { anchor: "m2", phrase: ["but", "emea", "is"], value: "14.3" },
    },
    {
      id: "media-2",
      check: "media",
      level: "warning",
      scene: "01-dash",
      atMs: 4000,
      message: "no narration for 4.6 s",
      identity: { kind: "pause", relMs: 1000 },
    },
    {
      id: "annotations-3",
      check: "annotations",
      level: "blocking",
      hard: "redaction",
      scene: "01-dash",
      atMs: 2500,
      message: "redaction r1 doesn't cover its element here",
      identity: { ref: "r1" },
    },
    {
      id: "media-4",
      check: "media",
      level: "blocking",
      hard: "integrity",
      message: "the audio is silent",
    },
    ...(extra as QaItem[]),
  ],
});

function setup(items?: QaReport) {
  const seed = seedPanelProject();
  fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
  fs.writeFileSync(qaFile(seed.dir, 1), JSON.stringify(items ?? REPORT()));
  return seed;
}
const cleanup = (root: string) => fs.rmSync(root, { recursive: true, force: true });
const ignore = (
  dir: string,
  itemId: string,
  scope: "finding" | "scene" | "project",
  reason = "it is meant",
) => addIgnore(dir, { version: 1, itemId, scope, reason, by: "panel" });

test("ignoring a finding: it stays in the report, leaves the counts, and carries the reason", () => {
  const seed = setup();
  try {
    const { ignore: ig, summary } = ignore(
      seed.dir,
      "values-1",
      "finding",
      "the forecast is meant",
    );
    assert.deepEqual(
      [ig.id, ig.scope, ig.scene, ig.check],
      ["ig-1", "finding", "01-dash", "values"],
    );
    assert.match(ig.contentKey ?? "", /^narration:01-dash:[0-9a-f]{10}$/);
    assert.deepEqual(
      [summary.high, summary.warnings, summary.ignored],
      [0, 1, 1],
      "out of the counts",
    );
    const r = readQa(seed.dir, 1) as QaReport;
    const it = r.items.find((x) => x.id === "values-1");
    assert.deepEqual(
      [it?.ignored?.scope, it?.ignored?.reason, it?.ignored?.since],
      ["finding", "the forecast is meant", 1],
    );
    assert.match(formatQa(r, summary), /1 ignored by you/);
    assert.match(formatQa(r, summary), /ignored: the forecast is meant/);
  } finally {
    cleanup(seed.root);
  }
});

test("an ignore covers the finding in the next render of the same content, whatever its numbers do", () => {
  const seed = setup();
  try {
    ignore(seed.dir, "values-1", "finding");
    // the next run finds the same issue with other numbers and another position
    const next = REPORT();
    const it = next.items[0] as QaItem;
    it.message = "the narration says “fourteen point three” (14.3), a bit later";
    it.atMs = 2400;
    fs.writeFileSync(qaFile(seed.dir, 1), JSON.stringify(next));
    const { summary } = refreshQa(seed.dir, 1);
    assert.equal(summary.ignored, 1);
    assert.equal((readQa(seed.dir, 1) as QaReport).items[0]?.ignored?.scope, "finding");
  } finally {
    cleanup(seed.root);
  }
});

test("a scene ignore covers that kind of finding in that scene, not other kinds or other scenes", () => {
  const seed = setup(
    REPORT([
      {
        id: "media-5",
        check: "media",
        level: "warning",
        scene: "02-search",
        message: "pause",
        identity: { kind: "pause", relMs: 100 },
      },
      {
        id: "media-6",
        check: "media",
        level: "warning",
        scene: "01-dash",
        message: "still",
        identity: { kind: "still", relMs: 9000 },
      },
    ]),
  );
  try {
    ignore(seed.dir, "media-2", "scene");
    const r = readQa(seed.dir, 1) as QaReport;
    const by = (id: string) => r.items.find((x) => x.id === id);
    assert.ok(by("media-2")?.ignored);
    assert.equal(by("media-5")?.ignored, undefined, "another scene");
    assert.equal(by("media-6")?.ignored, undefined, "another kind of media finding");
  } finally {
    cleanup(seed.root);
  }
});

test("a project rule covers the kind everywhere; a leaking redaction under a rule counts as confirmed, visibly", () => {
  const seed = setup();
  try {
    const { summary } = ignore(seed.dir, "annotations-3", "project", "this is test data, no PII");
    const r = readQa(seed.dir, 1) as QaReport;
    const red = r.items.find((x) => x.id === "annotations-3");
    assert.equal(red?.ignored?.scope, "project");
    assert.match(red?.confirmed?.reason ?? "", /^ignored \(project\): this is test data, no PII$/);
    // the integrity hard stop is still there and still stops it; the redaction's stop is lifted, in the open
    assert.deepEqual([summary.blocking, summary.confirmed, summary.status], [2, 1, "blocked"]);
    const without = summarize(r.items.filter((x) => x.id !== "media-4"));
    assert.deepEqual([without.status, without.confirmed], ["confirmed", 1]);
    const rule = listIgnores(seed.dir)[0];
    assert.deepEqual(
      [rule?.scope, rule?.contentKey, rule?.scene],
      ["project", undefined, undefined],
    );
  } finally {
    cleanup(seed.root);
  }
});

test("a broken file cannot be ignored; a reason and a scene are required", () => {
  const seed = setup();
  try {
    assert.throws(
      () => ignore(seed.dir, "media-4", "project"),
      /broken file.*cannot be ignored, render again/,
    );
    assert.throws(() => ignore(seed.dir, "values-1", "finding", " "), /reason is required/);
    assert.throws(() => ignore(seed.dir, "nope", "finding"), /not in the report/);
    assert.throws(() => ignore(seed.dir, "values-1", "everything" as never), /scope is/);
    const noScene = REPORT();
    noScene.items.push({
      id: "media-9",
      check: "media",
      level: "warning",
      message: "pause",
      identity: { kind: "pause" },
    });
    fs.writeFileSync(qaFile(seed.dir, 1), JSON.stringify(noScene));
    assert.throws(
      () => ignore(seed.dir, "media-9", "scene"),
      /belongs to no scene: ignore it for the whole project/,
    );
    assert.deepEqual(listIgnores(seed.dir), [], "nothing was stored");
  } finally {
    cleanup(seed.root);
  }
});

test("an ignore ends when the scene's narration changes, and the finding is raised again", () => {
  const seed = setup();
  try {
    ignore(seed.dir, "values-1", "scene");
    assert.equal(refreshQa(seed.dir, 1).summary.ignored, 1);
    // the narration of the scene changes (a new voice-over text for render v1's voice-over version)
    const vo = path.join(seed.dir, "vo", "script.v1.md");
    fs.writeFileSync(vo, fs.readFileSync(vo, "utf8").replace("steady.", "steadily improving."));
    const { summary } = refreshQa(seed.dir, 1);
    assert.equal(summary.ignored ?? 0, 0, "raised again");
    const ig = listIgnores(seed.dir)[0];
    assert.match(ig?.endedWhy ?? "", /the narration of 01-dash changed \(render v1\)/);
    assert.ok(ig?.endedAt);
    assert.match(formatIgnores(seed.dir).join("\n"), /Ended \(the content changed/);
    // the project rule does not end with the narration
    ignore(seed.dir, "media-2", "project");
    fs.writeFileSync(
      vo,
      fs.readFileSync(vo, "utf8").replace("steadily improving.", "again different."),
    );
    refreshQa(seed.dir, 1);
    assert.equal(listIgnores(seed.dir).find((i) => i.scope === "project")?.endedAt, undefined);
  } finally {
    cleanup(seed.root);
  }
});

test("stop ignoring removes the decision and brings the finding back", () => {
  const seed = setup();
  try {
    const { ignore: ig } = ignore(seed.dir, "values-1", "finding");
    const { removed, summary } = removeIgnore(seed.dir, ig.id, 1);
    assert.equal(removed.id, ig.id);
    assert.deepEqual([summary?.high, summary?.ignored ?? 0], [1, 0]);
    assert.deepEqual(listIgnores(seed.dir), []);
    assert.throws(() => removeIgnore(seed.dir, "ig-9"), /there is no ignore ig-9/);
  } finally {
    cleanup(seed.root);
  }
});

test("the Director reads the decisions in the project context, and the checks view lists them", () => {
  const seed = setup();
  try {
    ignore(seed.dir, "values-1", "finding", "the forecast is meant");
    const ctx = projectContext(seed.dir, seed.slug);
    assert.match(ctx, /## QA decisions \(what the user left alone\)/);
    assert.match(ctx, /Active \(do not raise these again, do not ask about them\)/);
    assert.match(ctx, /ig-1 \[finding, 01-dash\] values: the forecast is meant/);
    const view = findingsFor(seed.dir, "render", 1);
    assert.equal(view.ignores?.length, 1);
    assert.equal(
      view.findings.find((f) => f.id === "values-1")?.ignored?.reason,
      "the forecast is meant",
    );
  } finally {
    cleanup(seed.root);
  }
});

test("the panel routes ignore and stop ignoring, tell the Director, and cost nothing", async () => {
  const seed = setup();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const told: string[] = [];
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }), root: seed.root, panelPort: 0 }),
    { sendUserMessage: () => {}, sendMessage: (m) => told.push(m.content) },
  );
  rt.setActiveProject(seed.slug);
  try {
    const post = rt.routeTables().post;
    const r = (await post["render-qa-ignore"]?.({
      version: 1,
      id: "values-1",
      scope: "scene",
      reason: "meant",
    })) as {
      ignore: { id: string };
      summary: { ignored: number };
    };
    assert.equal(r.summary.ignored, 1);
    assert.match(
      told.at(-1) ?? "",
      /decided to leave this QA finding alone \(scene: values in 01-dash\): "meant"/,
    );
    const back = (await post["render-qa-unignore"]?.({ ignore: r.ignore.id })) as {
      removed: { id: string };
    };
    assert.equal(back.removed.id, r.ignore.id);
    await assert.rejects(
      async () =>
        post["render-qa-ignore"]?.({ version: 1, id: "media-4", scope: "project", reason: "x" }),
      /cannot be ignored/,
    );
  } finally {
    await rt.shutdown();
    cleanup(seed.root);
  }
});
