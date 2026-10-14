/**
 * S5 part 8 — the Annotations tab's routes over HTTP, with a stub designer
 * (the fixed suggestion set the tool would receive): the view with resolved
 * timing and budget, draft edits, save (one version), discard, re-suggest
 * (an agent message + an input), accepting a version, and (with Chromium +
 * ffmpeg) a still preview from the draft.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { annotationVersions, readAnnotations } from "../src/annotations/file.ts";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { Runtime } from "../src/runtime.ts";
import { runSuggest, toSuggestion } from "../src/tools/annotations.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { acceptTake, approve, readState } from "../src/workdir/state.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const renderSkip =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-ann-panel-"));
  process.env.DEMO_REC_CONFIG = path.join(root, "none.json");
  process.env.DEMO_REC_NO_OPEN = "1";
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const TIMELINE = {
  schema: 1,
  take: "take-001",
  voVersion: 1,
  voice: { engine: "say", name: "x" },
  fps: 30,
  size: { width: 960, height: 540 },
  scenes: [
    {
      id: "01-a",
      title: "First",
      audioFile: null,
      pieces: [{ src: [0, 4000], speed: 1, kind: "static" }],
      audio: [],
      anchors: [{ mark: "m1", event: 1500, out: 1500, audioAt: 1500, drift: 0 }],
      durationMs: 4000,
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
    },
  ],
  full: [{ type: "scene", id: "01-a" }],
  totals: { fullMs: 4000, cutMs: 0, frozenMs: 0, silenceMs: 0, worstDriftMs: 0 },
};

function project(withVideo = false) {
  const h = ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
  const dir = h.dir;
  fs.mkdirSync(path.join(dir, "storyboard"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "storyboard", "v1.yaml"),
    "version: 1\nstart_url: /\nscenes:\n  - id: 01-a\n    title: First\n    steps:\n      - { do: hover, target: { css: '#k' }, mark: m1, dwell: 1s }\n",
  );
  const take = path.join(dir, "takes", "take-001");
  fs.mkdirSync(take, { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({
      take: "take-001",
      status: "ok",
      storyboardVersion: 1,
      viewport: { width: 800, height: 450, dpr: 2 },
      captureStats: { width: 1600, height: 900 },
    }),
  );
  fs.writeFileSync(
    path.join(take, "events.jsonl"),
    `${JSON.stringify({ t: 1500, type: "hover", scene: "01-a", step: 0, mark: "m1", box: { x: 100, y: 100, w: 200, h: 60 } })}\n`,
  );
  fs.writeFileSync(
    path.join(take, "layout.jsonl"),
    `${JSON.stringify({ t: 1500, reason: "mark", mark: "m1", scene: "01-a", url: "http://x/", scroll: { x: 0, y: 0 }, viewport: { w: 800, h: 450 }, els: [{ id: "e1", role: "div", box: { x: 100, y: 100, w: 200, h: 60 }, text: "3.1%" }] })}\n`,
  );
  if (withVideo)
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1600x900:r=30:d=4.2",
      "-pix_fmt",
      "yuv420p",
      "-y",
      path.join(take, "raw.mp4"),
    ]);
  fs.mkdirSync(path.join(dir, "vo"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vo", "script.v1.md"),
    "---\ntake: take-001\n---\n## 01-a — First\nLook. [@m1] Three point one.\n",
  );
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  fs.writeFileSync(path.join(dir, "edit", "timeline.v1.json"), JSON.stringify(TIMELINE));
  approve(dir, "storyboard", 1);
  acceptTake(dir, "take-001");
  approve(dir, "vo", 1);
  return dir;
}

const STUB = [
  {
    id: "zoom-kpi",
    type: "zoom",
    scene: "01-a",
    anchor: { mark: "m1" },
    target: { layout: "t1500#e1" },
    value: 5,
    reason: "the number",
  },
  {
    id: "hl-kpi",
    type: "highlight",
    scene: "01-a",
    anchor: { mark: "m1" },
    target: { step: 0 },
    value: 3,
    reason: "points at it",
  },
  {
    id: "co-kpi",
    type: "callout",
    scene: "01-a",
    anchor: { mark: "m1", offsetMs: 300 },
    text: "Headline churn",
    value: 3,
    reason: "names it",
  },
  {
    id: "ch-a",
    type: "chapter",
    scene: "01-a",
    anchor: { sceneStart: true },
    text: "First",
    value: 2,
    reason: "structure",
  },
];

async function panelFor() {
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
    root,
    panelPort: 0,
  }));
  const notified: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => notified.push(t);
  rt.setActiveProject("p");
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async (n: string) =>
    (await (await fetch(`${base}/api/${n}`, { headers: auth })).json()) as Record<string, unknown>;
  const post = async (n: string, body: unknown) => {
    const res = await fetch(`${base}/api/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { rt, panel, notified, get, post };
}

type View = {
  version: number | null;
  versions: number[];
  canSuggest: boolean;
  draft: { base: number; changes: number } | null;
  file: { items: { id: string; enabled: boolean; text?: string; anchor: { offsetMs?: number } }[] };
  resolved: Record<string, { startMs?: number; problem?: string }>;
  budget: { status: string; enabled: number };
  accepted: boolean;
};

test(
  "Annotations tab routes: empty state, stub-designer suggestions, draft edits, save, discard, re-suggest, accept",
  { timeout: 60_000 },
  async () => {
    const dir = project();
    const { rt, panel, notified, get, post } = await panelFor();
    try {
      let v = (await get("annotations")) as unknown as View;
      assert.equal(v.version, null);
      assert.equal(v.canSuggest, true, "VO accepted and an edit exists");
      // First suggestion run through the panel → an agent message
      let r = await post("annotations-resuggest", { version: null, instructions: "keep it calm" });
      assert.equal(r.status, 200, String(r.json.error));
      assert.match(
        notified.at(-1) ?? "",
        /Suggest annotations for project "p" \(VO v1\) — the user's instructions: "keep it calm"/,
      );
      assert.match(notified.at(-1) ?? "", /demo-annotations skill/);
      assert.ok(
        readInputs(dir).some((i) => i.stage === "annotations" && i.text === "keep it calm"),
        "logged as a project input",
      );
      // The stub designer answers (what the tool's suggest does)
      const report = runSuggest(rt, { suggestions: STUB.map((s) => toSuggestion(s)) });
      assert.match(report, /Annotations v1: 4 suggestion\(s\) placed/);
      v = (await get("annotations")) as unknown as View;
      assert.equal(v.version, 1);
      assert.equal(v.resolved["co-kpi"]?.startMs, 1650, "anchor 1.5 s + 0.3 s − 0.15 s lead");
      assert.ok(v.budget.enabled >= 1);
      const coOn = v.file.items.find((x) => x.id === "co-kpi")?.enabled;
      // Draft edits
      r = await post("annotations-edit", { version: 1, op: "toggle", id: "co-kpi" });
      assert.equal(r.status, 200, String(r.json.error));
      r = await post("annotations-edit", {
        version: 1,
        op: "text",
        id: "co-kpi",
        text: "3.1 % looks harmless",
      });
      r = await post("annotations-edit", {
        version: 1,
        op: "nudge",
        id: "co-kpi",
        field: "start",
        deltaMs: 500,
      });
      v = r.json as unknown as View;
      assert.equal(v.draft?.base, 1);
      assert.equal(v.draft?.changes, 3);
      const co = v.file.items.find((x) => x.id === "co-kpi");
      assert.equal(co?.enabled, !coOn);
      assert.equal(co?.text, "3.1 % looks harmless");
      assert.equal(co?.anchor.offsetMs, 800);
      assert.equal(v.resolved["co-kpi"]?.startMs, 2150, "timing re-resolved for the draft");
      // Errors come back as 4xx with a message
      r = await post("annotations-edit", {
        version: 1,
        op: "text",
        id: "co-kpi",
        text: "x".repeat(61),
      });
      assert.ok(r.status >= 400);
      assert.match(String(r.json.error), /≤ 60/);
      // Re-suggest refuses while there are unsaved changes; accept is a separate gate
      r = await post("annotations-resuggest", { version: 1, instructions: "x" });
      assert.ok(r.status >= 400);
      assert.match(String(r.json.error), /save or discard/);
      // Save → v2, one version for all edits
      r = await post("annotations-save", {});
      v = r.json as unknown as View;
      assert.equal(v.version, 2);
      assert.equal(v.draft, null);
      assert.deepEqual(annotationVersions(dir), [1, 2]);
      assert.equal(readAnnotations(dir, 2)?.editedFrom, 1);
      assert.ok(
        readInputs(dir).some(
          (i) => i.stage === "annotations" && /3 change\(s\) saved as v2/.test(i.text),
        ),
      );
      // Discard
      await post("annotations-edit", { version: 2, op: "toggle", id: "ch-a" });
      r = await post("annotations-discard", {});
      assert.equal((r.json as unknown as View).draft, null);
      assert.deepEqual(annotationVersions(dir), [1, 2]);
      // Re-suggest on v2 → agent message with base and the kept items rule
      r = await post("annotations-resuggest", { version: 2, instructions: "fewer zooms" });
      assert.equal(r.status, 200, String(r.json.error));
      assert.match(
        notified.at(-1) ?? "",
        /Re-suggest annotations for project "p" on top of v2 — the user's instructions: "fewer zooms".*action=context base=2.*action=suggest base=2.*changed items are kept/,
      );
      // Accept v2 through the stage routes (the generic gate)
      r = await post("approve", { artifact: "annotations", version: 2 });
      assert.equal(r.status, 200, String(r.json.error));
      assert.ok(readState(dir)?.accepted.annotations?.["2"]);
      v = (await get("annotations?version=2")) as unknown as View;
      assert.equal(v.accepted, true);
    } finally {
      await panel.close();
      await rt.shutdown();
    }
  },
);

test(
  "Annotations tab previews: still from the draft (1 frame), clip, scene draft — cached",
  { skip: renderSkip, timeout: 240_000 },
  async () => {
    project(true);
    const { rt, panel, get, post } = await panelFor();
    try {
      runSuggest(rt, { suggestions: STUB.map((s) => toSuggestion(s)) });
      await post("annotations-edit", { version: 1, op: "text", id: "co-kpi", text: "Draft text" });
      let r = await post("annotation-preview", { version: 1, id: "co-kpi", kind: "still" });
      assert.equal(r.status, 200, String(r.json.error));
      const still = String(r.json.still);
      assert.match(still, /^previews\/annotations\/stills\/co-kpi-[0-9a-f]+\.png$/);
      assert.equal(r.json.clip, undefined, "a still doesn't render the clip");
      const t0 = Date.now();
      r = await post("annotation-preview", { version: 1, id: "co-kpi", kind: "still" });
      assert.equal(r.json.still, still, "same content → same cached file");
      assert.ok(Date.now() - t0 < 1500);
      r = await post("annotation-preview", { version: 1, id: "zoom-kpi", kind: "clip" });
      assert.equal(r.status, 200, String(r.json.error));
      assert.match(String(r.json.clip), /^previews\/annotations\/clips\/zoom-kpi-[0-9a-f]+\.mp4$/);
      r = await post("annotations-scene-draft", { version: 1, scene: "01-a" });
      assert.equal(r.status, 200, String(r.json.error));
      assert.match(
        String(r.json.file),
        /^previews\/annotations\/scenes\/scene-01-a-[0-9a-f]+\.mp4$/,
      );
      const v = (await get("annotations")) as unknown as View;
      assert.equal(v.draft?.changes, 1, "previews don't touch the draft");
    } finally {
      await panel.close();
      await rt.shutdown();
    }
  },
);
