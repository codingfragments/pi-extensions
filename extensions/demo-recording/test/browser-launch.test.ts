/**
 * One way to start a browser: serialized, retried on the Bun spawn race and on nothing else, logged; a killed browser leaves no profile folder; our own old leftovers in
 * the temp folder are swept and nothing else; and the tests of the repo run with a temp folder of their own.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import type { Browser } from "playwright";
import { testPrefixes } from "../scripts/clean-temp.ts";
import { launchBounded } from "../src/browser/bounded.ts";
import {
  LAUNCH_GAP_MS,
  LAUNCH_TRIES,
  isBunSpawnRace,
  launchChromium,
  noteBrowserClosed,
} from "../src/browser/launch.ts";
import {
  isThrowawayProfile,
  killMarker,
  processesOf,
  userDataDirsOf,
} from "../src/browser/processes.ts";
import { setDiagnosticsDir } from "../src/util/bounded.ts";
import { OWN_TEMP, sweepTemp } from "../src/util/janitor.ts";

let diag: string;
before(() => {
  diag = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-launch-"));
  setDiagnosticsDir(diag);
});

const raceError = () =>
  Object.assign(new Error("Failed to connect"), {
    syscall: "connect",
    code: "ENOENT",
    errno: -2,
    stack:
      'error: Failed to connect\n  syscall: "connect"\n  at #createStdioObject (node:child_process:622:42)\n  at spawn (node:child_process:701:30)\n  at launchProcess (playwright-core/lib/coreBundle.js:10036:39)',
  });
const fakeBrowser = () => ({ on: () => undefined }) as unknown as Browser;
const lines = () =>
  fs.existsSync(path.join(diag, "launches.jsonl"))
    ? fs
        .readFileSync(path.join(diag, "launches.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

test("the Bun spawn race is told from real launch failures", () => {
  assert.equal(isBunSpawnRace(raceError()), true);
  assert.equal(
    isBunSpawnRace(
      Object.assign(new Error("connect ENOENT"), {
        syscall: "connect",
        code: "ENOENT",
        stack: "at launchProcess",
      }),
    ),
    true,
    "the code and the syscall are enough where the message differs",
  );
  assert.equal(
    isBunSpawnRace(new Error("browserType.launch: Executable doesn't exist at /x/chrome")),
    false,
  );
  assert.equal(
    isBunSpawnRace(new Error("spawn /x/chrome ENOENT")),
    false,
    "a missing executable is not the race",
  );
  assert.equal(
    isBunSpawnRace(
      new Error("Failed to connect to the bus: Could not parse server address\nat launchProcess"),
    ),
    false,
  );
  assert.equal(isBunSpawnRace(undefined), false);
});

test("a launch that hits the race is retried and succeeds; every try is in the log", async () => {
  let calls = 0;
  const before = lines().length;
  const b = await launchChromium({}, "retry-test", async () => {
    if (++calls < 3) throw raceError();
    return fakeBrowser();
  });
  assert.ok(b);
  assert.equal(calls, 3);
  const mine = lines().slice(before);
  assert.deepEqual(
    mine.map((l) => [l.label, l.ok, l.attempt, l.race ?? null]),
    [
      ["retry-test", false, 1, true],
      ["retry-test", false, 2, true],
      ["retry-test", true, 3, null],
    ],
  );
  assert.equal(typeof mine[0]?.tmpEntries, "number", "a failure says how full the temp folder was");
});

test("any other failure is not retried; the race that never goes away fails after the tries, saying what it is", async () => {
  let calls = 0;
  await assert.rejects(
    launchChromium({}, "other", async () => {
      calls++;
      throw new Error("browserType.launch: Executable doesn't exist");
    }),
    /Executable doesn't exist/,
  );
  assert.equal(calls, 1, "one try");
  calls = 0;
  await assert.rejects(
    launchChromium({}, "always", async () => {
      calls++;
      throw raceError();
    }),
    (e: Error) => {
      assert.match(
        e.message,
        /^the browser could not be started after 3 tries \(always\): Bun failed to connect the browser's pipes \(ENOENT in child_process, oven-sh\/bun#34785\)\. It is transient: try the action again/,
      );
      assert.match(e.message, /launches\.jsonl/);
      assert.equal((e.cause as Error).message, "Failed to connect");
      return true;
    },
  );
  assert.equal(calls, LAUNCH_TRIES);
});

test("launches are one at a time, and wait a moment after a browser was closed", async () => {
  let active = 0;
  let maxActive = 0;
  const starts: number[] = [];
  const slow = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 80));
    active--;
    return fakeBrowser();
  };
  await Promise.all([
    launchChromium({}, "a", slow),
    launchChromium({}, "b", slow),
    launchChromium({}, "c", slow),
  ]);
  assert.equal(maxActive, 1, "never two at once");
  noteBrowserClosed();
  const t = Date.now();
  await launchChromium({}, "after-close", async () => {
    assert.ok(Date.now() - t >= LAUNCH_GAP_MS - 30, `waited ${Date.now() - t} ms after the close`);
    return fakeBrowser();
  });
});

async function chromiumOk() {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumOk()) && "chromium not installed";

test("a killed browser leaves no profile folder behind", { skip, timeout: 60_000 }, async () => {
  const b = await launchBounded();
  const dirs = userDataDirsOf(processesOf(b.marker));
  assert.equal(dirs.length >= 1, true, "the browser has a profile folder");
  for (const d of dirs) {
    assert.equal(isThrowawayProfile(d), true, `${d} is Playwright's own`);
    assert.ok(fs.existsSync(d));
  }
  assert.ok(killMarker(b.marker) > 0);
  await new Promise((r) => setTimeout(r, 400));
  for (const d of dirs) assert.equal(fs.existsSync(d), false, `${d} is gone`);
  await b.close();
  assert.ok(
    lines().some((l) => l.label === "short-lived" && l.ok === true),
    "the real launch is in the log too",
  );
});

test("only a throwaway profile folder is ever removed after a kill", () => {
  assert.equal(isThrowawayProfile("/var/T/playwright_chromiumdev_profile-AbC123"), true);
  assert.equal(isThrowawayProfile("/Users/me/Library/Application Support/Google/Chrome"), false);
  assert.equal(isThrowawayProfile("/var/T/my-profile"), false);
});

test("the sweep removes our own old folders, and nothing newer, in use, or from another tool", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-sweep-"));
  const mk = (name: string, ageH: number) => {
    const p = path.join(dir, name);
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, "f"), "x");
    const t = new Date(Date.now() - ageH * 3600_000);
    fs.utimesSync(p, t, t);
    return p;
  };
  mk("playwright_chromiumdev_profile-OLD", 30);
  mk("playwright_chromiumdev_profile-NEW", 1);
  const inUse = mk("playwright_chromiumdev_profile-BUSY", 30);
  mk("demo-rec-old-thing", 48);
  mk("gdp-test-someone-elses", 99);
  mk("habiton-llm-other", 99);
  const dry = sweepTemp({
    dir,
    patterns: OWN_TEMP,
    commands: `chrome --user-data-dir=${inUse}`,
    dryRun: true,
  });
  assert.deepEqual(dry.removed.sort(), [
    "demo-rec-old-thing",
    "playwright_chromiumdev_profile-OLD",
  ]);
  assert.equal(fs.readdirSync(dir).length, 6, "a dry run removes nothing");
  const r = sweepTemp({ dir, patterns: OWN_TEMP, commands: `chrome --user-data-dir=${inUse}` });
  assert.deepEqual(r.removed.sort(), ["demo-rec-old-thing", "playwright_chromiumdev_profile-OLD"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "gdp-test-someone-elses",
    "habiton-llm-other",
    "playwright_chromiumdev_profile-BUSY",
    "playwright_chromiumdev_profile-NEW",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the cleaner derives the prefixes of the tests from the tests themselves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-prefixes-"));
  fs.writeFileSync(
    path.join(dir, "a.test.ts"),
    `import os from "node:os";
const a = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-"));
const b = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "beta-"));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const c = tmp("gamma-");`,
  );
  assert.deepEqual(testPrefixes(dir), ["alpha-", "beta-", "gamma-"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the repo's test runner gives the tests a temp folder of their own and removes it afterwards", () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-runner-"));
  const probe = path.join(dir, "probe.test.ts");
  fs.writeFileSync(
    probe,
    `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
test("leaves a folder behind", () => {
  const leak = fs.mkdtempSync(path.join(os.tmpdir(), "leak-"));
  console.log("LEAK=" + leak);
});`,
  );
  // a test run inside a test run: with this variable the inner `node --test` thinks it is the outer one's child and prints nothing
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"),
  ) as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, ["scripts/test.mjs", probe], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const leak = /LEAK=(\S+)/.exec(r.stdout)?.[1] ?? "";
  assert.match(leak, /\/pi-t-[^/]+\/leak-[^/]+$/, `the tests got their own folder: ${leak}`);
  assert.equal(fs.existsSync(leak), false, "and it is gone");
  assert.equal(fs.existsSync(path.dirname(leak)), false);
  fs.rmSync(dir, { recursive: true, force: true });
  void spawn;
});
