import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { EventBus } from "../src/bus.ts";
import { voReviewMessage } from "../src/panel/bridge.ts";
import { panelRoutes } from "../src/panel/routes.ts";
import { type PanelHandle, startPanel } from "../src/panel/server.ts";
import { voTemplate } from "../src/tools/vo.ts";
import {
  parseVo,
  resolveBindings,
  speechSeconds,
  splitSegments,
  validateVo,
  wordCount,
} from "../src/vo/script.ts";
import { editVoSection, readVo, voVersions, writeVo } from "../src/vo/store.ts";
import { ensureProject, openProject } from "../src/workdir/layout.ts";
import { acceptTake, approve, readState, requireApproved } from "../src/workdir/state.ts";

function analysis(take = "take-001"): TakeAnalysis {
  const scene = (
    id: string,
    start: number,
    end: number,
    marks: [string, number][],
    idle: [number, number][] = [],
  ) => ({
    id,
    title: id,
    start,
    end,
    marks: marks.map(([mark, t]) => ({ mark, t, type: "wait-satisfied" })),
    typed: [],
    alerts: [],
    idle: idle.map(([s, e]) => ({ start: s, end: e, source: "observer" as const })),
    streaming: [],
    motion: [],
    protected: [],
    keyframes: [],
  });
  return {
    take,
    takeDir: "/x",
    storyboardVersion: 1,
    durationMs: 30000,
    viewport: { width: 1600, height: 900, dpr: 2 },
    scenes: [
      scene("01-dash", 700, 5000, [["emea-bar", 3000]]),
      scene(
        "02-search",
        5000,
        15000,
        [
          ["type-start", 6000],
          ["results", 12000],
        ],
        [[8000, 12000]],
      ),
    ],
    createdAt: "",
  };
}

const GOOD = `---
take: take-001
---
## _intro
Churn looks fine. It isn't.

## 01-dash — Dashboard
Headline churn is 3.1 percent. [@emea-bar] EMEA is the outlier.
<!-- writer note, not spoken -->

## _bridge:02-search
So I'll just ask.

## 02-search
Natural-language search. [@type-start] Churn by region. [@results] EMEA leads at {{dom:results|EMEA\\s+([\\d.]+%)}}.

## _outro
Two questions, one answer.
`;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-vo-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("parse: sections, kinds, segments, comments stripped", () => {
  const vo = parseVo(GOOD);
  assert.equal(vo.take, "take-001");
  assert.deepEqual(
    vo.sections.map((s) => [s.key, s.kind, s.scene]),
    [
      ["_intro", "intro", undefined],
      ["01-dash", "scene", "01-dash"],
      ["_bridge:02-search", "bridge", "02-search"],
      ["02-search", "scene", "02-search"],
      ["_outro", "outro", undefined],
    ],
  );
  assert.deepEqual(vo.sections[1]?.segments, [
    { text: "Headline churn is 3.1 percent." },
    { anchor: "emea-bar", text: "EMEA is the outlier." },
  ]);
  assert.ok(!vo.sections[1]?.body.includes("writer note"));
  assert.deepEqual(splitSegments("[@a] first [@b] second"), [
    { anchor: "a", text: "first" },
    { anchor: "b", text: "second" },
  ]);
  assert.throws(() => parseVo("## x\nhi"), /front matter/);
  assert.throws(() => parseVo("---\ntake: take-001\n---\n## Bad Heading!\nx"), /unknown section/);
  assert.throws(() => parseVo("---\ntake: take-001\n---\n## a\nx\n## a\ny"), /duplicate section/);
});

test("words and speech time at ~155 wpm", () => {
  assert.equal(
    wordCount("EMEA leads at {{dom:results|x}} — six times."),
    6,
    "a binding is one spoken word",
  );
  assert.equal(speechSeconds("one two three four five six seven eight nine ten"), 3.9);
});

test("bindings resolve from page text; failures are reported", () => {
  const dom = '- row "EMEA 14.2% 341":\n  - cell "14.2%"';
  const errors: string[] = [];
  assert.equal(
    resolveBindings(
      "at {{dom:results|EMEA\\s+([\\d.]+%)}}.",
      () => dom,
      (e) => errors.push(e),
    ),
    "at 14.2%.",
  );
  resolveBindings(
    "{{dom:results|APAC ([\\d.]+%)}}",
    () => dom,
    (e) => errors.push(e),
  );
  resolveBindings(
    "{{dom:nope|x}}",
    () => undefined,
    (e) => errors.push(e),
  );
  resolveBindings(
    "{{dom:results|([}}",
    () => dom,
    (e) => errors.push(e),
  );
  assert.equal(errors.length, 3);
  assert.match(errors[0] ?? "", /pattern not found/);
  assert.match(errors[1] ?? "", /no page text captured at @nope/);
  assert.match(errors[2] ?? "", /invalid regex/);
});

function withDom(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "results.yaml"), '- row "EMEA 14.2% 341"');
}

test("validate: good script resolves, timing per scene, no errors", () => {
  const domDir = path.join(root, "dom");
  withDom(domDir);
  const v = validateVo(parseVo(GOOD), analysis(), domDir);
  assert.deepEqual(
    v.issues.filter((i) => i.level === "error"),
    [],
  );
  assert.match(v.resolved[3]?.body ?? "", /EMEA leads at 14\.2%\./);
  const search = v.timing.find((t) => t.section === "02-search");
  assert.equal(search?.usableSec, 6, "10 s scene minus 4 s dead time");
});

test("validate: unknown scene, unknown/out-of-order anchors, anchors outside scenes, filler, timing", () => {
  const domDir = path.join(root, "dom");
  withDom(domDir);
  const bad = `---
take: take-002
---
## _intro
Hi [@emea-bar] there.
## 01-dash
A seamless, powerful dashboard. [@nope] x
## 02-search
${"word ".repeat(40)} [@results] then [@type-start] back.
## 99-ghost
boo
`;
  const v = validateVo(parseVo(bad), analysis(), domDir);
  const msgs = v.issues.map((i) => `${i.level} ${i.section}: ${i.message}`);
  const has = (re: RegExp) =>
    assert.ok(
      msgs.some((m) => re.test(m)),
      `${re} in\n${msgs.join("\n")}`,
    );
  has(/error \(front matter\): script is for take-002/);
  has(/error _intro: anchors are only allowed in scene sections/);
  has(/error 01-dash: \[@nope\] is not a mark of 01-dash \(marks: @emea-bar\)/);
  has(/error 02-search: \[@type-start\] is out of order/);
  has(/error 99-ghost: scene "99-ghost" is not in take-001/);
  has(/warning 01-dash: avoid "seamless"/);
  has(/warning 01-dash: avoid "powerful"/);
  has(/warning 02-search: ~\d+(\.\d)?s of speech for ~6s of footage/);
});

test("store: errors never consume a version; inline section edit makes a new version", () => {
  const p = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  const takeDir = path.join(p.dir, "takes", "take-001");
  fs.mkdirSync(path.join(takeDir, "analysis"), { recursive: true });
  fs.writeFileSync(path.join(takeDir, "analysis", "analysis.json"), JSON.stringify(analysis()));
  withDom(path.join(takeDir, "dom"));

  assert.throws(
    () => writeVo(p.dir, GOOD.replace("[@results]", "[@ghost]")),
    /voice-over not stored — fix these:\n- 02-search: \[@ghost\]/,
  );
  assert.deepEqual(voVersions(p.dir), []);
  const v1 = writeVo(p.dir, GOOD);
  assert.equal(v1.version, 1);
  const v2 = editVoSection(
    p.dir,
    1,
    "01-dash",
    "Churn is 3.1 percent. [@emea-bar] EMEA isn't fine.",
  );
  assert.equal(v2.version, 2);
  assert.match(
    readVo(p.dir, 2)?.text ?? "",
    /## 01-dash — Dashboard\nChurn is 3\.1 percent\. \[@emea-bar\] EMEA isn't fine\.\n\n## _bridge:02-search/,
  );
  assert.match(readVo(p.dir, 1)?.text ?? "", /Headline churn/, "v1 untouched");
  assert.throws(() => editVoSection(p.dir, 2, "nope", "x"), /section "nope" is not in v2/);
  assert.throws(
    () => writeVo(p.dir, GOOD.replace("take: take-001", "take: take-009")),
    /take-009 has not been analyzed/,
  );
});

test("template: one section per scene with marks and word budget", () => {
  const t = voTemplate(analysis());
  assert.match(t, /^---\ntake: take-001\n---/);
  assert.match(
    t,
    /## 02-search — 02-search\n<!-- ~6\.0s usable footage → ~14 words max\. Marks: \[@type-start\] 6\.0s, \[@results\] 12\.0s -->/,
  );
  assert.match(t, /## _bridge:02-search/);
  assert.ok(!/_bridge:01-dash/.test(t), "no bridge before the first scene");
  assert.doesNotThrow(() => parseVo(t));
});

test("voReviewMessage: consolidated, keeps approved verbatim", () => {
  const msg = voReviewMessage("p", 3, ["_intro", "01-dash", "02-search"], {
    scenes: {
      "01-dash": { status: "changes", note: "punchier", at: "" },
      _intro: { status: "approved", at: "" },
    },
  });
  assert.match(msg, /^\[demo-panel · You\] Voice-over v3 review for project "p":/);
  assert.match(msg, /- 01-dash: CHANGES — "punchier"/);
  assert.match(msg, /not reviewed: 02-search/);
  assert.match(msg, /write v4 with demo_rec_vo/);
});

// ---------- panel routes over HTTP ----------

let panel: PanelHandle | undefined;
afterEach(async () => {
  await panel?.close();
  panel = undefined;
});

test("panel: GET vo, per-section review, inline edit, approve gate", async () => {
  const p = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  const takeDir = path.join(p.dir, "takes", "take-001");
  fs.mkdirSync(path.join(takeDir, "analysis"), { recursive: true });
  fs.writeFileSync(path.join(takeDir, "analysis", "analysis.json"), JSON.stringify(analysis()));
  withDom(path.join(takeDir, "dom"));
  writeVo(p.dir, GOOD);
  const notified: string[] = [];
  const bus = new EventBus();
  const routes = panelRoutes({
    bus,
    activeProject: () => openProject(root, "p"),
    discovery: () => undefined,
    notifyAgent: (t) => notified.push(t),
  });
  const token = "z".repeat(64);
  panel = await startPanel({
    bus,
    port: 0,
    token,
    getState: () => ({}),
    get: routes.get,
    post: routes.post,
  });
  const base = `http://127.0.0.1:${panel.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (u: string, b: unknown) =>
    fetch(`${base}${u}`, { method: "POST", headers, body: JSON.stringify(b) });

  // biome-ignore lint/suspicious/noExplicitAny: loosely-typed JSON in a test
  const vo: any = await (await fetch(`${base}/api/vo`, { headers })).json();
  assert.equal(vo.version, 1);
  assert.equal(vo.take, "take-001");
  assert.equal(vo.sections.length, 5);
  assert.match(vo.sections[3].spoken, /14\.2%/, "bindings resolved for display");
  assert.deepEqual([vo.accepted, vo.selected], [[], null]);

  assert.equal(
    (
      await post("/api/review", {
        artifact: "vo",
        version: 1,
        scene: "01-dash",
        status: "changes",
        note: "shorter",
      })
    ).status,
    200,
  );
  assert.equal(
    (await post("/api/review", { artifact: "vo", version: 1, scene: "nope", status: "approved" }))
      .status,
    400,
  );
  assert.equal((await post("/api/review-submit", { artifact: "vo", version: 1 })).status, 200);
  assert.match(notified.at(-1) ?? "", /Voice-over v1 review.*\n- 01-dash: CHANGES — "shorter"/);

  const edit = await post("/api/vo-edit", {
    version: 1,
    section: "01-dash",
    text: "Shorter. [@emea-bar] EMEA isn't fine.",
  });
  assert.equal(edit.status, 200);
  assert.deepEqual(await edit.json(), { version: 2 });
  const badEdit = await post("/api/vo-edit", {
    version: 2,
    section: "01-dash",
    text: "x [@ghost] y",
  });
  assert.equal(badEdit.status, 400, "an invalid edit is rejected and stores nothing");
  assert.deepEqual(voVersions(p.dir), [1, 2]);

  assert.throws(() => requireApproved(readState(p.dir) ?? p.state, "vo"));
  // Stage chain: the voice-over needs an accepted recording, which needs an approved storyboard.
  const chainless = await post("/api/approve", { artifact: "vo", version: 2 });
  assert.equal(chainless.status, 400);
  assert.match(
    ((await chainless.json()) as { error: string }).error,
    /based on recording take-001, which is not approved — approve that recording first/,
  );
  fs.mkdirSync(path.join(p.dir, "storyboard"), { recursive: true });
  fs.writeFileSync(path.join(p.dir, "storyboard", "v1.yaml"), "version: 1\n");
  fs.writeFileSync(
    path.join(takeDir, "take.json"),
    JSON.stringify({ take: "take-001", storyboardVersion: 1 }),
  );
  approve(p.dir, "storyboard", 1);
  acceptTake(p.dir, "take-001");
  assert.equal((await post("/api/approve", { artifact: "vo", version: 2 })).status, 200);
  const state = readState(p.dir);
  assert.ok(state);
  assert.equal(requireApproved(state, "vo"), 2);
  assert.equal(state.phase, "voice-edit");
  assert.match(notified.at(-1) ?? "", /Voice-over script v2 .* APPROVED/);
});
