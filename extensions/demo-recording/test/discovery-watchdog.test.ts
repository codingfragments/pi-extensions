/**
 * A frozen browser (a real session lost 26 minutes to two of them): every browser call has a deadline; past it the browser is diagnosed, killed and reopened on the same
 * page, and the Director is told. Also the failed click that cost 46 s, the call in flight in the heartbeat, and the deep log. Real Chromium for the session parts.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MARKER_FLAG, killMarker, newMarker, processesOf } from "../src/browser/processes.ts";
import { EventBus } from "../src/bus.ts";
import { resolveConfig } from "../src/config.ts";
import { heartbeatMessage } from "../src/discovery/heartbeat.ts";
import { DiscoverySession } from "../src/discovery/session.ts";
import { CallStalledError, deadlineFor, withDeadline } from "../src/discovery/watchdog.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { ensureApp } from "../src/workdir/layout.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumAvailable()) && "chromium not installed";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("withDeadline: an answer in time, a silence past the deadline, an abort; a late failure is not an unhandled rejection", async () => {
  assert.equal(await withDeadline("x", 200, async () => 7), 7);
  assert.equal(await withDeadline("x", 0, async () => 8), 8, "0 = no deadline");
  await assert.rejects(
    withDeadline("scroll", 80, () => new Promise(() => undefined)),
    (e: unknown) =>
      e instanceof CallStalledError &&
      e.call === "scroll" &&
      !e.aborted &&
      /did not answer within 0 s/.test(e.message),
  );
  const ac = new AbortController();
  const p = withDeadline("look", 5000, () => new Promise(() => undefined), ac.signal);
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e: unknown) => e instanceof CallStalledError && e.aborted);
  // the call fails after its deadline: nobody is listening, nothing blows up
  await assert.rejects(
    withDeadline(
      "late",
      20,
      () => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 60)),
    ),
    CallStalledError,
  );
  await sleep(100);
});

test("deadlines: slow on purpose gets longer", () => {
  assert.equal(deadlineFor(25_000), 25_000);
  assert.equal(deadlineFor(25_000, { action: "scroll" }), 25_000);
  assert.equal(deadlineFor(25_000, { action: "goto" }), 50_000);
  assert.equal(deadlineFor(25_000, { action: "wait", ms: 5000 }), 30_000);
  assert.equal(
    deadlineFor(25_000, { action: "wait", ms: 99_000 }),
    45_000,
    "a wait is capped at 20 s extra",
  );
  assert.equal(deadlineFor(25_000, { action: "type", text: "x".repeat(100) }), 31_000);
  assert.equal(deadlineFor(0, { action: "goto" }), 0, "0 stays off");
});

test("processes: found by their marker (and their children), killed by it, and nothing else is touched", async () => {
  const marker = newMarker();
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>{},60000)", "--", `${MARKER_FLAG}${marker}`],
    { stdio: "ignore" },
  );
  const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  try {
    await sleep(300);
    const rows = processesOf(marker);
    assert.deepEqual(
      rows.map((r) => r.pid),
      [child.pid],
    );
    assert.equal(killMarker(marker), 1);
    await sleep(300);
    assert.deepEqual(processesOf(marker), []);
    assert.doesNotThrow(() => process.kill(other.pid as number, 0), "the other process lives");
  } finally {
    child.kill("SIGKILL");
    other.kill("SIGKILL");
  }
});

test("the heartbeat names a call that has not answered, not the Director", () => {
  const base = {
    sinceStepMs: 95_000,
    lastStep: "look s003",
    screens: "3/20",
    actions: "2/30",
    director: "working" as const,
  };
  assert.equal(
    heartbeatMessage({
      ...base,
      area: "Issue feed",
      inFlight: { call: "act scroll", ms: 95_000, deadlineMs: 25_000 },
    }),
    "⏳ act scroll has been running for 1 min 35 s and the browser has not answered (the browser is restarted after 25 s) · 3/20 screens, 2/30 actions · area in hand: Issue feed",
  );
  assert.match(
    heartbeatMessage({ ...base, inFlight: { call: "look", ms: 2000, deadlineMs: 25_000 } }),
    /since the last step/,
    "a call that has only just started is not news",
  );
  assert.match(
    heartbeatMessage({ ...base, inFlight: { call: "look", ms: 20_000, deadlineMs: 0 } }),
    /^⏳ look has been running for 20 s and the browser has not answered · /,
    "no deadline: no promise of a restart",
  );
});

test("config: the discovery keys have defaults and are checked", () => {
  const read = (json: unknown) =>
    resolveConfig({
      env: { DEMO_REC_CONFIG: "/x.json" },
      home: "/h",
      readFile: () => JSON.stringify(json),
    });
  const d = resolveConfig({ env: {}, home: "/h", readFile: () => undefined }).discovery;
  assert.deepEqual(d, {
    heartbeatSec: 30,
    callTimeoutSec: 25,
    browserLog: false,
    browserMemoryMb: 2048,
    settleMaxMs: 2500,
  });
  assert.equal(
    read({
      discovery: { callTimeoutSec: 0, browserLog: true, browserMemoryMb: 0, settleMaxMs: 1000 },
    }).discovery.callTimeoutSec,
    0,
  );
  assert.throws(() => read({ discovery: { callTimeoutSec: -1 } }), /callTimeoutSec/);
  assert.throws(() => read({ discovery: { browserLog: "yes" } }), /browserLog/);
  assert.throws(() => read({ discovery: { settleMaxMs: 10 } }), /settleMaxMs/);
  assert.throws(() => read({ discovery: { browserMemoryMb: 1.5 } }), /browserMemoryMb/);
});

let fixture: FixtureHandle;
let root: string;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-wd-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const BUDGETS = { discoveryScreens: 40, discoveryActions: 100, discoveryMinutes: 10 };

test(
  "a frozen browser: the call ends at its deadline, the browser is diagnosed, killed and reopened on the same page, and the session goes on",
  { skip, timeout: 120_000 },
  async () => {
    const app = ensureApp(root, "Frozen", fixture.url);
    const bus = new EventBus();
    const seen: { type: string; message: string }[] = [];
    bus.subscribe((e) => seen.push({ type: e.type, message: String(e.data?.message ?? "") }));
    const d = await DiscoverySession.open({
      root,
      app,
      viewport: { width: 1280, height: 800 },
      budgets: BUDGETS,
      bus,
      project: "p",
      heartbeatSec: 0,
      callTimeoutSec: 2,
    });
    try {
      await d.look();
      const marker = (d as unknown as { marker: string }).marker;
      const before = processesOf(marker).map((r) => r.pid);
      assert.ok(before.length > 1, `the browser has processes (${before.length})`);
      // freeze it: every process stopped, as a wedged Chromium is
      for (const pid of before) process.kill(pid, "SIGSTOP");
      const t = Date.now();
      await assert.rejects(d.act({ action: "scroll", dy: 400 }), (e: Error) => {
        assert.match(
          e.message,
          /act scroll did not answer within 2 s, so the browser was frozen: it was restarted and the page .* was reloaded with the saved login/,
        );
        return true;
      });
      const took = Date.now() - t;
      assert.ok(
        took < 25_000,
        `the stall ended at the deadline and the restart was quick (${took} ms)`,
      );
      for (const pid of before)
        assert.throws(() => process.kill(pid, 0), "the frozen browser is gone");
      // the session carries on, on a new browser
      assert.notEqual((d as unknown as { marker: string }).marker, marker);
      const look = await d.look();
      assert.ok(look.jpeg.length > 1000, "a look works again");
      const r = await d.act({ action: "scroll", dy: 300 });
      assert.equal(r.verdict.level, "safe");
      // what it left behind
      const diag = path.join(d.dir, "diagnostics");
      const files = fs.readdirSync(diag);
      assert.ok(files.includes("stall-1.ps.txt"), `diagnosis written: ${files.join(", ")}`);
      assert.match(
        fs.readFileSync(path.join(diag, "stall-1.ps.txt"), "utf8"),
        /act scroll did not answer within 2 s/,
      );
      const calls = fs
        .readFileSync(path.join(d.dir, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.ok(
        calls.some((c) => c.call === "act scroll" && c.stalled === true && c.ok === false),
        "the stall is in the call log",
      );
      assert.ok(calls.some((c) => c.call === "look" && c.ok === true));
      assert.ok(
        seen.some(
          (e) =>
            e.type === "discovery.stalled" &&
            /act scroll did not answer within 2 s/.test(e.message),
        ),
      );
      assert.ok(seen.some((e) => e.type === "discovery.recovered" && /restarted/.test(e.message)));
    } finally {
      await d.close();
    }
  },
);

test(
  "a click on something that is not there fails in about 8 s, not 46",
  { skip, timeout: 120_000 },
  async () => {
    const app = ensureApp(root, "Missing", fixture.url);
    const d = await DiscoverySession.open({
      root,
      app,
      viewport: { width: 1280, height: 800 },
      budgets: BUDGETS,
      heartbeatSec: 0,
    });
    try {
      const t = Date.now();
      await assert.rejects(
        d.act({ action: "click", target: { role: "button", name: "NoSuchButtonXYZ" } }),
        /target not visible within 8000 ms: button "NoSuchButtonXYZ"/,
      );
      const took = Date.now() - t;
      assert.ok(took >= 7500 && took < 12_000, `one wait of 8 s (${took} ms)`);
      // and the session is fine afterwards
      assert.equal((await d.act({ action: "scroll", dy: 200 })).verdict.level, "safe");
    } finally {
      await d.close();
    }
  },
);

test(
  "the deep log: Chromium's log, the process sampler and the page log are kept in diagnostics/; a plain session writes only the call log",
  { skip, timeout: 120_000 },
  async () => {
    const app = ensureApp(root, "Deep", fixture.url);
    const open = (browserLog: boolean) =>
      DiscoverySession.open({
        root,
        app,
        viewport: { width: 1280, height: 800 },
        budgets: BUDGETS,
        heartbeatSec: 0,
        browserLog,
      });
    const plain = await open(false);
    try {
      await plain.look();
      assert.equal(
        fs.existsSync(path.join(plain.dir, "diagnostics")),
        false,
        "no diagnostics folder without a stall",
      );
      assert.ok(fs.existsSync(path.join(plain.dir, "calls.jsonl")), "the call log is always there");
    } finally {
      await plain.close();
    }
    const deep = await open(true);
    try {
      await deep.look();
      await sleep(2600);
      const files = fs.readdirSync(path.join(deep.dir, "diagnostics"));
      assert.ok(files.includes("ps.log"), `process sampler: ${files.join(", ")}`);
      assert.match(
        fs.readFileSync(path.join(deep.dir, "diagnostics", "ps.log"), "utf8"),
        /--- \d{4}-/,
      );
    } finally {
      await deep.close();
    }
  },
);
