// Runs the tests of every extension with a temp folder of their own. The tests (and the browsers they start) create thousands of folders in $TMPDIR and many do not
// remove them; run this way, everything they leave goes into one folder that is deleted when the run ends, also on Ctrl-C. Pass test files to run only those.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const given = process.argv.slice(2);
const files = given.length
  ? given
  : fs
      .readdirSync(path.join(root, "extensions"))
      .flatMap((ext) => {
        const dir = path.join(root, "extensions", ext, "test");
        return fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((f) => f.endsWith(".test.ts"))
              .map((f) => path.join("extensions", ext, "test", f))
          : [];
      })
      .sort();

// a short name: a browser's profile folder (with its sockets) lives below it, and socket paths are short
const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-t-"));
const clean = () =>
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
const child = spawn(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TMPDIR: base, TMP: base, TEMP: base },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("close", (code, signal) => {
  clean();
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  clean();
  console.error(err);
  process.exit(1);
});
