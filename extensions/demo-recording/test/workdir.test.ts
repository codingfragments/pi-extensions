import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ensureProject,
  listProjects,
  normalizeUrl,
  openProject,
  slugify,
} from "../src/workdir/layout.ts";
import {
  approve,
  readState,
  requireApproved,
  setPhase,
  updateState,
} from "../src/workdir/state.ts";
import {
  createNextNumberedDir,
  latestVersion,
  listVersions,
  writeFileAtomic,
  writeNextVersion,
} from "../src/workdir/versioning.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-wd-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("slugify", () => {
  assert.equal(slugify("Acme Churn PoC — Q3!"), "acme-churn-poc-q3");
  assert.equal(slugify("Café Analytics"), "cafe-analytics");
  assert.throws(() => slugify("!!!"), /cannot derive a slug/);
});

test("normalizeUrl only accepts http(s)", () => {
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
  assert.throws(() => normalizeUrl("file:///etc/passwd"), /only http\(s\)/);
  assert.throws(() => normalizeUrl("nope"), /not a valid URL/);
});

test("ensureProject creates the full layout, app is shared, auth is 0700", () => {
  const h = ensureProject(root, {
    project: "Churn PoC",
    appName: "Acme Analytics",
    appUrl: "https://acme.test",
  });
  assert.equal(h.created, true);
  assert.equal(h.slug, "churn-poc");
  for (const sub of ["context", "storyboard", "takes", "vo", "edit", "out", "jobs"]) {
    assert.ok(fs.statSync(path.join(h.dir, sub)).isDirectory(), sub);
  }
  assert.ok(fs.existsSync(path.join(h.dir, "brief.md")));
  const appDir = path.join(root, "apps", "acme-analytics");
  assert.ok(fs.existsSync(path.join(appDir, "app.json")));
  assert.equal(fs.statSync(path.join(appDir, "auth")).mode & 0o777, 0o700);

  const second = ensureProject(root, {
    project: "Search Demo",
    appName: "Acme Analytics",
    appUrl: "https://other.test",
  });
  assert.equal(second.app.baseUrl, "https://acme.test/", "existing app.json is never rewritten");
  assert.deepEqual(listProjects(root), ["churn-poc", "search-demo"]);
});

test("ensureProject is idempotent and never clobbers an edited brief", () => {
  const h = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  fs.writeFileSync(path.join(h.dir, "brief.md"), "edited");
  const again = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  assert.equal(again.created, false);
  assert.equal(fs.readFileSync(path.join(h.dir, "brief.md"), "utf8"), "edited");
});

test("openProject errors clearly for unknown projects", () => {
  assert.throws(() => openProject(root, "missing"), /no demo project "missing"/);
});

test("versioning: monotonic, never overwrites, survives a racing writer", () => {
  const dir = path.join(root, "storyboard");
  assert.equal(latestVersion(dir, "v", ".yaml"), undefined);
  const a = writeNextVersion(dir, "v", ".yaml", "one");
  const b = writeNextVersion(dir, "v", ".yaml", "two");
  assert.deepEqual([a.version, b.version], [1, 2]);
  assert.equal(fs.readFileSync(a.file, "utf8"), "one");

  // Simulate a racer that grabbed v3 between our scan and our write: we must get v4.
  fs.writeFileSync(path.join(dir, "v3.yaml"), "racer");
  const c = writeNextVersion(dir, "v", ".yaml", "three");
  assert.equal(c.version, 4);
  assert.equal(fs.readFileSync(path.join(dir, "v3.yaml"), "utf8"), "racer");
  assert.deepEqual(listVersions(dir, "v", ".yaml"), [1, 2, 3, 4]);
  // Unrelated files are ignored.
  fs.writeFileSync(path.join(dir, "v10.yaml.bak"), "");
  assert.equal(latestVersion(dir, "v", ".yaml"), 4);
});

test("numbered dirs: take-001, take-002 … never reused", () => {
  const takes = path.join(root, "takes");
  assert.equal(path.basename(createNextNumberedDir(takes, "take-").file), "take-001");
  assert.equal(path.basename(createNextNumberedDir(takes, "take-").file), "take-002");
  fs.mkdirSync(path.join(takes, "take-007"));
  assert.equal(path.basename(createNextNumberedDir(takes, "take-").file), "take-008");
});

test("writeFileAtomic leaves no temp files", () => {
  const file = path.join(root, "x", "state.json");
  writeFileAtomic(file, "a");
  writeFileAtomic(file, "b");
  assert.equal(fs.readFileSync(file, "utf8"), "b");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
});

test("state: history, phase, approval gates", () => {
  const h = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  assert.equal(h.state.phase, "brief");
  assert.throws(() => requireApproved(h.state, "storyboard"), /storyboard is not approved yet/);

  setPhase(h.dir, "storyboard-review");
  assert.throws(() => approve(h.dir, "storyboard", 2), /storyboard v2 does not exist/);
  fs.mkdirSync(path.join(h.dir, "storyboard"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "storyboard", "v2.yaml"), "version: 2\n");
  const s = approve(h.dir, "storyboard", 2);
  assert.equal(requireApproved(s, "storyboard"), 2);
  assert.throws(() => requireApproved(s, "vo"), /voice-over is not approved yet/);
  assert.throws(() => approve(h.dir, "vo", 0), /invalid voice-over version/);

  updateState(h.dir, "note", undefined, { by: "test" });
  const final = readState(h.dir);
  assert.ok(final);
  assert.equal(final.phase, "storyboard-review");
  assert.deepEqual(
    final.history.map((e) => e.event),
    ["project-created", "phase-changed", "accepted", "note"],
  );
});
