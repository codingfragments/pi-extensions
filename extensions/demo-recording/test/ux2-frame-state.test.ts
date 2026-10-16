/**
 * UX2 (D98, D111): the hash routes and what the frame says. Pure logic, no browser.
 * The spec's explicit rules are pinned here: an approval on an unrelated branch does not complete a
 * stage; "waiting for the Director" is not "running"; no percentage is invented.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type JobData,
  type StagesData,
  failedJobs,
  newsTab,
  nextBand,
  pendingDrafts,
  stepStates,
  stripState,
} from "../src/panel/public/frame-state.js";
import {
  SCREENS,
  formatRoute,
  parseRoute,
  readLastPlace,
  writeLastPlace,
} from "../src/panel/public/route.js";

// ---------- routes ----------

test("routes: parse and format round-trip, versions and items included", () => {
  for (const hash of [
    "#/project",
    "#/voice",
    "#/voice/v3",
    "#/voice/v3/01-dash",
    "#/render/v12/neutral_plain/full",
    "#/config?q=voice&scope=project",
  ]) {
    const r = parseRoute(hash);
    assert.ok(r?.valid, hash);
    assert.equal(formatRoute(r), hash, hash);
  }
  assert.deepEqual(parseRoute("#/voice/v3/01-dash"), {
    screen: "voice",
    version: 3,
    item: "01-dash",
    query: {},
    raw: "#/voice/v3/01-dash",
    valid: true,
  });
  assert.equal(parseRoute("")?.valid, undefined, "an empty hash is no route");
  assert.equal(parseRoute("#/"), null);
  assert.equal(parseRoute(""), null);
  assert.ok(SCREENS.includes("config") && SCREENS.includes("map"));
});

test("routes: an unknown or unavailable route says why instead of silently becoming something else", () => {
  const unknown = parseRoute("#/nowhere");
  assert.equal(unknown?.valid, false);
  assert.match(unknown?.reason ?? "", /“nowhere” is not a screen of this panel/);
  const map = parseRoute("#/map?view=approved&sel=vo:3");
  assert.equal(map?.valid, true, "the map is an overlay route now");
  assert.deepEqual(map?.query, { view: "approved", sel: "vo:3" });
  const badVersion = parseRoute("#/voice/three");
  assert.equal(badVersion?.valid, false);
  assert.match(badVersion?.reason ?? "", /not a version/);
  assert.equal(parseRoute("#/voice/%E0%A4%A")?.screen, "voice", "a broken escape does not throw");
});

test("routes: the last place is remembered per project, and only when it is still valid", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assert.equal(readLastPlace("keycraft", storage), null);
  writeLastPlace("keycraft", parseRoute("#/voice/v2"), storage);
  writeLastPlace("other", parseRoute("#/render"), storage);
  assert.equal(readLastPlace("keycraft", storage)?.screen, "voice");
  assert.equal(readLastPlace("other", storage)?.screen, "render");
  writeLastPlace("keycraft", parseRoute("#/nowhere"), storage); // invalid: not stored
  assert.equal(readLastPlace("keycraft", storage)?.screen, "voice");
  store.set("demo-rec-last:keycraft", "#/gone");
  assert.equal(
    readLastPlace("keycraft", storage),
    null,
    "a remembered place that is no longer valid is ignored",
  );
});

// ---------- stage states ----------

const stage = (
  s: string,
  o: Partial<{ selected: number; accepted: [number, string?][]; onInput: number[] }> = {},
) => ({
  stage: s,
  ...(o.selected !== undefined ? { selected: o.selected } : {}),
  accepted: (o.accepted ?? []).map(([version, orphaned]) => ({
    version,
    ...(orphaned ? { orphaned } : {}),
  })),
  onInput: o.onInput ?? [],
});
const data = (stages: ReturnType<typeof stage>[], next: StagesData["next"]): StagesData => ({
  project: "p",
  stages,
  next,
});
const ALL_DONE = [
  stage("storyboard", { selected: 1, accepted: [[1]], onInput: [1] }),
  stage("recording", { selected: 1, accepted: [[1]], onInput: [1] }),
  stage("vo", { selected: 1, accepted: [[1]], onInput: [1] }),
  stage("annotations", { selected: 1, accepted: [[1]], onInput: [1] }),
  stage("render", { selected: 2, accepted: [[2]], onInput: [1, 2] }),
];
const states = (s: StagesData, jobs: JobData[] = [], discovery = false) =>
  Object.fromEntries(
    Object.entries(stepStates({ stages: s, jobs, discovery })).map(([k, v]) => [k, v.state]),
  );

test("states: everything accepted on the working line is complete", () => {
  const s = data(ALL_DONE, { who: null, stage: null, text: "delivered" });
  assert.deepEqual(states(s), {
    storyboard: "complete",
    recording: "complete",
    voice: "complete",
    annotations: "complete",
    render: "complete",
  });
});

test("states: an approval on an unrelated branch does not complete the stage", () => {
  // voice-over v4 is accepted, but the working line has no voice-over: it belongs to another take
  const s = data(
    [
      stage("storyboard", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("recording", { selected: 2, accepted: [[1], [2]], onInput: [2] }),
      stage("vo", { accepted: [[4]], onInput: [] }),
      stage("annotations"),
      stage("render"),
    ],
    { who: "agent", stage: "vo", text: "the agent writes the voice-over for take-002" },
  );
  const st = states(s);
  assert.equal(st.voice, "upcoming");
  assert.equal(st.recording, "complete");
});

test("states: a newer draft after the newest accepted version needs you; an older one does not", () => {
  const s = data(
    [
      stage("storyboard", { selected: 2, accepted: [[2]], onInput: [1, 2, 3] }),
      stage("recording", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("vo", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("annotations", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("render"),
    ],
    { who: null, stage: null, text: "delivered" },
  );
  assert.deepEqual(
    pendingDrafts(s.stages?.[0]),
    [3],
    "v1 is superseded by accepted v2; v3 is newer",
  );
  const detail = stepStates({ stages: s, jobs: [] });
  assert.equal(detail.storyboard?.state, "needs");
  assert.equal(detail.storyboard?.pending, 1);
  assert.match(detail.storyboard?.why ?? "", /Storyboard v3 is waiting for review/);
});

test("states: blocked by an orphaned working-line version or a failed job; running by a real job only", () => {
  const orphaned = data(
    [
      stage("storyboard", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("recording", {
        selected: 1,
        accepted: [[1, "storyboard v1 is not approved"]],
        onInput: [1],
      }),
      stage("vo"),
      stage("annotations"),
      stage("render"),
    ],
    { who: "user", stage: "recording", text: "accept a take" },
  );
  assert.equal(states(orphaned).recording, "blocked");
  assert.match(
    stepStates({ stages: orphaned, jobs: [] }).recording?.why ?? "",
    /blocked: storyboard v1 is not approved/,
  );

  const base = data(ALL_DONE, { who: null, stage: null, text: "delivered" });
  const running: JobData[] = [{ id: "render-1", kind: "render", status: "running" }];
  assert.equal(states(base, running).render, "running");
  assert.equal(
    states(base, [], true).storyboard,
    "running",
    "a live discovery runs the storyboard stage",
  );
  const failed: JobData[] = [
    { id: "tts-2", kind: "tts", status: "failed", error: "quota exceeded\nstack" },
  ];
  assert.equal(states(base, failed).voice, "blocked");
  assert.match(
    stepStates({ stages: base, jobs: failed }).voice?.why ?? "",
    /Voice failed: quota exceeded$/,
  );
  // a later success clears the failure
  assert.equal(
    states(base, [{ id: "tts-3", kind: "tts", status: "done" }, ...failed]).voice,
    "complete",
  );
});

test("states: waiting for the Director is not running", () => {
  const s = data(
    [
      stage("storyboard", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("recording"),
      stage("vo"),
      stage("annotations"),
      stage("render"),
    ],
    { who: "agent", stage: "recording", text: "the agent records a take of storyboard v1" },
  );
  const detail = stepStates({ stages: s, jobs: [] });
  assert.equal(detail.recording?.state, "upcoming");
  assert.match(detail.recording?.why ?? "", /Waiting for the Director/);
  const band = nextBand({ stages: s, states: detail, jobs: [] });
  assert.equal(band?.tone, "idle");
  assert.equal(band?.label, "Waiting");
  assert.match(band?.title ?? "", /Nothing is running yet/);
});

// ---------- the band ----------

test("band: blocked before needs-you before waiting before done; other pending items are listed", () => {
  const s = data(
    [
      stage("storyboard", { selected: 1, accepted: [[1]], onInput: [1, 2] }),
      stage("recording", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("vo", { selected: 1, accepted: [[1]], onInput: [1, 2] }),
      stage("annotations", { selected: 1, accepted: [[1]], onInput: [1] }),
      stage("render", { selected: 1, accepted: [[1]], onInput: [1] }),
    ],
    { who: null, stage: null, text: "delivered — final v1 (Render tab)" },
  );
  const st = stepStates({ stages: s, jobs: [] });
  const band = nextBand({ stages: s, states: st, jobs: [] });
  assert.equal(band?.tone, "needs", "delivered, yet two drafts wait: it is not 'done'");
  assert.deepEqual(band?.action, { label: "Continue", tab: "storyboard" });
  assert.equal(band?.more.length, 1);
  assert.equal(band?.more[0]?.tab, "voice");

  const withFailure = stepStates({
    stages: s,
    jobs: [
      { id: "render-9", kind: "render", status: "failed", error: "ffmpeg exited with code 1" },
    ],
  });
  const blocked = nextBand({ stages: s, states: withFailure, jobs: [] });
  assert.equal(blocked?.tone, "blocked");
  assert.equal(blocked?.action?.tab, "render");

  const done = data(ALL_DONE, {
    who: null,
    stage: null,
    text: "delivered — final render v2 (Render tab)",
  });
  const doneBand = nextBand({
    stages: done,
    states: stepStates({ stages: done, jobs: [] }),
    jobs: [],
  });
  assert.equal(doneBand?.tone, "done");
  assert.equal(doneBand?.text, "Delivered — final render v2 (Render tab)");
  assert.equal(nextBand({ stages: { project: null }, states: {}, jobs: [] }), null);
});

// ---------- the strip ----------

test("strip: progress only when it is known; several jobs are counted; failures stay until dismissed", () => {
  const rows = [{ key: "take", state: "running", fraction: 0.4, title: "Recording" }];
  const one = stripState({
    jobs: [{ id: "record-1", kind: "record", status: "running" }],
    rows,
    status: "live",
  });
  assert.deepEqual([one.tone, one.text, one.progress], ["running", "Recording 40%", 40]);

  const noProgress = stripState({
    jobs: [{ id: "design-1", kind: "design", status: "running" }],
    rows: [],
    status: "live",
  });
  assert.deepEqual(
    [noProgress.text, noProgress.progress],
    ["Annotation designer", null],
    "no invented percentage",
  );

  const two = stripState({
    jobs: [
      { id: "record-1", kind: "record", status: "running" },
      { id: "render-1", kind: "render", status: "running" },
    ],
    rows,
    status: "live",
  });
  assert.match(two.text, /^2 running: Recording 40%, Render$/);
  assert.equal(two.progress, null, "several jobs: no single percentage");

  const failed: JobData[] = [
    { id: "tts-2", kind: "tts", status: "failed", error: "quota exceeded" },
  ];
  const err = stripState({ jobs: failed, rows: [], status: "live" });
  assert.deepEqual([err.tone, err.text], ["err", "Voice failed: quota exceeded"]);
  assert.equal(err.failure?.id, "tts-2");
  const dismissed = stripState({
    jobs: failed,
    rows: [],
    status: "live",
    dismissed: new Set(["tts-2"]),
  });
  assert.equal(dismissed.tone, "idle");
  assert.equal(failedJobs(failed).length, 1, "the failure is still listed for the drawer");

  const off = stripState({ jobs: [], rows: [], status: "reconnecting" });
  assert.deepEqual([off.tone, off.text], ["warn", "Disconnected from pi, reconnecting…"]);
  assert.equal(stripState({ jobs: [], rows: [], status: "live" }).text, "Nothing running");
});

// ---------- news ----------

test("news: the events that mean a result arrived, and not the user's own edits", () => {
  assert.equal(newsTab({ type: "storyboard.written" }), "storyboard");
  assert.equal(newsTab({ type: "take.finished" }), "recording");
  assert.equal(newsTab({ type: "vo.written", data: { by: "agent" } }), "voice");
  assert.equal(newsTab({ type: "vo.written", data: { by: "user" } }), null);
  assert.equal(newsTab({ type: "annotations.updated", data: { by: "agent" } }), "annotations");
  assert.equal(newsTab({ type: "annotations.updated", data: { by: "user" } }), null);
  assert.equal(newsTab({ type: "render.finished" }), "render");
  assert.equal(newsTab({ type: "log.line" }), null);
});
