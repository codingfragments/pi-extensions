/**
 * S5 part 10 — deterministic QA: value parsing and lookup (D71), the values
 * and footage checks on a synthetic project, summary / confirm / gate (D70,
 * D73), narration shifts and merged fixes (D74), and the media checks on a
 * generated clip.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import type { SceneTimeline, Timeline } from "../src/edit/timeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { canonNumber, pageHas, parseSpoken, spokenValues } from "../src/qa/numbers.ts";
import { applyShifts } from "../src/qa/overrides.ts";
import {
  LEAK_PHRASE,
  checkFootage,
  checkMedia,
  checkValues,
  confirmItem,
  fixRequest,
  qaBlocker,
  qaFile,
  summarize,
} from "../src/qa/run.ts";
import type { QaItem, QaReport } from "../src/qa/types.ts";
import { normalizeOptions } from "../src/render/run.ts";
import { type RenderRecord, saveRecord, startRecord } from "../src/render/store.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-qa-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// --- values: parsing ------------------------------------------------------------------

test("spoken and written numbers, names; small prose numbers are not values", () => {
  assert.deepEqual(parseSpoken("three point one percent".split(" "), 0), {
    value: "3.1",
    used: 3,
    scaled: false,
  });
  assert.deepEqual(parseSpoken("three hundred forty one accounts".split(" "), 0), {
    value: "341",
    used: 4,
    scaled: false,
  });
  assert.deepEqual(parseSpoken("four point eight two million".split(" "), 0), {
    value: "4.82",
    used: 5,
    scaled: true,
  });
  assert.equal(canonNumber("1,284"), "1284");
  assert.equal(canonNumber("14.20"), "14.2");
  const v = (s: string) => spokenValues(s.split(" ")).map((x) => `${x.kind}:${x.value}`);
  assert.deepEqual(v("Headline churn is three point one percent."), ["number:3.1"]);
  assert.deepEqual(
    v("Two questions, and the problem is on the table."),
    [],
    "“two questions” is prose",
  );
  assert.deepEqual(
    v("EMEA leads at 14.2%, ahead of North America."),
    ["number:14.2", "name:north america"],
    "EMEA opens the sentence",
  );
  assert.deepEqual(v("The chart says EMEA is far above."), ["name:emea"]);
  assert.deepEqual(v("It names the accounts, led by Litware Bank."), ["name:litware bank"]);
  assert.deepEqual(
    v("Plain language search. Churn by region."),
    [],
    "sentence starts are not names",
  );
  assert.deepEqual(v("I ask the assistant directly."), []);
  assert.deepEqual(v("We have $310K ARR and 1,284 accounts"), [
    "number:310",
    "name:arr",
    "number:1284",
  ]);
});

test("page lookup: whole number tokens, thousands separators, names case-insensitive", () => {
  const n = (value: string) => ({ kind: "number" as const, said: value, value, wordIndex: 0 });
  assert.ok(pageHas("Gross churn 3.1% +0.4 pts", n("3.1")));
  assert.ok(!pageHas("churn 13.1%", n("3.1")), "not inside another number");
  assert.ok(!pageHas("churn 3.15%", n("3.1")));
  assert.ok(pageHas("Active accounts 1,284", n("1284")));
  assert.ok(pageHas("$310K", n("310")));
  assert.ok(
    pageHas("Top accounts: LITWARE BANK", {
      kind: "name",
      said: "Litware Bank",
      value: "litware bank",
      wordIndex: 0,
    }),
  );
});

// --- a synthetic project for the checks ------------------------------------------------

const SCENE = {
  id: "01-a",
  title: "First",
  audioFile: "vo/audio/s1.wav",
  // take 0–6000; edit cuts 2000–3000 → scene: 0–2000 + 3000–6000 at 2000
  pieces: [
    { src: [0, 2000], speed: 1, kind: "static" },
    { src: [3000, 6000], speed: 1, kind: "static" },
  ],
  audio: [
    { src: [0, 1000], at: 0 },
    { src: [1000, 3000], at: 1500 },
  ],
  anchors: [{ mark: "m1", event: 3500, out: 2500, audioAt: 1500, drift: -1000 }],
  durationMs: 5000,
  stats: {
    cutMs: 1000,
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
  size: { width: 960, height: 540 },
  scenes: [SCENE],
  full: [{ type: "scene", id: "01-a" }],
  totals: { fullMs: 5000, cutMs: 1000, frozenMs: 0, silenceMs: 0, worstDriftMs: 0 },
} as unknown as Timeline;

function project(sayValue: string, shown: { t: number; text: string }[]) {
  const dir = path.join(root, "projects", "p");
  const take = path.join(dir, "takes", "take-001");
  fs.mkdirSync(path.join(take, "dom"), { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({
      take: "take-001",
      viewport: { width: 800, height: 450, dpr: 2 },
      captureStats: { width: 1600, height: 900 },
    }),
  );
  const ev = [
    {
      t: 3500,
      type: "hover",
      scene: "01-a",
      step: 0,
      mark: "m1",
      box: { x: 10, y: 10, w: 20, h: 20 },
    },
    {
      t: 2500,
      type: "console-error",
      scene: "01-a",
      data: { text: "cut away: never in the video" },
    },
    { t: 4000, type: "console-error", scene: "01-a", data: { text: "TypeError: x is undefined" } },
  ];
  fs.writeFileSync(
    path.join(take, "events.jsonl"),
    `${ev.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  const snaps = shown.map((s) => ({
    t: s.t,
    reason: "settle",
    scene: "01-a",
    url: "/",
    scroll: { x: 0, y: 0 },
    viewport: { w: 800, h: 450 },
    els: [{ id: "e1", role: "text", box: { x: 0, y: 0, w: 10, h: 10 }, text: s.text }],
  }));
  fs.writeFileSync(
    path.join(take, "layout.jsonl"),
    `${snaps.map((s) => JSON.stringify(s)).join("\n")}\n`,
  );
  fs.mkdirSync(path.join(take, "analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(take, "analysis", "analysis.json"),
    JSON.stringify({
      take: "take-001",
      scenes: [
        {
          id: "01-a",
          alerts: [
            { t: 1000, text: "Something went wrong", level: "error" },
            { t: 4500, text: "Saved", level: "info" },
            { t: 2500, text: "Failed (cut)", level: "error" },
          ],
        },
      ],
    }),
  );
  fs.mkdirSync(path.join(dir, "vo", "audio"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vo", "script.v1.md"),
    `---\ntake: take-001\n---\n## 01-a — First\nLook here. [@m1] Churn is ${sayValue} percent.\n`,
  );
  const said = ["Look", "here.", "Churn", "is", ...sayValue.split(" "), "percent."];
  const words = said.map((w, i) => ({
    w,
    seg: i < 2 ? 0 : 1,
    s: i < 2 ? i * 0.4 : 1 + (i - 2) * 0.3,
    e: (i < 2 ? i * 0.4 : 1 + (i - 2) * 0.3) + 0.25,
  }));
  fs.writeFileSync(
    path.join(dir, "vo", "audio", "v1.json"),
    JSON.stringify({
      schema: 1,
      voVersion: 1,
      take: "take-001",
      sections: {
        "01-a": {
          key: "01-a",
          file: "vo/audio/s1.wav",
          alignment: { durationSec: 3, words, anchors: { m1: 1 }, source: "transcript" },
        },
      },
    }),
  );
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  fs.writeFileSync(path.join(dir, "edit", "timeline.v1.json"), JSON.stringify(TIMELINE));
  return dir;
}

const ctx = (dir: string, extra: Partial<Parameters<typeof checkValues>[0]> = {}) =>
  ({
    projectDir: dir,
    config: { ...resolveConfig({ env: {} }), root },
    rec: {
      version: 1,
      kind: "final",
      basedOn: {},
      options: normalizeOptions({}),
      variants: [],
    } as unknown as RenderRecord,
    t: TIMELINE,
    takeDir: path.join(dir, "takes", "take-001"),
    snaps: JSON.parse(
      `[${fs
        .readFileSync(path.join(dir, "takes", "take-001", "layout.jsonl"), "utf8")
        .trim()
        .split("\n")
        .join(",")}]`,
    ),
    events: fs
      .readFileSync(path.join(dir, "takes", "take-001", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
    timing: { titleMs: 0, sceneStart: { "01-a": 1000 }, itemStart: [1000] },
    full: "",
    ...extra,
  }) as Parameters<typeof checkValues>[0];

test("values: on screen when said → nothing; only later in the scene → warning + shift fix; nowhere → a warning that needs your eyes", () => {
  // said at scene 1500 + 2×300 ms (word "three") ≈ 2100 → take 3100
  const ok = project("three point one", [{ t: 3000, text: "Gross churn 3.1%" }]);
  assert.deepEqual(checkValues(ctx(ok)), []);
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });

  const later = project("three point one", [
    { t: 3000, text: "loading…" },
    { t: 5000, text: "Gross churn 3.1%" },
  ]);
  const w = checkValues(ctx(later));
  assert.equal(w.length, 1);
  assert.equal(w[0]?.level, "warning");
  assert.match(
    w[0]?.message ?? "",
    /“three point one” \(3\.1\) is said at 0:03\.1 but shown at 0:05\.0 in 01-a/,
  );
  assert.equal(w[0]?.atMs, 1000 + 2100, "full-video time: scene start + said");
  assert.equal(w[0]?.fix?.kind, "shift-narration");
  assert.equal(w[0]?.fix?.anchor, "m1");
  assert.equal(w[0]?.fix?.deltaMs, 4000 - 2100 + 300, "shown at scene 4000, said at 2100, + 0.3 s");
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });

  const wrong = project("fourteen point three", [{ t: 3000, text: "EMEA 14.2%" }]);
  const b = checkValues(ctx(wrong));
  assert.deepEqual([b[0]?.level, b[0]?.high], ["warning", true], "never a hard stop");
  assert.match(
    b[0]?.message ?? "",
    /says “fourteen point three” \(14\.3\) — it isn't on screen anywhere in 01-a/,
  );
  assert.equal(b[0]?.fix, undefined, "content is never auto-fixed");
});

test("footage: error toasts and console errors in the used footage need your eyes; cut-away ones don't count; info toasts are plain warnings", () => {
  const dir = project("three point one", [{ t: 3000, text: "3.1%" }]);
  const items = checkFootage(ctx(dir));
  const msgs = items.map((i) => `${i.level}${i.high ? "+high" : ""}:${i.message.slice(0, 60)}`);
  assert.ok(
    msgs.some((m) =>
      m.startsWith("warning+high:an error message is on screen: “Something went wrong”"),
    ),
  );
  assert.ok(msgs.some((m) => m.startsWith("warning:a info message is on screen: “Saved”")));
  assert.ok(msgs.some((m) => m.startsWith("warning+high:the app logged a console error")));
  assert.ok(
    items.every((i) => i.level !== "blocking"),
    "footage is never a hard stop",
  );
  assert.ok(!items.some((i) => i.message.includes("cut")), "events in cut footage are ignored");
  const ce = items.find((i) => i.message.includes("TypeError"));
  assert.equal(ce?.atMs, 1000 + 2000 + 1000, "take 4000 → scene 3000 → full 4000");
});

// --- summary, confirm, gate, fixes ---------------------------------------------------------

test("summary, confirm rules, gate; fixes merge with the render's own overrides", () => {
  const dir = project("three point one", [{ t: 3000, text: "3.1%" }]);
  const items: QaItem[] = [
    {
      id: "drift-1",
      check: "drift",
      level: "warning",
      high: true,
      scene: "01-a",
      atMs: 2000,
      message: "late",
      fix: {
        kind: "shift-narration",
        scene: "01-a",
        anchor: "m1",
        deltaMs: -400,
        label: "earlier",
      },
    },
    { id: "media-2", check: "media", level: "warning", message: "pause" },
    {
      id: "annotations-3",
      check: "annotations",
      level: "blocking",
      hard: "redaction",
      message: "redaction r1 doesn't cover its element here",
    },
    {
      id: "media-4",
      check: "media",
      level: "blocking",
      hard: "integrity",
      message: "the audio is silent",
    },
  ];
  const rec = startRecord(dir, {
    kind: "final",
    basedOn: { annotations: 1 },
    timeline: 1,
    voVersion: 1,
    take: "take-001",
    by: "cli",
    options: normalizeOptions({}),
    brands: ["neutral"],
    size: { width: 960, height: 540 },
  });
  rec.status = "done";
  rec.qa = summarize(items);
  saveRecord(dir, rec);
  assert.deepEqual(
    [rec.qa.status, rec.qa.blocking, rec.qa.high, rec.qa.warnings],
    ["blocked", 2, 1, 2],
    "two hard stops; the late narration needs your eyes but stops nothing",
  );
  assert.match(qaBlocker(rec) ?? "", /2 hard stop\(s\)/);
  assert.match(qaBlocker({ ...rec, qa: null }) ?? "", /QA has not run/);
  fs.writeFileSync(
    qaFile(dir, rec.version),
    JSON.stringify({
      render: rec.version,
      variant: "neutral",
      createdAt: "x",
      whisper: true,
      items,
    } satisfies QaReport),
  );
  assert.throws(
    () => confirmItem(dir, rec.version, "media-2", "fine"),
    /not a hard stop — it does not need a confirmation/,
  );
  assert.throws(
    () => confirmItem(dir, rec.version, "media-4", "fine", new Date(), LEAK_PHRASE),
    /a broken file, not a judgement call.*render again/,
    "an integrity defect cannot be confirmed, whatever is typed",
  );
  assert.throws(
    () => confirmItem(dir, rec.version, "annotations-3", "test data"),
    /type “accept the leak”/,
    "a leaking redaction needs the typed acknowledgement",
  );
  assert.throws(
    () => confirmItem(dir, rec.version, "annotations-3", " ", new Date(), "Accept the leak"),
    /reason is required/,
  );
  const c = confirmItem(
    dir,
    rec.version,
    "annotations-3",
    "all test data",
    new Date(),
    "Accept the leak",
  );
  assert.equal(c.summary.status, "blocked", "the integrity stop is still there");
  assert.equal(c.summary.confirmed, 1);
  assert.match(qaBlocker({ ...rec, qa: c.summary }) ?? "", /1 hard stop\(s\)/);
  // without the integrity defect the confirmed leak lets it through
  const ok = summarize(c.report.items.filter((i) => i.id !== "media-4"));
  assert.equal(ok.status, "confirmed");
  assert.equal(qaBlocker({ ...rec, qa: ok }), undefined);
  // fixes: the render already carried a +600 ms shift of the same segment → merged to +200
  fs.writeFileSync(
    path.join(dir, "render", `v${rec.version}.overrides.json`),
    JSON.stringify({
      fromRender: 0,
      shifts: [
        {
          kind: "shift-narration",
          scene: "01-a",
          anchor: "m1",
          deltaMs: 600,
          label: "earlier fix",
        },
      ],
    }),
  );
  const req = fixRequest(dir, rec.version, "all", "panel");
  assert.equal(req.kind, "final");
  assert.equal(req.annotations, 1);
  assert.deepEqual(
    req.overrides?.shifts.map((s) => [s.anchor, s.deltaMs]),
    [["m1", 200]],
  );
  assert.throws(() => fixRequest(dir, rec.version, ["media-2"], "panel"), /no fixable items/);
});

test("narration shifts: the segment moves, later ones are pushed, anchors follow, the scene holds its end when needed", () => {
  const dir = project("three point one", [{ t: 3000, text: "3.1%" }]);
  const r = applyShifts(dir, TIMELINE, [
    { kind: "shift-narration", scene: "01-a", anchor: "m1", deltaMs: 1000, label: "later" },
  ]);
  const sc = r.timeline.scenes[0] as SceneTimeline;
  assert.equal(sc.audio[1]?.at, 2500);
  assert.equal(sc.anchors[0]?.audioAt, 2500);
  assert.equal(sc.anchors[0]?.drift, 0, "lands on its event now");
  // narration now ends at 2500 + 2000 = 4500 (+0.2 s) → fits in 5000
  assert.equal(sc.durationMs, 5000);
  const far = applyShifts(dir, TIMELINE, [
    { kind: "shift-narration", scene: "01-a", anchor: "m1", deltaMs: 3000, label: "much later" },
  ]);
  const fs2 = far.timeline.scenes[0] as SceneTimeline;
  assert.equal(fs2.durationMs, 4500 + 2000 + 200, "end held so the narration fits");
  assert.ok("freeze" in (fs2.pieces.at(-1) as object));
  // earlier: never before the previous segment's end
  const early = applyShifts(dir, TIMELINE, [
    { kind: "shift-narration", scene: "01-a", anchor: "m1", deltaMs: -5000, label: "earlier" },
  ]);
  assert.equal((early.timeline.scenes[0] as SceneTimeline).audio[1]?.at, 1000);
  assert.equal(TIMELINE.scenes[0]?.audio[1]?.at, 1500, "the edit's timeline itself is untouched");
  const none = applyShifts(dir, TIMELINE, [
    { kind: "shift-narration", scene: "01-a", anchor: "nope", deltaMs: 100, label: "x" },
  ]);
  assert.match(none.skipped[0]?.why ?? "", /no narration segment @nope/);
});

test(
  "media: an unexplained still picture warns, a held frame of the edit is info, black frames warn",
  { skip: !hasBinary("ffmpeg") && "needs ffmpeg" },
  async () => {
    const dir = project("three point one", [{ t: 3000, text: "3.1%" }]);
    const clip = path.join(root, "clip.mp4");
    // 0–2 s moving, 2–9 s still (7 s), 9–10 s black; silent audio throughout
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=320x180:r=30:d=7",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map",
      "[v]",
      "-map",
      "3:a",
      "-t",
      "10",
      "-pix_fmt",
      "yuv420p",
      "-y",
      clip,
    ]);
    // the edit holds nothing in 2–9 s (pieces are "motion")
    const t = structuredClone(TIMELINE) as Timeline;
    (t.scenes[0] as SceneTimeline).pieces = [
      { src: [0, 10000], speed: 1, kind: "motion" },
    ] as never;
    (t.scenes[0] as SceneTimeline).durationMs = 10000;
    const c = ctx(dir, {
      t,
      full: clip,
      timing: { titleMs: 0, sceneStart: { "01-a": 0 }, itemStart: [0] },
      rec: {
        version: 1,
        kind: "final",
        basedOn: {},
        options: normalizeOptions({}),
        variants: [{ durationSec: 10 }],
      } as unknown as RenderRecord,
    });
    const items = await checkMedia(c);
    const still = items.find((i) => /stands still for 7\.\d s/.test(i.message));
    assert.equal(still?.level, "warning", items.map((i) => i.message).join("; "));
    assert.ok(items.some((i) => i.level === "warning" && /black picture/.test(i.message)));
    assert.ok(
      items.some((i) => /no narration for/.test(i.message)),
      "silence detected",
    );
    // the same still stretch inside an edit hold is info
    (t.scenes[0] as SceneTimeline).pieces = [
      { src: [0, 2000], speed: 1, kind: "motion" },
      { freeze: { at: 2000, dur: 7000 } },
      { src: [2000, 3000], speed: 1, kind: "motion" },
    ] as never;
    const heldItems = await checkMedia(c);
    assert.equal(
      heldItems.some((i) => /stands still for/.test(i.message)),
      false,
      "an expected hold is not a warning",
    );
    const held = heldItems.find((i) => /held frame/.test(i.message));
    assert.equal(held?.level, "info");
    assert.match(
      held?.message ?? "",
      /^1 held frame where the picture stands still \(7\.\d s in all/,
    );
  },
);

test(
  "media: expected holds and short pauses collapse into one line each, with where they are",
  { skip: !hasBinary("ffmpeg") && "needs ffmpeg" },
  async () => {
    const dir = project("three point one", [{ t: 3000, text: "3.1%" }]);
    const clip = path.join(root, "noise.mp4");
    // moving 1 s, still 3.5 s, moving 1 s, still 3.5 s, moving 1 s; narration with two 3 s gaps
    const seg = (src: string) => ["-f", "lavfi", "-i", src];
    execFileSync("ffmpeg", [
      "-v",
      "error",
      ...seg("testsrc2=s=320x180:r=30:d=1"),
      ...seg("color=c=gray:s=320x180:r=30:d=3.5"),
      ...seg("testsrc2=s=320x180:r=30:d=1"),
      ...seg("color=c=gray:s=320x180:r=30:d=3.5"),
      ...seg("testsrc2=s=320x180:r=30:d=1"),
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=if(lt(mod(t\\,6)\\,3)\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=10",
      "-filter_complex",
      "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0[v]",
      "-map",
      "[v]",
      "-map",
      "5:a",
      "-t",
      "10",
      "-pix_fmt",
      "yuv420p",
      "-y",
      clip,
    ]);
    const t = structuredClone(TIMELINE) as Timeline;
    (t.scenes[0] as SceneTimeline).pieces = [
      { src: [0, 1000], speed: 1, kind: "motion" },
      { freeze: { at: 1000, dur: 3500 } },
      { src: [1000, 2000], speed: 1, kind: "motion" },
      { freeze: { at: 2000, dur: 3500 } },
      { src: [2000, 3000], speed: 1, kind: "motion" },
    ] as never;
    (t.scenes[0] as SceneTimeline).durationMs = 10000;
    const c = ctx(dir, {
      t,
      full: clip,
      timing: { titleMs: 0, sceneStart: { "01-a": 0 }, itemStart: [0] },
      rec: {
        version: 1,
        kind: "final",
        basedOn: {},
        options: normalizeOptions({}),
        variants: [{ durationSec: 10 }],
      } as unknown as RenderRecord,
    });
    const items = await checkMedia(c);
    const holds = items.filter((i) => /held frame/.test(i.message));
    assert.equal(holds.length, 1, items.map((i) => i.message).join("; "));
    assert.match(holds[0]?.message ?? "", /^2 held frames where the picture stands still/);
    assert.equal(holds[0]?.moments?.length, 2, "where each one is");
    assert.equal(holds[0]?.level, "info");
    const pauses = items.filter((i) => /short pauses? in the narration/.test(i.message));
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0]?.level, "info");
  },
);
