/**
 * Publish-config tests: pattern matching (gitignore-style semantics),
 * load/save round trips, derivation and merging - the machinery behind
 * opt-in raw uploads.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  cautionPatterns,
  derivePatterns,
  loadConfig,
  matchesPattern,
  mergePatterns,
  saveConfig,
} from "../core/config.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-config-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("basename patterns match at any depth", () => {
  assert.ok(matchesPattern("*.zip", "asset.zip"));
  assert.ok(matchesPattern("*.zip", "deep/nested/asset.zip"));
  assert.ok(matchesPattern("*.json", "data/spec.json"));
  assert.ok(!matchesPattern("*.zip", "asset.zip.bak"));
});

test("patterns with a slash are anchored to the root", () => {
  assert.ok(matchesPattern("data/*.json", "data/spec.json"));
  assert.ok(!matchesPattern("data/*.json", "other/spec.json"));
  assert.ok(!matchesPattern("data/*.json", "sub/data/spec.json"));
});

test("** spans segments, ? matches one character", () => {
  assert.ok(matchesPattern("archives/**", "archives/2024/backup.zip"));
  assert.ok(matchesPattern("archives/**", "archives/backup.zip"));
  assert.ok(matchesPattern("report??.txt", "report01.txt"));
  assert.ok(!matchesPattern("report??.txt", "report1.txt"));
  assert.ok(matchesPattern("**/*.log", "a/b/c/run.log"));
});

test("special regex characters in patterns do not leak", () => {
  assert.ok(matchesPattern("a.b.txt", "a.b.txt"));
  assert.ok(!matchesPattern("a.b.txt", "axb.txt"));
});

test("loadConfig: absent file is null, present file round-trips", () => {
  assert.equal(loadConfig(root), null);
  saveConfig(root, { rawPatterns: ["*.zip", "data/*.json"] });
  const loaded = loadConfig(root);
  assert.deepEqual(loaded?.rawPatterns, ["*.zip", "data/*.json"]);
});

test("loadConfig: invalid JSON and unknown keys are hard errors", () => {
  fs.writeFileSync(path.join(root, ".gdrive-publish.json"), "{ not json");
  assert.throws(() => loadConfig(root), /not valid JSON/);
  fs.writeFileSync(path.join(root, ".gdrive-publish.json"), '{"other": 1}');
  assert.throws(() => loadConfig(root), /unknown key "other"/);
  fs.writeFileSync(path.join(root, ".gdrive-publish.json"), '{"rawPatterns": "nope"}');
  assert.throws(() => loadConfig(root), /array of strings/);
});

test("saveConfig writes atomically and leaves no temp files", () => {
  saveConfig(root, { rawPatterns: ["*.txt"] });
  assert.ok(fs.existsSync(path.join(root, ".gdrive-publish.json")));
  const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("derivePatterns: one pattern per extension, extensionless listed", () => {
  const derived = derivePatterns(["notes.txt", "cfg.yaml", "docs/readme.txt", "Makefile"]);
  assert.deepEqual(derived.patterns, ["*.txt", "*.yaml"]);
  assert.deepEqual(derived.extensionless, ["Makefile"]);
});

test("mergePatterns unions, dedupes and never drops existing entries", () => {
  assert.deepEqual(mergePatterns(["*.zip", "*.txt"], ["*.txt", "*.yaml"]), [
    "*.txt",
    "*.yaml",
    "*.zip",
  ]);
});

test("cautionPatterns flags credential-adjacent extensions", () => {
  const flagged = cautionPatterns(["*.zip", "*.env", "*.pem", "id_rsa", "*.yaml"]);
  assert.deepEqual(flagged, ["*.env", "*.pem", "id_rsa"]);
});
