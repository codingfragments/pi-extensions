/**
 * Item 10, D3 (F6, F8): discovery progress is MEASURED. Every look and action is attributed to an area (route hints from the plan,
 * else the area being worked on); marking an area done does not make it seen; the storyboard is not written over areas nobody saw.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import {
  coverageMessage,
  coverageProblem,
  dropInLog,
  measureSession,
  readLog,
} from "../src/discovery/coverage.ts";
import {
  type LogRecord,
  measureAreas,
  measuredProgress,
  routeClaims,
  uncoveredAreas,
} from "../src/discovery/measure.ts";
import { DiscoverySession } from "../src/discovery/session.ts";
import { writeSessionRecord } from "../src/discovery/state.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import {
  SETTLED_GRACE_MS,
  STALL_MS,
  areaSegment,
  stallOf,
  stallWords,
} from "../src/panel/public/discovery-core.js";
import { Runtime } from "../src/runtime.ts";
import { storyboardVersions } from "../src/storyboard/store.ts";
import { registerStoryboardTool } from "../src/tools/storyboard.ts";
import { appDir, ensureApp } from "../src/workdir/layout.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const at = (n: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, n)).toISOString();
const look = (n: number, url: string): LogRecord => ({
  at: at(n),
  kind: "look",
  screen: `s${n}`,
  url,
});
const act = (n: number, url: string): LogRecord => ({ at: at(n), kind: "act", url });
const H = "https://k.example";

test("routes: a path claims itself and what is below it, never a longer word; / is only home; hash routes match the hash", () => {
  assert.equal(routeClaims("/search", "/search"), true);
  assert.equal(routeClaims("/search", "/search/results"), true);
  assert.equal(routeClaims("/search", "/searching"), false);
  assert.equal(routeClaims("/search/", "/search"), true, "a trailing slash does not matter");
  assert.equal(routeClaims("/", "/"), true);
  assert.equal(routeClaims("/", "/cart"), false, "/ is only the home page");
  assert.equal(
    routeClaims("/", "/", "#/cart"),
    false,
    "nor the home page of a hash-routed app on another route",
  );
  assert.equal(routeClaims("/#/cart", "/", "#/cart"), true);
  assert.equal(routeClaims("/#/cart", "/", "#/cart/checkout"), true);
  assert.equal(routeClaims("/#/cart", "/", "#/cartoon"), false);
  assert.equal(routeClaims("search", "/search"), false, "a route is a path");
});

test("measuring: route hints first (the longest wins), else the area in hand, else unassigned; revisits count; nothing is trusted from flags", () => {
  const log: LogRecord[] = [
    look(1, `${H}/`),
    {
      at: at(2),
      kind: "plan",
      areas: ["Home", "Search", "Cart"],
      routes: { Search: ["/search"], Cart: ["/cart", "/cart/checkout"] },
    },
    look(3, `${H}/`), // no route claims "/" (Home has none): the area in hand, Home
    act(4, `${H}/`),
    look(5, `${H}/search?q=x`), // Search by route, although Home is in hand
    act(6, `${H}/search`),
    look(7, `${H}/cart/checkout`), // Cart by its longer route
    { at: at(8), kind: "area-done", area: "home" },
    look(9, `${H}/elsewhere`), // nobody's route: the area now in hand, Search
    look(10, `${H}/`), // a revisit of home after it was done: still Home? no route, so the area in hand (Search)
  ];
  const m = measureAreas(log);
  const by = (n: string) => m.areas.find((a) => a.name === n);
  assert.deepEqual([by("Home")?.looks, by("Home")?.acts, by("Home")?.status], [1, 1, "done"]);
  assert.deepEqual(
    [by("Search")?.looks, by("Search")?.acts, by("Search")?.status],
    [3, 1, "current"],
    "its two looks by route plus two by being the area in hand, minus none",
  );
  assert.deepEqual(
    [by("Cart")?.looks, by("Cart")?.status],
    [1, "seen"],
    "seen, though not the area in hand",
  );
  assert.deepEqual(
    m.unassigned,
    { looks: 1, acts: 0 },
    "the look before the plan belonged to nobody",
  );
  assert.equal(m.lastActivityAt, at(10));
  assert.equal(m.planned, true);
});

test("a flag is a claim: done with nothing seen is flagged, dropped is excused, a forgotten flag does not hide what was seen", () => {
  const log: LogRecord[] = [
    {
      at: at(1),
      kind: "plan",
      areas: ["A", "B", "C", "D"],
      routes: { B: ["/b"], C: ["/c"], D: ["/d"] },
    },
    look(2, `${H}/b`),
    { at: at(3), kind: "area-done", area: "A" }, // marked done, nothing seen
    { at: at(4), kind: "area-dropped", area: "D", why: "behind a login we do not have" },
  ];
  const m = measureAreas(log);
  assert.deepEqual(
    m.areas.map((a) => [a.name, a.status]),
    [
      ["A", "done-empty"],
      ["B", "current"],
      ["C", "todo"],
      ["D", "dropped"],
    ],
  );
  assert.equal(m.areas[3]?.droppedWhy, "behind a login we do not have");
  assert.deepEqual(
    uncoveredAreas(m).map((a) => a.name),
    ["A", "C"],
    "B was seen (the flag never came), D was excused",
  );
  // a plan that is declared again keeps what happened and takes new routes
  const again = measureAreas([
    ...log,
    { at: at(5), kind: "plan", areas: ["A", "B", "C", "D", "E"], routes: { C: ["/c2"] } },
  ]);
  assert.deepEqual(
    again.areas.map((a) => [a.name, a.status]),
    [
      ["A", "done-empty"],
      ["B", "current"],
      ["C", "todo"],
      ["D", "dropped"],
      ["E", "todo"],
    ],
  );
  assert.deepEqual(again.areas[2]?.routes, ["/c2"]);
  assert.equal(measureAreas([look(1, `${H}/`)]).planned, false, "no plan, no areas");
});

test("measured progress: seen work counts, a flag alone does not, the budget is a floor, the storyboard completes it", () => {
  const input = {
    startedAt: 0,
    now: 60_000,
    budgetUsed: { screens: 0.1, actions: 0.1, minutes: 0.05 },
    budgetMinutes: 20,
    storyboardWritten: false,
  };
  const plan: LogRecord = {
    at: at(0),
    kind: "plan",
    areas: ["A", "B"],
    routes: { A: ["/a"], B: ["/b"] },
  };
  const flagOnly = measuredProgress(
    measureAreas([plan, { at: at(1), kind: "area-done", area: "A" }]),
    input,
  );
  assert.equal(
    flagOnly.fraction,
    +(0.1 * (1 - 0.12)).toFixed(4),
    "only the budget moved it: marking A done without seeing it counts nothing",
  );
  assert.deepEqual(
    flagOnly.areas.map((a) => a.status),
    ["done-empty", "current"],
  );
  const seen = measuredProgress(
    measureAreas([
      plan,
      look(1, `${H}/a`),
      { at: at(2), kind: "area-done", area: "A" },
      look(3, `${H}/b`),
    ]),
    input,
  );
  assert.ok(seen.fraction > flagOnly.fraction, "A seen and done, B started");
  assert.equal(seen.doneCount, 1);
  assert.equal(seen.current, "B");
  assert.deepEqual(
    seen.areas.map((a) => [a.name, a.looks]),
    [
      ["A", 1],
      ["B", 1],
    ],
  );
  const floor = measuredProgress(measureAreas([plan]), {
    ...input,
    budgetUsed: { screens: 0.9, actions: 0.2, minutes: 0.1 },
  });
  assert.equal(
    floor.fraction,
    +(0.9 * (1 - 0.12)).toFixed(4),
    "running out of budget means nearly done",
  );
  assert.equal(
    measuredProgress(measureAreas([plan]), { ...input, storyboardWritten: true }).fraction,
    1,
  );
  const none = measuredProgress(measureAreas([look(1, `${H}/`)]), input);
  assert.deepEqual([none.mode, none.fraction], ["budget-only", 0.1]);
});

function discoveryDir(root: string, id: string, startedAt: string, records: LogRecord[]) {
  const dir = path.join(root, "discovery", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "actions.jsonl"),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  writeSessionRecord(root, { id, startedAt, closedAt: startedAt });
}

test("the coverage check: names the areas nobody saw; dropping with a reason excuses; a storyboard written since ends the asking; old sessions without a plan are left alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-cov-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-covp-"));
  try {
    assert.equal(coverageProblem(project, root), undefined, "no session");
    discoveryDir(root, "20261001-100000", "2026-10-01T10:00:00Z", [look(1, `${H}/`)]);
    assert.equal(coverageProblem(project, root), undefined, "no plan was declared");
    const future = "2099-01-01T00:00:00Z";
    discoveryDir(root, "20991001-100000", future, [
      {
        at: at(1),
        kind: "plan",
        areas: ["Search", "Cart", "FAQ"],
        routes: { Search: ["/search"], Cart: ["/cart"], FAQ: ["/faq"] },
      },
      look(2, `${H}/search`),
      { at: at(3), kind: "area-done", area: "Cart" },
    ]);
    const gap = coverageProblem(project, root);
    assert.deepEqual(
      gap?.uncovered.map((a) => [a.name, a.status]),
      [
        ["Cart", "done-empty"],
        ["FAQ", "todo"],
      ],
    );
    const msg = coverageMessage(gap as NonNullable<typeof gap>);
    assert.match(
      msg,
      /storyboard not written: 2 areas you declared in discovery session 20991001-100000 were never seen/,
    );
    assert.match(msg, /- Cart \(you marked it done, but nothing was seen there\)/);
    assert.match(msg, /- FAQ \(nothing seen\)/);
    assert.match(msg, /skipAreas: \[\{ area, why \}\]/);
    // dropping
    assert.throws(
      () => dropInLog(root, "20991001-100000", [{ area: "Nope", why: "x" }]),
      /not a declared area: Search, Cart, FAQ/,
    );
    assert.throws(
      () => dropInLog(root, "20991001-100000", [{ area: "FAQ", why: "  " }]),
      /a reason is required/,
    );
    dropInLog(root, "20991001-100000", [{ area: "faq", why: "static text, nothing to demo" }]);
    assert.deepEqual(
      coverageProblem(project, root)?.uncovered.map((a) => a.name),
      ["Cart"],
      "FAQ is excused, with its reason kept in the log",
    );
    assert.equal(readLog(root, "20991001-100000").at(-1)?.why, "static text, nothing to demo");
    assert.equal(
      measureSession(root, "20991001-100000").areas.find((a) => a.name === "FAQ")?.droppedWhy,
      "static text, nothing to demo",
    );
    // a storyboard written after the session began: not asked again
    fs.mkdirSync(path.join(project, "storyboard"), { recursive: true });
    fs.writeFileSync(path.join(project, "storyboard", "v1.yaml"), "version: 1\n");
    const t = new Date("2099-06-01T00:00:00Z");
    fs.utimesSync(path.join(project, "storyboard", "v1.yaml"), t, t);
    assert.equal(coverageProblem(project, root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("the storyboard tool: refused over an area nobody saw, written with skipAreas and a reason, and the dropped area is kept in the log", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  const app = appDir(seed.root, rt.requireProject().app.slug);
  discoveryDir(app, "20991001-100000", "2099-01-01T00:00:00Z", [
    {
      at: at(1),
      kind: "plan",
      areas: ["Dashboard", "Compare"],
      routes: { Dashboard: ["/"], Compare: ["/compare"] },
    },
    look(2, `${H}/`),
  ]);
  try {
    const tools = new Map<
      string,
      { execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }> }
    >();
    registerStoryboardTool(
      { registerTool: (t: { name: string }) => tools.set(t.name, t as never) } as never,
      rt,
    );
    const tool = tools.get("demo_rec_storyboard");
    assert.ok(tool);
    const yaml = fs.readFileSync(path.join(seed.dir, "storyboard", "v2.yaml"), "utf8");
    const write = async (extra: Record<string, unknown> = {}) =>
      (
        await tool.execute(
          "id",
          { action: "write", yaml, ...extra },
          undefined,
          undefined,
          undefined,
        )
      ).content
        .map((c) => c.text ?? "")
        .join("\n");
    const before = storyboardVersions(seed.dir).length;
    await assert.rejects(
      () => write(),
      /storyboard not written: 1 area you declared in discovery session 20991001-100000 was never seen:\n- Compare \(nothing seen\)/,
    );
    assert.equal(
      storyboardVersions(seed.dir).length,
      before,
      "a refused write consumes no version",
    );
    await assert.rejects(
      () => write({ skipAreas: [{ area: "Compare", why: "" }] }),
      /a reason is required/,
    );
    await assert.rejects(
      () => write({ skipAreas: [{ area: "Nope", why: "x" }] }),
      /not a declared area/,
    );
    assert.match(
      await write({
        skipAreas: [{ area: "Compare", why: "the compare view is not part of this story" }],
      }),
      /storyboard v3/i,
    );
    assert.equal(storyboardVersions(seed.dir).length, before + 1);
    assert.equal(readLog(app, "20991001-100000").at(-1)?.kind, "area-dropped");
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumAvailable()) && "chromium not installed";

test(
  "a real session: looks and actions are attributed by route, a forgotten flag does not hide what was seen, a flag without a visit is flagged",
  { skip, timeout: 120_000 },
  async () => {
    const fixture: FixtureHandle = await serveFixture(0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-dmeasure-"));
    try {
      const app = ensureApp(root, "Acme Pulse", fixture.url);
      const d = await DiscoverySession.open({
        root,
        app,
        viewport: { width: 1600, height: 900 },
        budgets: { discoveryScreens: 20, discoveryActions: 30, discoveryMinutes: 5 },
        project: "p",
      });
      try {
        await d.look();
        assert.equal(d.measure().planned, false);
        d.setPlan(["Dashboard", "Search", "Assistant", "Live"], {
          Dashboard: ["/"],
          Search: ["/search"],
          Assistant: ["/chat"],
          Live: ["/live"],
        });
        await d.act({ action: "goto", url: "/search" });
        await d.look();
        await d.act({ action: "goto", url: "/chat" });
        await d.look();
        d.markDone("Live"); // marked done, never visited
        const m = d.measure();
        const by = (n: string) => m.areas.find((a) => a.name === n);
        assert.deepEqual(
          [by("Search")?.looks, by("Assistant")?.looks],
          [1, 1],
          "attributed by the page they were on",
        );
        assert.equal(by("Search")?.status, "seen", "never marked done, still seen");
        assert.equal(by("Live")?.status, "done-empty", "marked done, nothing seen");
        assert.equal(by("Dashboard")?.status, "current");
        assert.deepEqual(
          uncoveredAreas(m).map((a) => a.name),
          ["Live"],
          "only the area nobody saw: the look before the plan was claimed by Dashboard's route",
        );
        assert.match(d.progress().areas.find((a) => a.name === "Live")?.status ?? "", /done-empty/);
        assert.throws(
          () => d.setPlan(["Dashboard"], { Nope: ["/x"] }),
          /not one of the declared areas/,
        );
        assert.throws(
          () => d.setPlan(["Dashboard"], { Dashboard: ["search"] }),
          /must be a path starting with \//,
        );
        d.dropArea("Live", "the live view streams; not part of this story");
        assert.equal(d.measure().areas.find((a) => a.name === "Live")?.status, "dropped");
        assert.throws(() => d.dropArea("Live", " "), /a reason is required/);
        assert.throws(() => d.markDone("Nothing"), /unknown area "Nothing"/);
      } finally {
        await d.close();
      }
      // after it closed, the page and the storyboard check read the same thing from the log
      const after = measureSession(appDir(root, app.slug), d.id);
      assert.deepEqual(
        after.areas.map((a) => a.status),
        measureAreas(readLog(appDir(root, app.slug), d.id)).areas.map((a) => a.status),
      );
      assert.equal(
        after.areas.find((a) => a.name === "Live")?.droppedWhy,
        "the live view streams; not part of this story",
      );
    } finally {
      await fixture.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a stalled session: quiet after 90 s, the Director stopped with the session open, and never once it closed", () => {
  const t0 = Date.parse("2026-10-19T08:00:00Z");
  const ev = (type: string, ms: number) => ({ type, at: new Date(t0 + ms).toISOString() });
  const open = [
    ev("discovery.opened", 0),
    ev("discovery.look", 5_000),
    ev("discovery.act", 20_000),
  ];
  assert.equal(stallOf([], t0), null);
  assert.equal(stallOf(open, t0 + 20_000 + STALL_MS - 1), null, "still moving");
  assert.deepEqual(stallOf(open, t0 + 20_000 + STALL_MS), { kind: "quiet", sinceMs: STALL_MS });
  assert.match(
    stallWords({ kind: "quiet", sinceMs: 150_000 }),
    /No activity for 3 min\. The Director may be thinking/,
  );
  // plan changes are activity
  assert.equal(stallOf([...open, ev("discovery.progress", 100_000)], t0 + 120_000), null);
  // the Director's run ended while the session is still open
  const settled = [...open, ev("director.settled", 30_000)];
  assert.equal(stallOf(settled, t0 + 30_000 + SETTLED_GRACE_MS - 1), null, "a short grace");
  assert.deepEqual(stallOf(settled, t0 + 30_000 + SETTLED_GRACE_MS), {
    kind: "director-stopped",
    sinceMs: SETTLED_GRACE_MS,
  });
  assert.match(
    stallWords({ kind: "director-stopped", sinceMs: 120_000 }),
    /The Director has stopped, but the discovery session is still open \(2 min\)/,
  );
  // the Director started again, or the session closed: nothing to say
  assert.equal(stallOf([...settled, ev("director.started", 40_000)], t0 + 60_000), null);
  assert.equal(stallOf([...open, ev("discovery.closed", 60_000)], t0 + 600_000), null);
  // a second session starts fresh
  assert.equal(
    stallOf(
      [...open, ev("discovery.closed", 60_000), ev("discovery.opened", 400_000)],
      t0 + 410_000,
    ),
    null,
  );
});

test("segments by what was measured: words and counts, the dashed one for a claim with nothing behind it", () => {
  const seg = (status: string, looks = 0, acts = 0) =>
    areaSegment({ name: "Search", status, looks, acts }, 0.25);
  assert.deepEqual([seg("done", 3, 4).state, seg("done", 3, 4).done], ["done", 1]);
  const empty = seg("done-empty");
  assert.deepEqual(
    [empty.state, empty.done, empty.restarted, empty.label],
    ["todo", 0, true, "Search (marked done, nothing seen)"],
  );
  assert.equal(empty.title, "Search: marked done, but nothing was seen there");
  assert.equal(seg("dropped").label, "Search (left out)");
  assert.deepEqual([seg("current", 2, 4).state, seg("current", 2, 4).done], ["current", 0.5]);
  assert.deepEqual(
    [seg("seen", 1, 0).state, seg("seen", 1, 0).done],
    ["seen", 0.2],
    "seen shows at least a sliver",
  );
  assert.equal(seg("seen", 9, 9).done, 0.9, "never full until it is done");
  assert.equal(seg("todo").title, "Search · 0 looks, 0 actions");
  assert.equal(
    areaSegment({ name: "X", status: "todo" }, 0.1).title,
    "X",
    "an older progress without counts",
  );
});

async function playwrightBrowser() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await playwrightBrowser();

test(
  "in the browser: the Project page shows what each area got and what is unseen, the drawer's bar is by what was measured, and a quiet session says so",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const app = appDir(seed.root, rt.requireProject().app.slug);
    const log: LogRecord[] = [
      look(0, `${H}/`), // the first look, before the plan: no route claims the home page
      {
        at: at(1),
        kind: "plan",
        areas: ["Search", "Cart", "FAQ", "Chat"],
        routes: { Search: ["/search"], Cart: ["/cart"], FAQ: ["/faq"], Chat: ["/chat"] },
      },
      look(2, `${H}/search`),
      act(3, `${H}/search`),
      { at: at(4), kind: "area-done", area: "Cart" },
      { at: at(5), kind: "area-dropped", area: "Chat", why: "needs a login we do not have" },
    ];
    // Search was seen, Cart marked done without a visit, FAQ never touched, Chat left out; the first look belonged to nobody
    discoveryDir(app, "20261019-090000", "2026-10-19T07:00:00Z", log);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
      await page.clock.install({ time: new Date() });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/project?group=discovery`);
      await page.waitForSelector("[data-area]");
      const row = (n: string) => page.locator(`[data-area='${n}']`).innerText();
      assert.match(await row("Search"), /in hand[\s\S]*1\s+1/);
      assert.equal(
        await page.locator("[data-area='Search']").getAttribute("data-area-status"),
        "current",
        "the one in hand: Search was never marked done",
      );
      assert.match(await row("Cart"), /marked done, nothing seen[\s\S]*0\s+0/);
      assert.match(await row("FAQ"), /not yet/);
      assert.match(await row("Chat"), /left out[\s\S]*needs a login we do not have/);
      assert.match(
        await page.locator("[data-unassigned]").innerText(),
        /1 look and 0 actions were on pages no area's route claims/,
      );
      assert.match(await page.locator("[data-uncovered]").innerText(), /Not seen yet: Cart, FAQ/);
      assert.match(await page.locator("[data-uncovered]").innerText(), /not written over these/);
      // the drawer: a running session whose progress says what was measured
      const m = measureAreas(log);
      const progress = measuredProgress(m, {
        startedAt: 0,
        now: 60_000,
        budgetUsed: { screens: 0.1, actions: 0.1, minutes: 0.1 },
        budgetMinutes: 20,
        storyboardWritten: false,
      });
      (rt as unknown as { discovery: unknown }).discovery = {
        isClosed: false,
        id: "20261019-120000",
        dir: path.join(app, "discovery", "20261019-120000"),
        budget: () => ({ screens: "1/40", actions: "1/150", minutes: "1.0/20", exhausted: false }),
        progress: () => progress,
      };
      rt.bus.publish(
        "discovery.opened",
        { session: "20261019-120000", message: "opened" },
        seed.slug,
      );
      rt.bus.publish("discovery.progress", { progress, message: "progress" }, seed.slug);
      await page.click("button:has-text('Activity')");
      await page.waitForSelector("#activity .segbar .seg");
      const segs = (await page.evaluate(
        "[...document.querySelectorAll('#activity .segbar .seg')].map((s) => [s.className, s.textContent, s.title])",
      )) as string[][];
      const byLabel = (needle: string) =>
        segs.find((x) => (x[1] ?? "").includes(needle)) as string[];
      assert.match(
        byLabel("Cart")[0] ?? "",
        /restarted/,
        "the claim with nothing behind it is dashed",
      );
      assert.match(byLabel("Cart")[1] ?? "", /marked done, nothing seen/, "and says so in words");
      assert.match(byLabel("Chat")[1] ?? "", /left out/);
      assert.match(byLabel("Search")[2] ?? "", /Search · 1 look, 1 action/);
      assert.match(byLabel("Search")[0] ?? "", /current/);
      // no activity: the clock moves on, the page says so; new activity clears it
      assert.equal(await page.locator("[data-stall]").count(), 0, "it is moving");
      await page.clock.fastForward(120_000);
      await page.waitForSelector("[data-stall=quiet]");
      assert.match(
        await page.locator("[data-stall=quiet]").first().innerText(),
        /No activity for 2 min\. The Director may be thinking/,
      );
      // (new activity clearing it is the pure test above: this page's clock was moved ahead of the server's)
      // the session closes: nothing to say any more
      rt.bus.publish(
        "discovery.closed",
        { session: "20261019-120000", message: "closed" },
        seed.slug,
      );
      await page.waitForSelector("[data-stall]", { state: "detached" });
      (rt as unknown as { discovery: unknown }).discovery = undefined;
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
