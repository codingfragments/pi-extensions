/**
 * The discovery heartbeat: a quiet session says it is alive (real Chromium for the session part; skipped when it is not installed).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { EventBus } from "../src/bus.ts";
import { resolveConfig } from "../src/config.ts";
import { formatAge, heartbeatMessage, nextBeatDelay } from "../src/discovery/heartbeat.ts";
import { DiscoverySession } from "../src/discovery/session.ts";
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

test("the words: ages, the last step, the budget and what the Director is doing", () => {
  assert.equal(formatAge(45_000), "45 s");
  assert.equal(formatAge(60_000), "1 min");
  assert.equal(formatAge(75_000), "1 min 15 s");
  const base = {
    sinceStepMs: 45_000,
    lastStep: "look s014 “Orders” · /orders",
    screens: "14/40",
    actions: "6/150",
  };
  assert.equal(
    heartbeatMessage({ ...base, area: "Orders", director: "working" }),
    "⏳ still here · 45 s since the last step (look s014 “Orders” · /orders) · 14/40 screens, 6/150 actions · area in hand: Orders · the Director is working on the next step",
  );
  assert.match(
    heartbeatMessage({ ...base, director: "settled" }),
    /the Director has stopped, the session is still open$/,
  );
  assert.doesNotMatch(heartbeatMessage({ ...base, director: "unknown" }), /Director/);
  assert.match(
    heartbeatMessage({ ...base, lastStep: "", director: "unknown" }),
    /since the session opened, no step yet/,
  );
});

test("the timer waits until a beat is due and never spins", () => {
  assert.equal(nextBeatDelay(1_000, 1_000, 30_000), 30_000);
  assert.equal(nextBeatDelay(20_000, 1_000, 30_000), 11_000);
  assert.equal(nextBeatDelay(60_000, 1_000, 30_000), 50, "overdue: a short wait, not zero");
});

test("config: discovery.heartbeatSec defaults to 30, 0 turns it off, nonsense is refused", () => {
  const read = (json: unknown) =>
    resolveConfig({
      env: { DEMO_REC_CONFIG: "/x.json" },
      home: "/h",
      readFile: () => JSON.stringify(json),
    });
  assert.equal(
    resolveConfig({ env: {}, home: "/h", readFile: () => undefined }).discovery.heartbeatSec,
    30,
  );
  assert.equal(read({ discovery: { heartbeatSec: 0 } }).discovery.heartbeatSec, 0);
  assert.equal(read({ discovery: { heartbeatSec: 20 } }).discovery.heartbeatSec, 20);
  assert.throws(() => read({ discovery: { heartbeatSec: -1 } }), /heartbeatSec/);
  assert.throws(() => read({ discovery: { heartbeatSec: 1.5 } }), /heartbeatSec/);
  assert.throws(() => read({ discovery: { heartbeatSec: 301 } }), /heartbeatSec/);
});

let fixture: FixtureHandle;
let root: string;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-beat-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const BUDGETS = { discoveryScreens: 20, discoveryActions: 30, discoveryMinutes: 5 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "a quiet session beats; a busy one does not; the Director's state is named; a closed one is silent",
  { skip, timeout: 60_000 },
  async () => {
    const app = ensureApp(root, "Beat App", fixture.url);
    const bus = new EventBus();
    const beats: string[] = [];
    bus.subscribe((e) => {
      if (e.type === "discovery.heartbeat") beats.push(String(e.data?.message));
    });
    const d = await DiscoverySession.open({
      root,
      app,
      viewport: { width: 1280, height: 800 },
      budgets: BUDGETS,
      bus,
      project: "p",
      heartbeatSec: 0.4,
    });
    try {
      // steps keep coming faster than the beat: nothing to add
      for (let i = 0; i < 3; i++) {
        await d.look();
        await sleep(100);
      }
      assert.equal(beats.length, 0, "a session that is moving does not beat");
      // silence: a beat per interval, naming the last step and the budget
      await sleep(1_300);
      assert.ok(beats.length >= 2, `quiet for 1.3 s: ${beats.length} beats`);
      assert.match(beats[0] ?? "", /still here · .* since the last step \(look .*s003/);
      assert.match(beats[0] ?? "", /3\/20 screens, 0\/30 actions/);
      assert.doesNotMatch(
        beats[0] ?? "",
        /Director/,
        "nothing said about a Director it has not heard from",
      );
      // the Director's own events set what it says about it
      bus.publish("director.step", { tool: "demo_rec_browser" }, "p");
      beats.length = 0;
      await sleep(700);
      assert.match(beats.at(-1) ?? "", /the Director is working on the next step/);
      bus.publish("director.settled", {}, "p");
      beats.length = 0;
      await sleep(700);
      assert.match(beats.at(-1) ?? "", /the Director has stopped, the session is still open/);
      // another project's Director says nothing about this session
      bus.publish("director.started", {}, "other");
      beats.length = 0;
      await sleep(700);
      assert.match(beats.at(-1) ?? "", /has stopped/);
    } finally {
      await d.close();
    }
    beats.length = 0;
    await sleep(900);
    assert.equal(beats.length, 0, "once closed, no more beats");
  },
);

test("heartbeatSec 0 never beats", { skip, timeout: 30_000 }, async () => {
  const app = ensureApp(root, "Beat App Off", fixture.url);
  const bus = new EventBus();
  let n = 0;
  bus.subscribe((e) => {
    if (e.type === "discovery.heartbeat") n++;
  });
  const d = await DiscoverySession.open({
    root,
    app,
    viewport: { width: 1280, height: 800 },
    budgets: BUDGETS,
    bus,
    heartbeatSec: 0,
  });
  try {
    await sleep(800);
    assert.equal(n, 0);
  } finally {
    await d.close();
  }
});
