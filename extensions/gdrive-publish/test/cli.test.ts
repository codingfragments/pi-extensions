/**
 * CLI contract tests.
 *
 * These spawn the real CLI as a subprocess, because the exit code and stream
 * discipline *are* the contract for CI and git-hook use: 0 success, 1 runtime
 * failure, 2 usage error, 3 completed with errors. Credentials are forced to a
 * bogus env pair and HOME is redirected, so nothing can reach Google - any
 * command that would need the network fails before making a request.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as manifestIo from "../core/manifest.ts";

const CLI = path.join(import.meta.dirname, "..", "cli.ts");

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-cli-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-home-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      // Deterministic credentials that cannot be used against Google.
      GDRIVE_PUBLISH_CLIENT_ID: "test-client-id",
      GDRIVE_PUBLISH_CLIENT_SECRET: "test-secret",
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function write(rel: string, content: string): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function seedManifest(): void {
  const manifest = manifestIo.emptyManifest("fldROOT", "Test Docs");
  manifestIo.save(tmp, manifest);
}

test("help exits 0 and documents every command", () => {
  const { status, stdout } = run(["help"]);
  assert.equal(status, 0);
  for (const cmd of ["login", "init", "plan", "publish", "status"]) {
    assert.match(stdout, new RegExp(`\\b${cmd}\\b`), `usage should mention ${cmd}`);
  }
});

test("an unknown command is a usage error (exit 2)", () => {
  const { status, stderr } = run(["frobnicate"]);
  assert.equal(status, 2);
  assert.match(stderr, /unknown command/);
});

test("a missing directory argument is a usage error (exit 2)", () => {
  assert.equal(run(["plan"]).status, 2);
});

test("a non-existent directory is a usage error (exit 2)", () => {
  const { status, stderr } = run(["plan", path.join(tmp, "nope")]);
  assert.equal(status, 2);
  assert.match(stderr, /not a directory/);
});

test("init without --name is a usage error (exit 2)", () => {
  const { status, stderr } = run(["init", tmp]);
  assert.equal(status, 2);
  assert.match(stderr, /--name/);
});

test("plan works with no manifest and no network", () => {
  write("a.md", "# A\n[b](./b.md)\n");
  write("b.md", "# B\n");
  const { status, stdout } = run(["plan", tmp]);
  assert.equal(status, 0);
  assert.match(stdout, /\+ a\.md/);
  assert.match(stdout, /2 to create/);
});

test("plan --json emits valid, machine-readable output", () => {
  write("a.md", "# A\n");
  write("notes.txt", "x");
  const { status, stdout } = run(["plan", tmp, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    items: { relPath: string; action: string }[];
    diagnostics: { code: string }[];
  };
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.action, "create");
  assert.ok(parsed.diagnostics.some((d) => d.code === "UNSUPPORTED_FILE"));
});

test("plan surfaces link and image diagnostics offline", () => {
  // Regression guard for the gap where buildPlan() skipped prepareMarkdown(),
  // so `plan`/`--dry-run` silently understated what publish would report.
  write("a.md", "![huge](./huge.png)\n[missing](./nope.md)\n[anchor](./b.md#sec)\n");
  write("b.md", "# B\n");
  fs.writeFileSync(path.join(tmp, "huge.png"), Buffer.alloc(8 * 1024 * 1024, 3));
  const { status, stdout } = run(["plan", tmp, "--json"]);
  const parsed = JSON.parse(stdout) as { diagnostics: { code: string; severity: string }[] };
  const codes = parsed.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("DOC_PAYLOAD_TOO_LARGE"), "payload cap checked at plan time");
  assert.ok(codes.includes("LINK_TARGET_MISSING"), "broken links reported at plan time");
  assert.ok(codes.includes("ANCHOR_DROPPED"), "dropped anchors reported at plan time");
  assert.equal(status, 3, "an error-severity plan must exit 3");
});

test("plan reports nothing alarming for a clean tree and exits 0", () => {
  write("a.md", "# A\n[b](./b.md)\n");
  write("b.md", "# B\n[a](./a.md)\n");
  const { status, stdout } = run(["plan", tmp, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as { diagnostics: unknown[] };
  assert.deepEqual(parsed.diagnostics, []);
});

test("plan and publish agree on the diagnostics they report", () => {
  // The dry run is the review surface: it must not understate the outcome.
  write("a.md", ["---", "title: T", "---", "[x](./b.md#sec)", "[y](../out.md)"].join("\n"));
  write("b.md", "# B\n");
  seedManifest();
  const planCodes = (
    JSON.parse(run(["plan", tmp, "--json"]).stdout) as { diagnostics: { code: string }[] }
  ).diagnostics
    .map((d) => d.code)
    .sort();
  const dryRunCodes = (
    JSON.parse(run(["publish", tmp, "--dry-run", "--json"]).stdout) as {
      diagnostics: { code: string }[];
    }
  ).diagnostics
    .map((d) => d.code)
    .sort();
  assert.deepEqual(dryRunCodes, planCodes);
  assert.ok(planCodes.includes("ANCHOR_DROPPED"));
  assert.ok(planCodes.includes("LINK_OUTSIDE_ROOT"));
  assert.ok(planCodes.includes("FRONTMATTER_STRIPPED"));
});

test("publish without a manifest fails with guidance (exit 1)", () => {
  write("a.md", "# A\n");
  const { status, stderr } = run(["publish", tmp]);
  assert.equal(status, 1);
  assert.match(stderr, /no manifest/);
  assert.match(stderr, /gdrive-publish init/);
});

test("publish --dry-run writes nothing and never contacts Drive", () => {
  write("a.md", "# A\n");
  seedManifest();
  const before = fs.readFileSync(path.join(tmp, ".gdrive-manifest.json"), "utf8");
  const { status, stdout } = run(["publish", tmp, "--dry-run"]);
  assert.equal(status, 0);
  assert.match(stdout, /dry run: nothing was written/);
  assert.equal(
    fs.readFileSync(path.join(tmp, ".gdrive-manifest.json"), "utf8"),
    before,
    "the manifest must be untouched by a dry run",
  );
});

test("publish --dry-run --json is parseable and flagged", () => {
  write("a.md", "# A\n");
  seedManifest();
  const { status, stdout } = run(["publish", tmp, "--dry-run", "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as { dryRun: boolean; items: unknown[] };
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.items.length, 1);
});

test("status reports credentials and manifest state without network access", () => {
  seedManifest();
  const { status, stdout } = run(["status", tmp]);
  assert.equal(status, 0);
  assert.match(stdout, /credentials: env pair/);
  assert.match(stdout, /folder "Test Docs"/);
});

test("status --json exposes the credential identity hash", () => {
  seedManifest();
  const { status, stdout } = run(["status", tmp, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    credentials: { source: string; clientIdHash: string };
    manifest: { entries: number } | null;
  };
  assert.equal(parsed.credentials.source, "env pair");
  assert.match(parsed.credentials.clientIdHash, /^[0-9a-f]{8}$/);
  assert.equal(parsed.manifest?.entries, 0);
});

test("status without a manifest says so instead of failing", () => {
  const { status, stdout } = run(["status", tmp]);
  assert.equal(status, 0);
  assert.match(stdout, /manifest: none/);
});

test("publish fails cleanly when not authenticated (no token for this client)", () => {
  // HOME is a fresh temp dir, so no cached token exists for the env client.
  write("a.md", "# A\n");
  seedManifest();
  const { status, stderr } = run(["publish", tmp]);
  assert.equal(status, 1);
  assert.match(stderr, /not authenticated|gdrive-publish login/);
});

test("secrets never appear in output", () => {
  seedManifest();
  const { stdout, stderr } = run(["status", tmp, "--json"]);
  assert.doesNotMatch(stdout + stderr, /test-secret/, "the client secret must never be printed");
});
