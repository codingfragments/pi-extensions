/**
 * Item 12b (F21): the zoom limit is two settings, zooms per minute and per scene, decided in ONE place (src/annotations/zoom-limits.ts) and read by the
 * designer's selection, the panel's edit rules, the input pack, the budget meter. A stored file only keeps a sanity cap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { annotationContext } from "../src/annotations/context.ts";
import { importAnnotations, suggestAnnotations } from "../src/annotations/design.ts";
import { type DraftOp, applyDraftOp } from "../src/annotations/draft.ts";
import { readAnnotations } from "../src/annotations/file.ts";
import type { AnnotationFile, AnnotationItem } from "../src/annotations/types.ts";
import { recommend } from "../src/annotations/weights.ts";
import {
  ASSUMED_DEMO_MS,
  DEFAULT_ZOOM_LIMITS,
  trimZooms,
  zoomLimitWords,
  zoomLimitsOf,
  zoomRefusal,
  zoomTotal,
  zoomUse,
} from "../src/annotations/zoom-limits.ts";
import { resolveConfig } from "../src/config.ts";
import { SCENE, TIMELINE, makeProject } from "./helpers/annotation-project.ts";

const zoom = (id: string, scene: string, enabled = true): AnnotationItem =>
  ({
    id,
    type: "zoom",
    scene,
    anchor: { mark: "m1" },
    target: { step: 0 },
    enabled,
  }) as AnnotationItem;
const MIN = 60_000;

test("the total grows with the demo: per minute times length, rounded up, at least one; off at zero", () => {
  const L = DEFAULT_ZOOM_LIMITS; // 1.5 per minute, 1 per scene
  assert.equal(zoomTotal(L, ASSUMED_DEMO_MS), 2, "an 80 s demo gets the 2 it always had");
  assert.equal(zoomTotal(L, 30_000), 1);
  assert.equal(zoomTotal(L, MIN), 2);
  assert.equal(zoomTotal(L, 2 * MIN), 3);
  assert.equal(
    zoomTotal(L, 6 * MIN),
    9,
    "a 6 minute demo is not held to the 1 minute demo's limit",
  );
  assert.equal(zoomTotal(L), 2, "no edit yet: a typical length");
  assert.equal(zoomTotal({ perMinute: 0, perScene: 1 }, 2 * MIN), 0);
  assert.equal(zoomTotal({ perMinute: 2, perScene: 0 }, 2 * MIN), 0);
});

test("the limit in words", () => {
  assert.equal(
    zoomLimitWords(DEFAULT_ZOOM_LIMITS, 80_000),
    "at most 2 zooms in this 1 min 20 s demo (1.5 per minute), 1 per scene",
  );
  assert.equal(
    zoomLimitWords(DEFAULT_ZOOM_LIMITS, 30_000),
    "at most 1 zoom in this 30 s demo (1.5 per minute), 1 per scene",
  );
  assert.equal(zoomLimitWords({ perMinute: 0, perScene: 1 }), "zooms are turned off");
});

test("switching a zoom on is refused with the limit that stops it: per scene first, then the total", () => {
  const items = [zoom("a", "s1"), zoom("b", "s2"), zoom("c", "s1", false), zoom("d", "s3", false)];
  const c = items[2] as AnnotationItem;
  assert.match(
    zoomRefusal(items, c, DEFAULT_ZOOM_LIMITS) ?? "",
    /^at most 1 zoom per scene \(s1 has 1\) — turn that zoom off first, or raise annotations\.zoomsPerScene$/,
  );
  const d = items[3] as AnnotationItem;
  assert.match(
    zoomRefusal(items, d, DEFAULT_ZOOM_LIMITS) ?? "",
    /^at most 2 zooms in this 1 min 20 s demo \(1\.5 per minute\), 1 per scene — turn another zoom off first, or raise annotations\.zoomsPerMinute$/,
  );
  assert.equal(
    zoomRefusal(items, d, DEFAULT_ZOOM_LIMITS, 2 * MIN),
    undefined,
    "a 2 minute demo has room for a third",
  );
  assert.equal(
    zoomRefusal(items, c, { perMinute: 1.5, perScene: 2 }, 2 * MIN),
    undefined,
    "and 2 per scene allows another in s1",
  );
  assert.match(zoomRefusal(items, d, { perMinute: 0, perScene: 1 }) ?? "", /zooms are turned off/);
  assert.equal(
    zoomRefusal(items, items[0] as AnnotationItem, DEFAULT_ZOOM_LIMITS),
    undefined,
    "an item is not counted against itself",
  );
});

test("trimming keeps the first zooms in file order and switches the rest off", () => {
  const items = [
    zoom("a", "s1"),
    zoom("b", "s1"),
    zoom("c", "s2"),
    zoom("d", "s3"),
    zoom("e", "s4", false),
  ];
  const off = trimZooms(items, DEFAULT_ZOOM_LIMITS, 80_000);
  assert.deepEqual(
    off.map((x) => x.id),
    ["b", "d"],
    "b: second in s1, d: the total (a, c) is full",
  );
  assert.deepEqual(
    items.map((x) => x.enabled),
    [true, false, true, false, false],
  );
  const roomy = [zoom("a", "s1"), zoom("b", "s2"), zoom("c", "s3")];
  assert.deepEqual(trimZooms(roomy, DEFAULT_ZOOM_LIMITS, 2 * MIN), []);
  assert.deepEqual(zoomUse(roomy, DEFAULT_ZOOM_LIMITS, 2 * MIN), {
    used: 3,
    total: 3,
    words: "at most 3 zooms in this 2 min demo (1.5 per minute), 1 per scene",
  });
});

test("the designer's recommended set respects both limits", () => {
  const mk = (id: string, scene: string, startMs: number) => ({
    item: { ...zoom(id, scene, false), weight: { value: 5, noise: 1.5 } } as AnnotationItem,
    res: { id, type: "zoom", scene, startMs, endMs: startMs + 2000, atMs: startMs, fadeMs: 0 },
  });
  const xs = [
    mk("a", "s1", 0),
    mk("b", "s1", 5000),
    mk("c", "s2", 0),
    mk("d", "s3", 0),
    mk("e", "s4", 0),
    mk("f", "s5", 0),
  ];
  const items = xs.map((x) => x.item);
  const res = xs.map((x) => x.res) as never;
  const none = { on: new Set<string>(), off: new Set<string>() };
  const big = (limits: { perMinute: number; perScene: number }, durationMs: number) =>
    [...recommend(items, res, none, { limits, durationMs })].sort();
  // an 80 s demo (2 in total, 1 per scene): a (s1) and c (s2); b is a second one in s1, d would be the third
  assert.deepEqual(big(DEFAULT_ZOOM_LIMITS, 80_000), ["a", "c"]);
  // room for 2 per scene and 8 in total: the half rule (3 of 6) is what stops them, and b is allowed beside a
  assert.deepEqual(big({ perMinute: 6, perScene: 2 }, 80_000), ["a", "b", "c"]);
  // off
  assert.deepEqual(big({ perMinute: 0, perScene: 1 }, 80_000), []);
});

test("the config: defaults, a global or project value, validation", () => {
  const read = (annotations: unknown) =>
    resolveConfig({ env: {}, home: "/h", readFile: () => JSON.stringify({ annotations }) });
  const plain = resolveConfig({ env: {}, home: "/h", readFile: () => undefined });
  assert.deepEqual(zoomLimitsOf(plain), { perMinute: 1.5, perScene: 1 });
  assert.deepEqual(zoomLimitsOf(read({ zoomsPerMinute: 3, zoomsPerScene: 2 })), {
    perMinute: 3,
    perScene: 2,
  });
  assert.deepEqual(
    zoomLimitsOf(read({ zoomsPerMinute: 0 })),
    { perMinute: 0, perScene: 1 },
    "0 = no zooms",
  );
  assert.equal(
    read({ autoSuggest: false }).annotations.zoomsPerMinute,
    1.5,
    "the other annotation settings leave them alone",
  );
  for (const bad of [
    { zoomsPerMinute: -1 },
    { zoomsPerMinute: 21 },
    { zoomsPerMinute: "2" },
    { zoomsPerScene: 1.5 },
    { zoomsPerScene: 6 },
    { zoomsPerScene: -1 },
  ])
    assert.throws(
      () => read(bad),
      /demo-recording config: "annotations\.zoomsPer(Minute|Scene)" must be (a whole number|a number) from 0 to \d+ \(0 = no zooms\)/,
      JSON.stringify(bad),
    );
});

test("the panel's edit rules and the project: the limits in force are the ones asked for", () => {
  const file = {
    version: 1,
    basedOn: { vo: 1 },
    take: "take-001",
    items: [zoom("a", "s1"), zoom("b", "s2"), zoom("c", "s1", false), zoom("d", "s3", false)],
  } as AnnotationFile;
  const toggle = (id: string, guard = {}) =>
    applyDraftOp(
      structuredClone(file),
      { op: "toggle", id, enabled: true } as DraftOp,
      new Date(),
      guard,
    );
  assert.throws(() => toggle("c"), /at most 1 zoom per scene \(s1 has 1\)/);
  assert.throws(() => toggle("d"), /at most 2 zooms in this 1 min 20 s demo/);
  assert.equal(toggle("d", { durationMs: 2 * MIN }), true, "the demo is longer: room for a third");
  assert.equal(
    toggle("c", { limits: { perMinute: 1.5, perScene: 2 }, durationMs: 2 * MIN }),
    true,
    "raised per scene",
  );
  assert.throws(
    () => toggle("d", { limits: { perMinute: 0, perScene: 1 } }),
    /zooms are turned off/,
  );
});

test("the designer's version never pre-enables more than the limits; the input pack tells the real limit", () => {
  const dir = makeProject();
  const sc = SCENE.id;
  const sg = (id: string, anchor: string) => ({
    id,
    scene: sc,
    type: "zoom" as const,
    anchor: { mark: anchor },
    target: { step: 0 },
    value: 5,
    reason: "test",
  });
  const run = (zoomLimits?: { perMinute: number; perScene: number }) =>
    suggestAnnotations({
      projectDir: dir,
      timeline: TIMELINE,
      suggestions: [sg("z1", "m1"), sg("z2", "m2")],
      dryRun: false,
      ...(zoomLimits ? { zoomLimits } : {}),
    });
  const r = run();
  const on = (v: number) =>
    (readAnnotations(dir, v)?.items ?? []).filter((x) => x.enabled && x.type === "zoom").length;
  assert.equal(on(r.version), 1, "both are in one scene: 1 per scene");
  const r2 = run({ perMinute: 6, perScene: 2 });
  assert.ok(on(r2.version) <= 2 && on(r2.version) >= 1);
  const text = annotationContext({ projectDir: dir, timeline: TIMELINE, timelineVersion: 1 });
  assert.match(
    text,
    /Caps: zooms: at most 1 zoom in this \d+ s demo \(1\.5 per minute\), 1 per scene \(a zoom beyond it is switched off; 1\.1–1\.8×, default 1\.5\)/,
  );
  const loud = annotationContext({
    projectDir: dir,
    timeline: TIMELINE,
    timelineVersion: 1,
    zoomLimits: { perMinute: 6, perScene: 3 },
  });
  assert.match(loud, /at most \d+ zooms? in this \d+ s demo \(6 per minute\), 3 per scene/);
  // importing a version applies the limits too
  const imp = importAnnotations({
    projectDir: dir,
    timeline: TIMELINE,
    from: r2.version,
    zoomLimits: { perMinute: 1.5, perScene: 1 },
  });
  assert.ok(on(imp.version) <= 1);
});
