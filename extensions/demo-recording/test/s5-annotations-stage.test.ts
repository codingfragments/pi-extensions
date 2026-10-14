/**
 * S5 part 8 — the Annotations stage engine: weights and the recommended set,
 * the privacy scan, suggest / re-suggest (keeps user changes) / import, the
 * draft, word anchors, the designer's input pack and the auto-suggest hand-off.
 * No browser, no model: suggestions are a fixed set (what a stub designer returns).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveContext } from "../src/annotations/apply.ts";
import { annotationContext } from "../src/annotations/context.ts";
import {
  type Suggestion,
  importAnnotations,
  suggestAnnotations,
} from "../src/annotations/design.ts";
import { discardDraft, editDraft, readDraft, saveDraft } from "../src/annotations/draft.ts";
import { annotationVersions, readAnnotations } from "../src/annotations/file.ts";
import { detect, mask, scanPrivacy } from "../src/annotations/privacy.ts";
import { resolveAnnotations, wordOutMs } from "../src/annotations/resolve.ts";
import type { AnnotationItem } from "../src/annotations/types.ts";
import { budgetOf, noiseOf, recommend } from "../src/annotations/weights.ts";
import type { EditResult } from "../src/edit/pipeline.ts";
import type { SceneTimeline, Timeline } from "../src/edit/timeline.ts";
import type { LayoutSnapshot } from "../src/recorder/layout.ts";
import { toSuggestion } from "../src/tools/annotations.ts";
import { autoSuggestNote } from "../src/tools/edit.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// --- a synthetic project: one scene, 6 s, marks m1 (1 s) and m2 (3 s) -----------

const SCENE = {
  id: "01-dash",
  title: "Dashboard",
  audioFile: "vo/audio/s1.wav",
  pieces: [{ src: [0, 6000], speed: 1, kind: "static" }],
  // narration section audio 0–4 s played from 0.5 s
  audio: [{ src: [0, 4000], at: 500 }],
  anchors: [
    { mark: "m1", event: 1000, out: 1000, audioAt: 1000, drift: 0 },
    { mark: "m2", event: 3000, out: 3000, audioAt: 3000, drift: 0 },
  ],
  durationMs: 6000,
  stats: {
    cutMs: 0,
    frozenMs: 0,
    spedMs: 0,
    slowedMs: 0,
    silenceMs: 0,
    residualMs: 0,
    stretchMs: 0,
    overrunMs: 0,
  },
} as unknown as SceneTimeline;

const TIMELINE = {
  schema: 1,
  take: "take-001",
  voVersion: 1,
  voice: { engine: "say", name: "x" },
  fps: 30,
  size: { width: 1920, height: 1080 },
  scenes: [SCENE],
  full: [{ type: "scene", id: "01-dash" }],
  totals: { fullMs: 6000, cutMs: 0, frozenMs: 0, silenceMs: 0, worstDriftMs: 0 },
} as unknown as Timeline;

const ELS = [
  { id: "e1", role: "heading", box: { x: 20, y: 20, w: 400, h: 40 }, text: "Customer health" },
  { id: "e2", role: "div", box: { x: 100, y: 100, w: 200, h: 60 }, text: "3.1%" },
  {
    id: "e3",
    role: "row",
    box: { x: 400, y: 300, w: 600, h: 40 },
    text: "Litware Bank EMEA $310K",
  },
  { id: "e4", role: "cell", box: { x: 800, y: 300, w: 100, h: 40 }, text: "$310K" },
  {
    id: "e5",
    role: "cell",
    box: { x: 400, y: 360, w: 300, h: 30 },
    text: "dana.whitfield@litware.example",
  },
  {
    id: "e6",
    role: "cell",
    box: { x: 400, y: 400, w: 300, h: 30 },
    text: "sk-live-abcdefghijklmnop1234",
  },
];

function makeProject(): string {
  const dir = tmp("ann8-");
  const take = path.join(dir, "takes", "take-001");
  fs.mkdirSync(take, { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({
      take: "take-001",
      storyboardVersion: 1,
      viewport: { width: 1600, height: 900, dpr: 2 },
      captureStats: { width: 3200, height: 1800 },
    }),
  );
  const ev = [
    {
      t: 1000,
      type: "hover",
      scene: "01-dash",
      step: 0,
      mark: "m1",
      box: { x: 100, y: 100, w: 200, h: 60 },
    },
    {
      t: 3000,
      type: "hover",
      scene: "01-dash",
      step: 1,
      mark: "m2",
      box: { x: 400, y: 300, w: 600, h: 40 },
    },
  ];
  fs.writeFileSync(
    path.join(take, "events.jsonl"),
    `${ev.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  const snap = (t: number, mark?: string) => ({
    t,
    reason: mark ? "mark" : "settle",
    ...(mark ? { mark } : {}),
    scene: "01-dash",
    url: "http://x/",
    scroll: { x: 0, y: 0 },
    viewport: { w: 1600, h: 900 },
    els: ELS,
  });
  fs.writeFileSync(
    path.join(take, "layout.jsonl"),
    `${[snap(400), snap(1000, "m1"), snap(3000, "m2")].map((s) => JSON.stringify(s)).join("\n")}\n`,
  );
  fs.mkdirSync(path.join(dir, "storyboard"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "storyboard", "v1.yaml"),
    [
      "version: 1",
      "app: x",
      "start_url: /",
      "scenes:",
      "  - id: 01-dash",
      "    title: Dashboard",
      "    steps:",
      "      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }",
      "      - { do: hover, target: { css: '#row' }, mark: m2, dwell: 1s, emphasis: the EMEA row is the story }",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(dir, "vo", "audio"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vo", "script.v1.md"),
    "---\ntake: take-001\n---\n## 01-dash — Dashboard\nChurn looks fine. [@m1] Three point one percent churn. [@m2] But EMEA tells another story, EMEA again.\n",
  );
  const words = [
    "Churn",
    "looks",
    "fine.",
    "Three",
    "point",
    "one",
    "percent.",
    "But",
    "EMEA",
    "tells",
    "another",
    "story,",
    "EMEA",
    "again.",
  ].map((w, i) => ({ w, seg: 0, s: i * 0.25, e: i * 0.25 + 0.2 }));
  fs.writeFileSync(
    path.join(dir, "vo", "audio", "v1.json"),
    JSON.stringify({
      schema: 1,
      voVersion: 1,
      take: "take-001",
      sections: {
        "01-dash": {
          key: "01-dash",
          alignment: { durationSec: 4, words, anchors: {}, source: "transcript" },
        },
      },
    }),
  );
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  fs.writeFileSync(path.join(dir, "edit", "timeline.v1.json"), JSON.stringify(TIMELINE));
  return dir;
}

const sg = (o: Partial<Suggestion> & Pick<Suggestion, "type">): Suggestion => ({
  scene: "01-dash",
  anchor: { mark: "m1" },
  value: 3,
  reason: "test",
  ...o,
});

/** What a stub designer returns for the fixture-like scene. */
const STUB: Suggestion[] = [
  sg({
    id: "zoom-kpi",
    type: "zoom",
    target: { layout: "t1000#e2" },
    value: 4,
    reason: "the headline number",
  }),
  sg({
    id: "hl-kpi",
    type: "highlight",
    target: { step: 0 },
    value: 3,
    reason: "the voice names it",
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
    id: "sp-row",
    type: "spotlight",
    anchor: { mark: "m2" },
    target: { text: "Litware", role: "row" },
    value: 4,
    reason: "busy screen",
  }),
  sg({
    id: "co-emea",
    type: "callout",
    anchor: { word: "EMEA" },
    text: "EMEA is the outlier",
    value: 4,
    reason: "the turn",
  }),
  sg({
    id: "ch-1",
    type: "chapter",
    anchor: { sceneStart: true },
    text: "Where churn hides",
    value: 2,
    reason: "structure",
  }),
  sg({
    id: "bad-mark",
    type: "callout",
    anchor: { mark: "nope" },
    text: "x",
    value: 3,
    reason: "typo",
  }),
  sg({ id: "too-long", type: "callout", text: "x".repeat(70), value: 3, reason: "too long" }),
];

// --- weights ----------------------------------------------------------------------

test("noise: per type and duration; chapters and redactions are outside the budget", () => {
  assert.equal(noiseOf({ type: "callout" }), 1);
  assert.equal(noiseOf({ type: "zoom" }), 1.5);
  assert.equal(noiseOf({ type: "zoom", durMs: 7000 }), 2, "+0.5 × (3.5 extra s / 3.5 s default)");
  assert.equal(noiseOf({ type: "chapter", durMs: 9000 }), 0);
  assert.equal(noiseOf({ type: "redact" }), 0);
});

test("recommended set: best value per noise, half of the counted, caps, spotlight only at 5, fixed user choices", () => {
  const mk = (
    id: string,
    type: AnnotationItem["type"],
    value: number,
    startMs: number,
    box?: { x: number; y: number; w: number; h: number },
  ) => ({
    item: {
      id,
      type,
      scene: "s",
      anchor: { mark: "m" },
      enabled: false,
      weight: { value, noise: noiseOf({ type }) },
    } as AnnotationItem,
    res: {
      id,
      type,
      scene: "s",
      startMs,
      endMs: startMs + 2000,
      atMs: startMs,
      fadeMs: 0,
      ...(box ? { box } : {}),
    },
  });
  const xs = [
    mk("z1", "zoom", 5, 0, { x: 0, y: 0, w: 10, h: 10 }),
    mk("z2", "zoom", 5, 5000, { x: 0, y: 0, w: 10, h: 10 }),
    mk("z3", "zoom", 5, 10000, { x: 0, y: 0, w: 10, h: 10 }),
    mk("h1", "highlight", 3, 0, { x: 0, y: 0, w: 10, h: 10 }), // same region and time as z1
    mk("h2", "highlight", 3, 20000, { x: 50, y: 50, w: 10, h: 10 }),
    mk("c1", "callout", 3, 30000),
    mk("s1", "spotlight", 4, 40000, { x: 90, y: 90, w: 10, h: 10 }),
    mk("ch", "chapter", 2, 0),
  ];
  const rec = recommend(
    xs.map((x) => x.item),
    xs.map((x) => x.res),
  );
  // 7 counted → 4 picked: must-haves (value 5) first — z1, z2 (cap 2; z3 left out), then by value/noise:
  // h1 overlaps z1 (same region, same time) → h2 (3/0.6), c1 (3/1)
  assert.deepEqual([...rec].sort(), ["c1", "h2", "z1", "z2"]);
  assert.ok(!rec.has("s1"), "spotlight below 5 never recommended");
  assert.ok(!rec.has("ch"));
  assert.ok(!(rec.has("h1") && rec.has("z1")), "never two on the same region at the same time");
  const fixed = recommend(
    xs.map((x) => x.item),
    xs.map((x) => x.res),
    { on: new Set(["z2", "z3"]), off: new Set(["h2"]) },
  );
  assert.ok(
    fixed.has("z2") && fixed.has("z3") && !fixed.has("z1"),
    "the user's two zooms fill the cap",
  );
  assert.ok(!fixed.has("h2"), "the user turned it off");
  const b = budgetOf(
    xs.map((x) => ({ ...x.item, enabled: rec.has(x.item.id) })),
    4,
  );
  assert.ok(["balanced", "too busy", "too quiet"].includes(b.status));
  assert.equal(b.enabled, 4);
  assert.equal(b.suggested, 7);
});

// --- privacy ------------------------------------------------------------------------

test("privacy: emails, keys, JWTs, phones, cards (Luhn), IBANs, long IDs — masked, no false positives on amounts", () => {
  assert.equal(detect("dana.whitfield@litware.example")?.kind, "email");
  assert.equal(detect("token sk-live-abcdefghijklmnop1234")?.kind, "token");
  assert.equal(detect("ghp_ABCDEFGHIJKLMNOPQRSTUVWX12")?.kind, "token");
  assert.equal(
    detect("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")?.kind,
    "jwt",
  );
  assert.equal(detect("+49 30 1234 5678")?.kind, "phone");
  assert.equal(detect("4111 1111 1111 1111")?.kind, "card");
  assert.equal(detect("4111 1111 1111 1112"), undefined, "fails Luhn");
  assert.equal(detect("DE89 3704 0044 0532 0130 00")?.kind, "iban");
  assert.equal(detect("Customer no. 123456789012")?.kind, "id");
  for (const fine of [
    "$4.82M",
    "14.2%",
    "1,284",
    "Litware Bank",
    "2026-10-14",
    "Q3 2026 revenue 12,345,678",
  ])
    assert.equal(detect(fine), undefined, fine);
  assert.equal(mask("dana.whitfield@litware.example"), "da••••••••••••le");
  const hits = scanPrivacy([
    {
      t: 500,
      reason: "settle",
      scene: "s",
      url: "",
      scroll: { x: 0, y: 0 },
      viewport: { w: 1, h: 1 },
      els: ELS,
    } as LayoutSnapshot,
  ]);
  assert.deepEqual(
    hits.map((h) => [h.kind, h.ref]),
    [
      ["email", "t500#e5"],
      ["token", "t500#e6"],
    ],
  );
  assert.ok(!hits.some((h) => h.masked.includes("whitfield")), "never the full secret");
});

// --- word anchors -------------------------------------------------------------------

test("word anchors: n-th occurrence through the scene's audio placement", () => {
  const words = ["But", "EMEA", "tells", "EMEA."].map((w, i) => ({ w, s: i * 0.5 }));
  assert.deepEqual(wordOutMs(SCENE, words, "emea", 1), { ms: 500 + 500 });
  assert.deepEqual(wordOutMs(SCENE, words, "EMEA", 2), { ms: 500 + 1500 }, "punctuation ignored");
  assert.deepEqual(wordOutMs(SCENE, words, "tells EMEA", 1), { ms: 500 + 1000 }, "phrases");
  assert.match((wordOutMs(SCENE, words, "EMEA", 3) as { error: string }).error, /occurs only 2×/);
  assert.match(
    (wordOutMs(SCENE, words, "APAC", 1) as { error: string }).error,
    /not in the narration/,
  );
  assert.match((wordOutMs(SCENE, undefined, "x", 1) as { error: string }).error, /no word timings/);
});

// --- suggest / re-suggest / import --------------------------------------------------

test("suggest: places, drops with reasons, adds privacy redactions (off), bonuses, enables about half within the caps", () => {
  const dir = makeProject();
  const r = suggestAnnotations({ projectDir: dir, timeline: TIMELINE, suggestions: STUB });
  assert.equal(r.version, 1);
  const f = readAnnotations(dir, 1);
  assert.ok(f);
  const by = Object.fromEntries((f?.items ?? []).map((x) => [x.id, x]));
  assert.deepEqual(r.dropped.map((d) => d.id).sort(), ["bad-mark", "too-long"]);
  assert.match(
    r.dropped.find((d) => d.id === "bad-mark")?.why ?? "",
    /mark "nope" is not in 01-dash/,
  );
  assert.match(r.dropped.find((d) => d.id === "too-long")?.why ?? "", /≤ 60 characters/);
  assert.equal(r.added, 7);
  assert.equal(r.privacy, 2, "email + key");
  const redacts = (f?.items ?? []).filter((x) => x.type === "redact");
  assert.ok(redacts.every((x) => !x.enabled && x.reason?.startsWith("privacy:")));
  assert.deepEqual(
    redacts.map((x) => x.target),
    [{ layout: "t400#e5" }, { layout: "t400#e6" }],
  );
  // bonuses: the emphasised step (m2/step 1), the VO anchor (m1), the spoken word
  assert.equal(by["zoom-row"]?.weight?.value, 5);
  assert.match(by["zoom-row"]?.reason ?? "", /emphasis/);
  assert.equal(by["co-emea"]?.weight?.value, 5);
  assert.equal(
    by["hl-kpi"]?.weight?.value,
    3,
    "no bonus: the narration doesn't name what a step target shows",
  );
  assert.equal(by["co-kpi"]?.weight?.value, 4, "the narration at m1 mentions “churn”");
  assert.match(by["co-kpi"]?.reason ?? "", /mentions “churn” here/);
  assert.equal(by["sp-row"]?.weight?.value, 4, "spotlights never get the bonus");
  // enabled: counted = 6 (2 zooms, hl, 2 callouts, spotlight) → 3 on; chapter/redacts off
  const on = (f?.items ?? []).filter((x) => x.enabled).map((x) => x.id);
  assert.equal(on.length, 3);
  assert.ok(!by["ch-1"]?.enabled);
  assert.ok(f?.budget && f.budget.optimumNoise > 0);
  assert.match(r.budget, /balanced/);
  assert.equal(by["zoom-row"]?.alternatives?.length, 1);
  assert.equal(f?.by, "annotation-designer");
});

test("re-suggest: the user's added/edited/toggled items are kept as they are; the rest is regenerated", () => {
  const dir = makeProject();
  suggestAnnotations({ projectDir: dir, timeline: TIMELINE, suggestions: STUB });
  const v1 = readAnnotations(dir, 1);
  const wasOn = v1?.items.find((x) => x.id === "co-kpi")?.enabled ?? false;
  editDraft(dir, 1, { op: "text", id: "co-emea", text: "EMEA: 14.2 %" });
  editDraft(dir, 1, { op: "toggle", id: "co-kpi" });
  editDraft(dir, 1, { op: "toggle", id: "rd-email-1" });
  const saved = saveDraft(dir);
  assert.equal(saved.version, 2);
  assert.equal(saved.editedFrom, 1);
  const r = suggestAnnotations({
    projectDir: dir,
    timeline: TIMELINE,
    base: 2,
    instructions: "fewer zooms, more callouts",
    suggestions: [
      sg({
        id: "co-new",
        type: "callout",
        anchor: { mark: "m2" },
        text: "Litware leads",
        value: 4,
        reason: "new",
      }),
      sg({
        id: "co-emea",
        type: "callout",
        anchor: { word: "EMEA" },
        text: "EMEA is the outlier",
        value: 4,
        reason: "dup",
      }),
    ],
  });
  assert.deepEqual(r.kept.sort(), ["co-emea", "co-kpi", "rd-email-1"]);
  assert.ok(
    r.dropped.some((d) => d.id === "co-emea" && /user's version/.test(d.why)),
    "same id as a kept item → the user's version wins",
  );
  const v3 = readAnnotations(dir, r.version);
  const by = Object.fromEntries((v3?.items ?? []).map((x) => [x.id, x]));
  assert.equal(by["co-emea"]?.text, "EMEA: 14.2 %", "the user's text survives");
  assert.equal(by["co-kpi"]?.enabled, !wasOn, "the user's toggle survives");
  assert.equal(by["rd-email-1"]?.enabled, true, "the confirmed redaction survives");
  assert.ok(by["co-new"], "new suggestions come in");
  assert.ok(
    !by["zoom-kpi"],
    "untouched old suggestions are regenerated (gone if not suggested again)",
  );
  assert.ok(
    !v3?.items.some((x) => x.id !== "co-emea" && x.text === "EMEA is the outlier"),
    "a suggestion equal to a kept item is not duplicated",
  );
  assert.equal(v3?.resuggestedFrom, 2);
  assert.equal(v3?.instructions, "fewer zooms, more callouts");
  assert.equal(
    (v3?.items ?? []).filter(
      (x) =>
        x.type === "redact" && x.target && "layout" in x.target && x.target.layout === "t400#e5",
    ).length,
    1,
    "privacy hit not re-added when a kept redaction covers it",
  );
});

test("import: carries what still resolves, with the user's edits; lists the rest", () => {
  const dir = makeProject();
  suggestAnnotations({ projectDir: dir, timeline: TIMELINE, suggestions: STUB });
  editDraft(dir, 1, { op: "text", id: "co-kpi", text: "3.1 % headline" });
  saveDraft(dir); // v2
  // A new edit where the scene lost mark m2 (re-recorded without it)
  const t2 = {
    ...TIMELINE,
    voVersion: 2,
    scenes: [{ ...SCENE, anchors: [SCENE.anchors[0]] }],
  } as unknown as Timeline;
  const ev = path.join(dir, "takes", "take-001", "events.jsonl");
  fs.writeFileSync(
    ev,
    `${fs
      .readFileSync(ev, "utf8")
      .split("\n")
      .filter((l) => l && !l.includes('"m2"'))
      .join("\n")}\n`,
  );
  const r = importAnnotations({ projectDir: dir, timeline: t2, from: 2 });
  const f = readAnnotations(dir, r.version);
  assert.equal(f?.importedFrom, 2);
  assert.equal(f?.basedOn.vo, 2);
  assert.equal(f?.items.find((x) => x.id === "co-kpi")?.text, "3.1 % headline");
  assert.ok(r.carried.includes("co-kpi") && r.carried.includes("ch-1"));
  const gone = Object.fromEntries(r.notCarried.map((n) => [n.id, n.why]));
  assert.match(gone["zoom-row"] ?? "", /mark "m2" is not in 01-dash/);
  assert.ok(!r.carried.includes("sp-row"));
});

// --- draft ----------------------------------------------------------------------------

test("draft: toggle, text, nudges, target swap; caps; survives; save = one version; discard", () => {
  const dir = makeProject();
  suggestAnnotations({ projectDir: dir, timeline: TIMELINE, suggestions: STUB });
  const v1 = readAnnotations(dir, 1);
  const zoomsOn = (v1?.items ?? []).filter((x) => x.enabled && x.type === "zoom").length;
  editDraft(dir, 1, { op: "nudge", id: "co-kpi", field: "start", deltaMs: 500 });
  editDraft(dir, 1, { op: "nudge", id: "co-kpi", field: "start", deltaMs: 500 });
  editDraft(dir, 1, { op: "nudge", id: "co-kpi", field: "duration", deltaMs: -500 });
  editDraft(dir, 1, { op: "target", id: "zoom-row", alternative: 0 });
  let d = readDraft(dir);
  assert.equal(d?.changes, 4);
  const co = d?.file.items.find((x) => x.id === "co-kpi");
  assert.equal(co?.anchor.offsetMs, 1000);
  assert.equal(co?.durMs, 2000);
  assert.equal(co?.origin, "edited");
  assert.equal(co?.edits?.length, 3);
  const z = d?.file.items.find((x) => x.id === "zoom-row");
  assert.deepEqual(z?.target, { layout: "t3000#e4" });
  assert.deepEqual(z?.alternatives, [{ step: 1 }]);
  assert.throws(
    () => editDraft(dir, 1, { op: "text", id: "co-kpi", text: "x".repeat(61) }),
    /≤ 60/,
  );
  assert.throws(() => editDraft(dir, 1, { op: "text", id: "zoom-row", text: "x" }), /has no text/);
  assert.throws(
    () => editDraft(dir, 1, { op: "nudge", id: "rd-email-1", field: "duration", deltaMs: 500 }),
    /lasts to the end of the scene/,
  );
  // a third zoom: turn both off-zooms on until the cap refuses
  const offZooms = (d?.file.items ?? [])
    .filter((x) => x.type === "zoom" && !x.enabled)
    .map((x) => x.id);
  if (zoomsOn + offZooms.length > 2) {
    for (const id of offZooms.slice(0, 2 - zoomsOn))
      editDraft(dir, 1, { op: "toggle", id, enabled: true });
    assert.throws(
      () => editDraft(dir, 1, { op: "toggle", id: offZooms.at(-1) as string, enabled: true }),
      /at most 2 zooms/,
    );
  }
  d = readDraft(dir);
  assert.ok(d, "the draft is on disk (survives reloads)");
  const saved = saveDraft(dir);
  assert.equal(saved.version, 2);
  assert.equal(readDraft(dir), undefined);
  assert.deepEqual(annotationVersions(dir), [1, 2], "one version for all edits");
  editDraft(dir, 2, { op: "toggle", id: "ch-1" });
  assert.equal(discardDraft(dir), true);
  assert.deepEqual(annotationVersions(dir), [1, 2]);
  assert.throws(() => saveDraft(dir), /no unsaved/);
});

// --- input pack, tool input, auto-suggest ------------------------------------------------

test("input pack: narration with anchor times, emphasis, steps, elements with refs, privacy, kept items, instructions", () => {
  const dir = makeProject();
  const text = annotationContext({ projectDir: dir, timeline: TIMELINE, timelineVersion: 1 });
  assert.match(text, /## 01-dash — Dashboard \(6\.00 s\)/);
  assert.match(text, /\[@m1 1\.00 s\] Three point one percent churn\./);
  assert.match(
    text,
    /1 hover \{"css":"#row"\} @m2 at 3\.00 s box 400,300 600×40 ✦ the EMEA row is the story/,
  );
  assert.match(text, /t400#e2 div "3\.1%" 100,100 200×60/);
  assert.match(text, /on screen at @m2 \(3\.00 s\): same screen as scene start/);
  assert.match(text, /t400#e5 email: da•+le/);
  assert.match(text, /t400#e5 cell "da•+le" 400,360 300×30 \(privacy: email\)/);
  assert.ok(!text.includes("whitfield"), "secrets are masked in the pack too");
  assert.ok(text.length < 8000, "compact");
  suggestAnnotations({ projectDir: dir, timeline: TIMELINE, suggestions: STUB });
  editDraft(dir, 1, { op: "toggle", id: "ch-1" });
  saveDraft(dir);
  const re = annotationContext({
    projectDir: dir,
    timeline: TIMELINE,
    timelineVersion: 1,
    base: 2,
    instructions: "calmer please",
  });
  assert.match(re, /Re-suggest based on v2: the user's 1 changed item\(s\) are kept/);
  assert.match(re, /ch-1 chapter 01-dash .* on/);
  assert.match(re, /Instructions from the user: calmer please/);
});

test("tool input: one anchor kind, one target kind, defaults", () => {
  const s = toSuggestion({
    type: "zoom",
    scene: "a",
    anchor: { mark: "m", offsetMs: 0, word: "x" },
    target: { step: 2, text: "y" },
    alternatives: [{ layout: "t1#e2" }, {}],
    reason: "r",
  });
  assert.deepEqual(s.anchor, { mark: "m" });
  assert.deepEqual(s.target, { step: 2 });
  assert.deepEqual(s.alternatives, [{ layout: "t1#e2" }]);
  assert.equal(s.value, 3);
  assert.deepEqual(
    toSuggestion({
      type: "callout",
      scene: "a",
      anchor: { word: "EMEA", occurrence: 2 },
      text: "t",
      value: 4,
      reason: "",
    }).anchor,
    { word: "EMEA", occurrence: 2 },
  );
  assert.deepEqual(
    toSuggestion({ type: "chapter", scene: "a", anchor: {}, text: "t", value: 2, reason: "" })
      .anchor,
    { sceneStart: true },
  );
});

test("auto-suggest: the edit report hands over once per VO, only for new edits, only when enabled", () => {
  const dir = makeProject();
  const r = { timeline: TIMELINE } as unknown as EditResult;
  assert.match(
    autoSuggestNote(dir, true, "start", r),
    /Next — Annotations .*demo-annotations skill.*action=context/,
  );
  assert.equal(autoSuggestNote(dir, false, "start", r), "");
  assert.equal(autoSuggestNote(dir, true, "rerender", r), "");
  suggestAnnotations({ projectDir: dir, timeline: TIMELINE, suggestions: STUB.slice(0, 2) });
  assert.equal(autoSuggestNote(dir, true, "start", r), "", "VO v1 already has annotations");
  assert.match(
    autoSuggestNote(dir, true, "start", {
      timeline: { ...TIMELINE, voVersion: 2 },
    } as unknown as EditResult),
    /Next — Annotations/,
  );
});

test("word anchors resolve in a real file through the manifest", () => {
  const dir = makeProject();
  const rc = resolveContext(dir, TIMELINE);
  const r = resolveAnnotations(
    {
      version: 1,
      basedOn: { vo: 1 },
      take: "take-001",
      items: [
        {
          id: "w",
          type: "callout",
          scene: "01-dash",
          anchor: { word: "EMEA", occurrence: 2 },
          text: "again",
          enabled: true,
        },
      ],
    },
    rc,
  );
  // word 12 at 3.0 s of section audio, played from 0.5 s → 3.5 s
  assert.equal(r.items[0]?.atMs, 3500);
});

test("the fixture's stub designer file works on any recording: no take-specific layout refs", () => {
  const f = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, "..", "fixtures", "annotations", "stub-designer.json"),
      "utf8",
    ),
  ) as { suggestions: Record<string, unknown>[] };
  assert.ok(f.suggestions.length >= 10);
  for (const s of f.suggestions) {
    const targets = [s.target, ...((s.alternatives as unknown[]) ?? [])].filter(Boolean) as Record<
      string,
      unknown
    >[];
    for (const t of targets)
      assert.ok(!("layout" in t), `${s.id}: layout refs (t<ms>#e<n>) only exist in one take`);
    assert.doesNotThrow(() => toSuggestion(s));
  }
});
