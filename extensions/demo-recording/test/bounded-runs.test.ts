/**
 * Nothing waits for ever: ffmpeg/uv/say commands and the short-lived browsers (login probe, brand previews, overlay rendering) have deadlines; one that does not finish
 * is diagnosed (into <root>/diagnostics/), killed with everything it started, and the caller is told so.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { launchBounded, withBrowser } from "../src/browser/bounded.ts";
import { processesOf } from "../src/browser/processes.ts";
import { resolveConfig } from "../src/config.ts";
import { run } from "../src/media/ffmpeg.ts";
import { defaultTimeoutMs, setDiagnosticsDir, setToolTimeoutMin } from "../src/util/bounded.ts";

let diag: string;
before(() => {
  diag = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-bounded-"));
  setDiagnosticsDir(diag);
});

const alive = (needle: string) => {
  try {
    return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
};

async function chromiumOk() {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumOk()) && "chromium not installed";

test("the deadlines: a probe is quick, ffmpeg and uv have the configured minutes, say ten, 0 means never", () => {
  setToolTimeoutMin(30);
  assert.equal(defaultTimeoutMs("ffprobe"), 60_000);
  assert.equal(defaultTimeoutMs("/usr/local/bin/ffmpeg"), 30 * 60_000);
  assert.equal(defaultTimeoutMs("uv"), 30 * 60_000);
  assert.equal(defaultTimeoutMs("say"), 600_000);
  setToolTimeoutMin(5);
  assert.equal(defaultTimeoutMs("ffmpeg"), 300_000);
  setToolTimeoutMin(0);
  assert.equal(defaultTimeoutMs("uv"), 0, "never");
  setToolTimeoutMin(30);
});

test("config: media.toolTimeoutMin defaults to 30 and is checked", () => {
  const read = (json: unknown) =>
    resolveConfig({
      env: { DEMO_REC_CONFIG: "/x.json" },
      home: "/h",
      readFile: () => JSON.stringify(json),
    });
  assert.equal(
    resolveConfig({ env: {}, home: "/h", readFile: () => undefined }).media.toolTimeoutMin,
    30,
  );
  assert.equal(read({ media: { toolTimeoutMin: 0 } }).media.toolTimeoutMin, 0);
  assert.throws(() => read({ media: { toolTimeoutMin: -1 } }), /toolTimeoutMin/);
  assert.throws(() => read({ media: { toolTimeoutMin: 2.5 } }), /toolTimeoutMin/);
});

test("a command that finishes, or fails, behaves as before", async () => {
  const ok = await run("echo", ["hi"]);
  assert.equal(ok.stdout.trim(), "hi");
  await assert.rejects(run("sh", ["-c", "echo boom >&2; exit 3"]), /sh exited with 3:\nboom/);
  await assert.rejects(run("definitely-not-a-command-xyz", []), /definitely-not-a-command-xyz: /);
});

test("a command that does not finish is diagnosed and killed with everything it started, and the error says where to look", async () => {
  const marker = "31.4159";
  const t = Date.now();
  await assert.rejects(
    run("sh", ["-c", `echo started >&2; sleep ${marker} & wait`], { timeoutMs: 800 }),
    (e: Error) => {
      assert.match(
        e.message,
        /^sh did not finish within 1 s and was killed \(diagnosis: .*process-.*-sh\.txt\)\nlast output:\nstarted/,
      );
      return true;
    },
  );
  assert.ok(Date.now() - t < 15_000, `ended soon after the deadline (${Date.now() - t} ms)`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(`sleep ${marker}`), false, "the grandchild is gone too");
  const files = fs.readdirSync(diag).filter((f) => /^process-.*-sh\.txt$/.test(f));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(diag, files[0] as string), "utf8");
  assert.match(text, /^STUCK: sh/);
  assert.match(text, /command: sh -c echo started >&2; sleep 31\.4159 & wait/);
  assert.match(text, /ran \d+\.\d s, limit 1 s/);
  assert.match(text, /process tree/);
  assert.match(text, /last of its output:\nstarted/);
  assert.match(text, /machine: \{/);
});

test("an abort kills the command at once and says it was cancelled", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t = Date.now();
  await assert.rejects(
    run("sleep", ["30"], { signal: ac.signal }),
    /^Error: sleep was cancelled|sleep was cancelled/,
  );
  assert.ok(Date.now() - t < 5000);
});

test(
  "a bounded browser: its processes are found by their marker and gone after close",
  { skip, timeout: 60_000 },
  async () => {
    const b = await launchBounded();
    assert.ok(processesOf(b.marker).length > 0);
    await b.close();
    await b.close(); // twice is fine
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(processesOf(b.marker), []);
  },
);

test(
  "withBrowser: the result comes back; a job that hangs is diagnosed, its browser killed, and the error says so",
  { skip, timeout: 60_000 },
  async () => {
    const quick = await withBrowser("quick job", async (browser) => {
      await browser.newPage();
      return 7;
    });
    assert.equal(quick, 7);
    const t = Date.now();
    await assert.rejects(
      withBrowser(
        "hanging job",
        async (browser) => {
          await browser.newPage();
          await new Promise(() => undefined);
        },
        { deadlineMs: 1500 },
      ),
      (e: Error) => {
        assert.match(
          e.message,
          /^hanging job did not answer within 2 s: the browser did not answer and was killed \(diagnosis: .*process-.*chromium\.txt\)$/,
        );
        return true;
      },
    );
    assert.ok(Date.now() - t < 20_000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alive("--demo-rec-session=dr-"), false, "no browser of ours is left running");
    assert.ok(
      fs.readdirSync(diag).some((f) => /^process-.*-chromium\.txt$/.test(f)),
      "diagnosed",
    );
  },
);
