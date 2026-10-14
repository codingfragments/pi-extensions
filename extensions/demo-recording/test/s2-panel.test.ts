/**
 * S2 panel review loop over real HTTP: storyboard GET, per-scene review,
 * submit → agent message, approve → gate + phase + agent message, POST
 * security, and media serving.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { EventBus } from "../src/bus.ts";
import { panelRoutes } from "../src/panel/routes.ts";
import { type PanelHandle, startPanel } from "../src/panel/server.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { appDir, ensureProject, openProject } from "../src/workdir/layout.ts";
import { readState, requireApproved } from "../src/workdir/state.ts";

const TOKEN = "k".repeat(64);
let root: string;
let panel: PanelHandle;
let base: string;
let notified: string[];
let bus: EventBus;
let projectDir: string;

const STORYBOARD = `start_url: /
scenes:
  - id: 01-a
    title: Dashboard
    screen: 20260612-101233/s001
    steps: [{ do: hover, target: { role: link, name: Search } }]
  - id: 02-b
    title: Search
    steps: [{ do: click, target: { role: link, name: Search } }]
`;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-panel-"));
  const project = ensureProject(root, {
    project: "p",
    appName: "Acme",
    appUrl: "https://acme.test",
  });
  projectDir = project.dir;
  writeStoryboard(project.dir, STORYBOARD);
  const shots = path.join(appDir(root, "acme"), "discovery", "20260612-101233", "screens");
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, "s001.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(root, "secret.txt"), "nope");
  notified = [];
  bus = new EventBus();
  const routes = panelRoutes({
    bus,
    activeProject: () => openProject(root, "p"),
    discovery: () => undefined,
    notifyAgent: (t) => notified.push(t),
  });
  panel = await startPanel({
    bus,
    port: 0,
    token: TOKEN,
    getState: () => ({}),
    get: routes.get,
    post: routes.post,
    media: () => ({ app: appDir(root, "acme"), project: project.dir }),
  });
  base = `http://127.0.0.1:${panel.port}`;
});

afterEach(async () => {
  await panel.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };
const get = (p: string) => fetch(`${base}${p}`, { headers: auth });
const post = (
  p: string,
  body: unknown,
  headers: Record<string, string> = { ...auth, "content-type": "application/json" },
) => fetch(`${base}${p}`, { method: "POST", headers, body: JSON.stringify(body) });

test("GET /api/storyboard returns the latest version with review state", async () => {
  const res = await get("/api/storyboard");
  assert.equal(res.status, 200);
  // biome-ignore lint/suspicious/noExplicitAny: test reads loosely-typed JSON
  const data: any = await res.json();
  assert.equal(data.version, 1);
  assert.deepEqual(data.versions, [1]);
  assert.equal(data.storyboard.scenes.length, 2);
  assert.deepEqual(data.accepted, []);
  assert.equal(data.selected, null);
  assert.deepEqual(data.review, { scenes: {} });
  assert.equal(data.diff, null);
});

test("review → submit sends ONE consolidated message to the agent", async () => {
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.type));
  assert.equal(
    (await post("/api/review", { version: 1, scene: "01-a", status: "approved" })).status,
    200,
  );
  assert.equal(
    (
      await post("/api/review", {
        version: 1,
        scene: "02-b",
        status: "changes",
        note: "type slower",
      })
    ).status,
    200,
  );
  assert.equal(notified.length, 0, "per-scene marks are drafts — no agent turn per click");

  const bad = await post("/api/review", { version: 1, scene: "99-x", status: "approved" });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /not in v1/);
  assert.equal(
    (await post("/api/review", { version: 1, scene: "01-a", status: "maybe" })).status,
    400,
  );

  const submit = await post("/api/review-submit", { version: 1 });
  assert.equal(submit.status, 200);
  assert.equal(notified.length, 1);
  assert.match(notified[0] ?? "", /02-b \(Search\): CHANGES — "type slower"/);
  assert.ok(events.includes("review.updated") && events.includes("review.submitted"));
  assert.ok(readState(projectDir)?.reviews?.["1"]?.submittedAt);
  // The submitted review is part of the project's memory (input log).
  const logged = readInputs(projectDir);
  assert.equal(logged.length, 1);
  assert.deepEqual(
    [logged[0]?.stage, logged[0]?.version, logged[0]?.source, logged[0]?.kind],
    ["storyboard", 1, "panel", "review"],
  );
  assert.match(logged[0]?.text ?? "", /02-b: changes — type slower/);
});

test("approve flips the gate, sets phase, informs the agent", async () => {
  const state0 = readState(projectDir);
  assert.ok(state0);
  assert.throws(() => requireApproved(state0, "storyboard"));
  assert.equal(
    (await post("/api/approve", { artifact: "storyboard", version: 2 })).status,
    400,
    "unknown version",
  );
  assert.equal(
    (await post("/api/approve", { artifact: "vo", version: 1 })).status,
    400,
    "only storyboard in S2",
  );

  const res = await post("/api/approve", { artifact: "storyboard", version: 1 });
  assert.equal(res.status, 200);
  const state = readState(projectDir);
  assert.ok(state);
  assert.equal(requireApproved(state, "storyboard"), 1);
  assert.equal(state.phase, "recording");
  assert.match(notified.at(-1) ?? "", /Storyboard v1 for project "p" is APPROVED/);
});

test("POST security: Bearer header only, JSON only", async () => {
  // Query token is accepted for GET (img/ws), never for state changes.
  const viaQuery = await fetch(`${base}/api/approve?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact: "storyboard", version: 1 }),
  });
  assert.equal(viaQuery.status, 401);
  // A form post (what a malicious page could send without preflight) is rejected.
  const form = await fetch(`${base}/api/approve`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: "artifact=storyboard&version=1",
  });
  assert.equal(form.status, 415);
  const broken = await fetch(`${base}/api/review`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: "{",
  });
  assert.equal(broken.status, 400);
  assert.equal((await post("/api/nope", {})).status, 404);
  assert.deepEqual(readState(projectDir)?.accepted, {}, "nothing got accepted");
});

test("media: token required, scoped to roots, no traversal, image types only", async () => {
  const ok = await fetch(
    `${base}/media/app/discovery/20260612-101233/screens/s001.jpg?token=${TOKEN}`,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.equal(
    (await fetch(`${base}/media/app/discovery/20260612-101233/screens/s001.jpg`)).status,
    401,
  );
  assert.equal((await fetch(`${base}/media/app/..%2F..%2Fsecret.txt?token=${TOKEN}`)).status, 404);
  assert.equal(
    (await fetch(`${base}/media/project/state.json?token=${TOKEN}`)).status,
    404,
    "json is not media",
  );
  assert.equal((await fetch(`${base}/media/other/x.jpg?token=${TOKEN}`)).status, 404);
});
