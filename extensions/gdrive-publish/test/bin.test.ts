/**
 * Launcher (bin shim) tests.
 *
 * The shim is the only plain-JS file in the package and the first thing every
 * npx/npm/brew user executes, so its contract is tested like everything else:
 * it must run the real CLI under this Node, pass arguments through, and exit
 * with the child's code.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const BIN = path.join(import.meta.dirname, "..", "bin", "gdrive-publish.js");

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: process.env.HOME ?? "/tmp",
      GDRIVE_PUBLISH_CLIENT_ID: "test-client-id",
      GDRIVE_PUBLISH_CLIENT_SECRET: "test-secret",
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the launcher runs the real CLI and passes arguments through", () => {
  const { status, stdout, stderr } = run(["--version"]);
  assert.equal(status, 0, `stderr was: ${stderr}`);
  assert.match(stdout.trim(), /^gdrive-publish \d+\.\d+\.\d+$/);
});

test("the launcher exits with the child's exit code", () => {
  // `help` on an unknown command is a usage error (exit 2) - the shim must
  // propagate it rather than always exiting 0.
  const { status, stderr } = run(["no-such-command"]);
  assert.equal(status, 2);
  assert.match(stderr, /unknown command/);
});

test("the launcher handles a flag-only invocation", () => {
  const { status, stdout } = run(["--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /Commands/);
});
