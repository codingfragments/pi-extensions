/**
 * Item 6 (D-R2-9): several config changes at once. The batch is composed per file in memory, validated with the
 * real resolver after each change (a rejection names the setting), planned without writing, and written with one
 * write per file, all or nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { layerFiles, planBatch } from "../src/config-edit.ts";
import { resolveConfig } from "../src/config.ts";
import { configRoutes } from "../src/panel/config-routes.ts";
import { ensureProject } from "../src/workdir/layout.ts";

let root: string;
let globalFile: string;
let projectFile: string;
let projectDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-batch-"));
  globalFile = path.join(root, "global.json");
  fs.writeFileSync(
    globalFile,
    `${JSON.stringify({ _comment: "keep me", voiceName: "Stefan_trained", fps: 30 }, null, 2)}\n`,
  );
  const p = ensureProject(root, { project: "kc", appName: "KeyCraft", appUrl: "https://k.test" });
  projectDir = p.dir;
  projectFile = path.join(p.dir, "config.json");
  fs.writeFileSync(projectFile, `${JSON.stringify({ voiceName: "Calm narrator" }, null, 2)}\n`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const env = () => ({ DEMO_REC_CONFIG: globalFile });
const files = () => layerFiles(env(), os.homedir(), projectDir);

test("a batch over both files: one diff per file, what each change does, nothing written by planning", () => {
  const before = [fs.readFileSync(globalFile, "utf8"), fs.readFileSync(projectFile, "utf8")];
  const plan = planBatch(
    files(),
    [
      { scope: "global", key: "fps", value: 25 },
      { scope: "global", key: "render.keepDrafts", value: 3 },
      { scope: "project", key: "voiceName", unset: true },
      { scope: "project", key: "ttsChain", value: ["openai", "kokoro"] },
    ],
    { env: env(), home: os.homedir() },
  );
  assert.deepEqual(
    plan.files.map((f) => [f.scope, f.file]),
    [
      ["global", globalFile],
      ["project", projectFile],
    ],
    "one entry per file",
  );
  assert.match(plan.files[0]?.diff ?? "", /\+.*"fps": 25/);
  assert.match(plan.files[0]?.diff ?? "", /\+.*keepDrafts/, "both global changes in one diff");
  assert.match(plan.files[1]?.diff ?? "", /-.*Calm narrator/);
  assert.match(plan.files[1]?.diff ?? "", /\+.*kokoro/);
  const by = (k: string) => plan.changes.find((c) => c.key === k);
  assert.deepEqual([by("fps")?.before, by("fps")?.after, by("fps")?.effective], [30, 25, 25]);
  assert.equal(
    by("voiceName")?.effective,
    "Stefan_trained",
    "once the override is gone the global value is the effective one",
  );
  assert.deepEqual(
    [fs.readFileSync(globalFile, "utf8"), fs.readFileSync(projectFile, "utf8")],
    before,
  );
});

test("a rejected change names its setting and the whole batch is refused", () => {
  assert.throws(
    () =>
      planBatch(
        files(),
        [
          { scope: "global", key: "render.keepDrafts", value: 3 },
          { scope: "global", key: "fps", value: 0 },
        ],
        { env: env(), home: os.homedir() },
      ),
    /^Error: fps:/,
  );
  for (const [item, re] of [
    [{ scope: "global", key: "nope", value: 1 }, /unknown setting/],
    [{ scope: "global", key: "elevenlabsApiKey", value: "x" }, /secret/],
    [{ scope: "project", key: "root", value: "/tmp/x" }, /only be set globally/],
    [{ scope: "global", key: "tts.say.voice", unset: true }, /not set in the global config/],
    [{ scope: "global", key: "fps" }, /a value is required/],
  ] as const)
    assert.throws(
      () => planBatch(files(), [item], { env: env(), home: os.homedir() }),
      re,
      item.key,
    );
  assert.throws(
    () =>
      planBatch(
        files(),
        [
          { scope: "global", key: "fps", value: 20 },
          { scope: "global", key: "fps", value: 21 },
        ],
        { env: env(), home: os.homedir() },
      ),
    /changed twice/,
  );
  assert.throws(
    () =>
      planBatch(layerFiles(env(), os.homedir()), [{ scope: "project", key: "fps", value: 20 }], {
        env: env(),
        home: os.homedir(),
      }),
    /no active project/,
  );
});

test("a later change in the same file sees the earlier ones (the resolver gets the composed text)", () => {
  // viewport.width and height are validated together by the resolver? at least each alone must resolve on the composed file
  const plan = planBatch(
    files(),
    [
      { scope: "global", key: "viewport.width", value: 1280 },
      { scope: "global", key: "viewport.height", value: 720 },
    ],
    { env: env(), home: os.homedir() },
  );
  const text = JSON.parse(plan.files[0]?.newText ?? "{}");
  assert.deepEqual([text.viewport.width, text.viewport.height], [1280, 720]);
  assert.equal(text._comment, "keep me", "_comment kept");
});

test("shadowing is said per change: an environment variable wins, a project override wins over a global edit", () => {
  const plan = planBatch(
    files(),
    [
      { scope: "global", key: "voiceName", value: "Other" },
      { scope: "global", key: "brand", value: "neutral" },
      { scope: "global", key: "fps", value: 24 },
    ],
    { env: { ...env(), DEMO_REC_BRAND: "neutral" }, home: os.homedir() },
  );
  const by = (k: string) => plan.changes.find((c) => c.key === k);
  assert.match(by("voiceName")?.shadowedBy ?? "", /^project /);
  assert.match(by("brand")?.shadowedBy ?? "", /^env DEMO_REC_BRAND/);
  assert.equal(by("fps")?.shadowedBy, undefined);
});

test("the route: plan without confirm, one write per file with confirm, one event per change, an error writes nothing", () => {
  const published: { type: string; data: Record<string, unknown> }[] = [];
  let reloads = 0;
  const routes = configRoutes({
    activeProject: () => ({ dir: projectDir, slug: "kc" }) as never,
    reloadConfig: () => {
      reloads++;
      return {
        ...resolveConfig({ env: env(), projectConfigFile: projectFile }),
        root,
      };
    },
    publish: (type, data) => published.push({ type, data: data as Record<string, unknown> }),
    env: env(),
    home: os.homedir(),
  });
  const post = (b: Record<string, unknown>) =>
    (routes.post["config-batch"] as (b: Record<string, unknown>) => Record<string, unknown>)(b);
  const changes = [
    { key: "fps", scope: "global", value: 25 },
    { key: "voiceName", scope: "project", unset: true },
    { key: "recording.maxRetriesPerScene", scope: "project", value: 2 },
  ];
  const before = [fs.readFileSync(globalFile, "utf8"), fs.readFileSync(projectFile, "utf8")];
  const plan = post({ changes });
  assert.equal(plan.planned, true);
  assert.equal((plan.files as unknown[]).length, 2);
  assert.equal((plan.changes as unknown[]).length, 3);
  assert.deepEqual(
    [fs.readFileSync(globalFile, "utf8"), fs.readFileSync(projectFile, "utf8")],
    before,
    "planning writes nothing",
  );
  assert.equal(reloads, 0);

  // a bad change in the middle: nothing is written, the error names it
  assert.throws(
    () =>
      post({ changes: [changes[0], { key: "fps", scope: "project", value: -1 }], confirm: true }),
    /fps:/,
  );
  assert.deepEqual(
    [fs.readFileSync(globalFile, "utf8"), fs.readFileSync(projectFile, "utf8")],
    before,
    "all or nothing",
  );

  const done = post({ changes, confirm: true });
  assert.equal(done.saved, true);
  assert.equal(done.count, 3);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).fps, 25);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8"))._comment, "keep me");
  const proj = JSON.parse(fs.readFileSync(projectFile, "utf8"));
  assert.equal(proj.voiceName, undefined);
  assert.equal(proj.recording.maxRetriesPerScene, 2);
  assert.equal(reloads, 1, "the config is re-read once");
  assert.deepEqual(
    published.map((p) => [p.type, p.data.key, p.data.scope]),
    [
      ["config.changed", "fps", "global"],
      ["config.changed", "voiceName", "project"],
      ["config.changed", "recording.maxRetriesPerScene", "project"],
    ],
    "one event per change, so the log reads as before",
  );
  assert.throws(() => post({ changes: [] }), /non-empty list/);
  assert.throws(() => post({ changes: [{ scope: "global", value: 1 }] }), /"key" is required/);
  assert.throws(() => post({ changes: [{ key: "fps", scope: "global" }] }), /"value" is required/);
});
