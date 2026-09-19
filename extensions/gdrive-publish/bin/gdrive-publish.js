#!/usr/bin/env node
/**
 * Launcher for the gdrive-publish CLI.
 *
 * The CLI is plain TypeScript executed through Node's native type stripping,
 * so this shim does three things:
 *
 *  - Node >= 23.6: type stripping is on by default - import the TS entry
 *    directly, no re-exec.
 *  - Node 22.6 - 23.5: stripping exists but is flagged - re-exec the entry
 *    with --experimental-strip-types (and silence the experimental warning).
 *  - Node < 22.6: type stripping does not exist - fail with a clear message
 *    instead of a syntax error about `interface`.
 */

const cliUrl = new URL("../cli.ts", import.meta.url);
const [major, minor] = process.versions.node.split(".").map((n) => Number(n));
const unflagged = major > 23 || (major === 23 && minor >= 6);

if (unflagged) {
  await import(cliUrl.href);
} else if ((major === 22 && minor >= 6) || major === 23) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", cliUrl.pathname, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
} else {
  console.error(
    `gdrive-publish requires Node 22.6 or newer (found ${process.versions.node}). Install Node 24+, or run it with a newer runtime, e.g.:
  npx -p node@24 gdrive-publish <command>
  brew install node`,
  );
  process.exit(1);
}
