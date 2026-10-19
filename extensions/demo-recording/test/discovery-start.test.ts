/**
 * Item 10, D1 (F1, F5): discovery you start from the Project page. Start and Enhance are a request (notes, areas, the budget you
 * chose) stored in the project, sent to the Director and read by the session when it opens; a session writes how it ended, so the
 * page can say why it stopped and offer to extend the budget.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import {
  BUDGET_CAPS,
  addRequest,
  cancelRequest,
  checkBudget,
  pendingRequest,
  presetBudgets,
  readRequests,
  requestMessage,
  startRequest,
} from "../src/discovery/requests.ts";
import { DiscoverySession } from "../src/discovery/session.ts";
import { discoveryStatus, listSessions, writeSessionRecord } from "../src/discovery/state.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { Runtime } from "../src/runtime.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { appDir, ensureApp } from "../src/workdir/layout.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const STD = { discoveryScreens: 40, discoveryActions: 150, discoveryMinutes: 20 };

test("presets: quick is half, deep is double, within the caps; a budget is whole numbers within the caps, each named", () => {
  assert.deepEqual(presetBudgets(STD, "quick"), {
    discoveryScreens: 20,
    discoveryActions: 75,
    discoveryMinutes: 10,
  });
  assert.deepEqual(presetBudgets(STD, "standard"), STD);
  assert.deepEqual(presetBudgets(STD, "deep"), {
    discoveryScreens: 80,
    discoveryActions: 300,
    discoveryMinutes: 40,
  });
  assert.deepEqual(
    presetBudgets({ discoveryScreens: 150, discoveryActions: 700, discoveryMinutes: 90 }, "deep"),
    BUDGET_CAPS,
    "capped",
  );
  assert.deepEqual(
    presetBudgets({ discoveryScreens: 1, discoveryActions: 1, discoveryMinutes: 1 }, "quick"),
    { discoveryScreens: 1, discoveryActions: 1, discoveryMinutes: 1 },
    "never below 1",
  );
  assert.deepEqual(checkBudget(STD), STD);
  assert.throws(
    () => checkBudget({ ...STD, discoveryScreens: 0 }),
    /screens must be a whole number of 1 or more/,
  );
  assert.throws(
    () => checkBudget({ ...STD, discoveryActions: 2.5 }),
    /actions must be a whole number/,
  );
  assert.throws(() => checkBudget({ ...STD, discoveryMinutes: 121 }), /minutes is at most 120/);
  assert.throws(() => checkBudget({ ...STD, discoveryScreens: 201 }), /screens is at most 200/);
  assert.throws(() => checkBudget(undefined), /screens must be/);
});

test("requests: stored, one waiting at a time (a newer one replaces it), taken by a session, taken back; text limits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-dreq-"));
  try {
    const a = addRequest(root, {
      mode: "start",
      notes: "  look at checkout  ",
      areas: ["Cart", "  ", "Search box"],
      budget: STD,
      preset: "standard",
    });
    assert.deepEqual(
      [a.id, a.status, a.notes, a.areas, a.preset],
      ["dr-1", "pending", "look at checkout", ["Cart", "Search box"], "standard"],
    );
    assert.equal(pendingRequest(root)?.id, "dr-1");
    const b = addRequest(root, {
      mode: "enhance",
      budget: { ...STD, discoveryScreens: 55 },
      preset: "nonsense",
      base: "20261017-140044",
    });
    assert.deepEqual(
      [b.id, b.preset, b.base],
      ["dr-2", "custom", "20261017-140044"],
      "an unknown preset is custom",
    );
    assert.deepEqual(
      readRequests(root).map((r) => [r.id, r.status]),
      [
        ["dr-1", "cancelled"],
        ["dr-2", "pending"],
      ],
      "the older one was replaced",
    );
    startRequest(root, "dr-2", "20261018-100000");
    assert.equal(pendingRequest(root), undefined);
    assert.deepEqual(
      [readRequests(root)[1]?.status, readRequests(root)[1]?.session],
      ["started", "20261018-100000"],
    );
    assert.throws(() => cancelRequest(root), /no discovery request is waiting/);
    addRequest(root, { mode: "start", budget: STD });
    assert.equal(cancelRequest(root).status, "cancelled");
    assert.throws(
      () => addRequest(root, { mode: "start", notes: "x".repeat(2001), budget: STD }),
      /2000 characters/,
    );
    assert.throws(
      () => addRequest(root, { mode: "start", areas: ["y".repeat(121)], budget: STD }),
      /120 characters/,
    );
    assert.equal(
      addRequest(root, {
        mode: "start",
        areas: Array.from({ length: 20 }, (_, i) => `a${i}`),
        budget: STD,
      }).areas.length,
      12,
      "at most 12 areas",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("what the Director is told: the ask, the budget, the areas, and for an enhance what to build on", () => {
  const p = { slug: "kc", name: "KeyCraft", url: "https://k.example/" };
  const start = requestMessage(
    "[demo-panel]",
    p,
    {
      id: "dr-1",
      at: "",
      mode: "start",
      notes: "focus on search",
      areas: ["Search", "Cart"],
      budget: STD,
      preset: "standard",
      status: "pending",
    },
    { sessions: 0, findings: 0 },
  );
  assert.match(start, /asks to start discovery of KeyCraft \(https:\/\/k\.example\/\)/);
  assert.match(start, /40 screens, 150 actions, 20 minutes, the standard choice/);
  assert.match(start, /Their notes: focus on search/);
  assert.match(start, /Areas they want covered[^\n]*Search; Cart/);
  assert.doesNotMatch(start, /Build on what exists/);
  const more = requestMessage(
    "[demo-panel]",
    p,
    {
      id: "dr-2",
      at: "",
      mode: "enhance",
      notes: "",
      areas: [],
      budget: { discoveryScreens: 55, discoveryActions: 100, discoveryMinutes: 12 },
      preset: "custom",
      base: "20261017-140044",
      status: "pending",
    },
    { sessions: 2, findings: 9 },
  );
  assert.match(more, /ENHANCE the discovery/);
  assert.match(more, /55 screens, 100 actions, 12 minutes\)/);
  assert.match(
    more,
    /Build on what exists: 2 earlier sessions \(the newest is 20261017-140044\) and 9 findings/,
  );
  assert.match(more, /do NOT repeat what is already covered/);
  assert.doesNotMatch(more, /Their notes|Areas they want/);
});

test("sessions on disk: how each ended, older ones from their log, and the status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-dstate-"));
  try {
    assert.deepEqual(listSessions(root), []);
    assert.equal(discoveryStatus([]), "never");
    // an older session: only an action log
    const old = path.join(root, "discovery", "20261017-140044");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(
      path.join(old, "actions.jsonl"),
      [
        { at: "2026-10-17T12:00:48.072Z", kind: "look" },
        { at: "2026-10-17T12:00:50.000Z", kind: "plan", areas: ["a"] },
        { at: "2026-10-17T12:00:56.000Z", kind: "act" },
        { at: "2026-10-17T12:01:10.000Z", kind: "look" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const [o] = listSessions(root);
    assert.deepEqual(
      [o?.screens, o?.actions, o?.older, o?.exhausted, o?.startedAt, o?.closedAt],
      [2, 1, true, false, "2026-10-17T12:00:48.072Z", "2026-10-17T12:01:10.000Z"],
    );
    assert.equal(discoveryStatus(listSessions(root)), "done", "an older session counts as done");
    // a session that was opened and never closed (pi stopped)
    writeSessionRecord(root, {
      id: "20261018-100000",
      startedAt: "2026-10-18T08:00:00Z",
      budgets: STD,
      request: "dr-1",
    });
    assert.equal(discoveryStatus(listSessions(root)), "interrupted");
    assert.equal(
      discoveryStatus(listSessions(root), "20261018-100000"),
      "running",
      "the open one wins",
    );
    // closed within the budget, then closed having run out
    writeSessionRecord(root, {
      id: "20261018-100000",
      startedAt: "2026-10-18T08:00:00Z",
      budgets: STD,
      closedAt: "2026-10-18T08:12:00Z",
      usage: { screens: 22, actions: 90, minutes: 12 },
      exhausted: false,
    });
    assert.equal(discoveryStatus(listSessions(root)), "done");
    writeSessionRecord(root, {
      id: "20261019-090000",
      startedAt: "2026-10-19T07:00:00Z",
      budgets: STD,
      request: "dr-2",
      closedAt: "2026-10-19T07:20:00Z",
      usage: { screens: 40, actions: 120, minutes: 20 },
      exhausted: true,
    });
    const all = listSessions(root);
    assert.equal(discoveryStatus(all), "budget");
    assert.deepEqual(
      [all.at(-1)?.screens, all.at(-1)?.request, all.at(-1)?.budgets?.discoveryScreens],
      [40, "dr-2", 40],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the routes: state, start, enhance, replace, cancel, refusals, and an extend offer after a session ran out", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  const told: string[] = [];
  const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
  r.notifyAgent = (t) => told.push(t);
  r.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}/api`;
  const auth = { authorization: `Bearer ${panel.token}` };
  type St = {
    status: string;
    sessions: { id: string }[];
    pending: { id: string; mode: string } | null;
    defaults: Record<string, number>;
    presets: Record<string, Record<string, number>>;
    extend: { base: string; budget: Record<string, number> } | null;
  };
  const get = async () =>
    (await (await fetch(`${base}/discovery`, { headers: auth })).json()) as St;
  const post = async (n: string, body: unknown) => {
    const res = await fetch(`${base}/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    const s0 = await get();
    assert.deepEqual(
      [s0.status, s0.sessions.length, s0.pending, s0.extend],
      ["never", 0, null, null],
    );
    assert.deepEqual(s0.defaults, {
      discoveryScreens: 40,
      discoveryActions: 150,
      discoveryMinutes: 20,
    });
    assert.deepEqual(s0.presets.quick, {
      discoveryScreens: 20,
      discoveryActions: 75,
      discoveryMinutes: 10,
    });
    // enhancing nothing is refused
    assert.match(
      String((await post("discovery-start", { mode: "enhance", budget: STD })).json.error),
      /no earlier discovery to enhance/,
    );
    assert.equal(told.length, 0, "a refused request tells the Director nothing");
    // start
    const go = await post("discovery-start", {
      mode: "start",
      notes: "focus on search",
      areas: ["Search"],
      preset: "quick",
      budget: { discoveryScreens: 20, discoveryActions: 75, discoveryMinutes: 10 },
    });
    assert.equal(go.status, 200);
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /asks to start discovery of Keycraft/);
    assert.match(told[0] ?? "", /20 screens, 75 actions, 10 minutes, the quick choice/);
    assert.equal((await get()).pending?.id, "dr-1");
    const logged = readInputs(seed.dir).find((i) => /start discovery/.test(i.text));
    assert.match(
      logged?.text ?? "",
      /start discovery \(20 screens, 75 actions, 10 min, quick\): focus on search · areas: Search/,
    );
    assert.deepEqual([logged?.stage, logged?.source], ["discovery", "panel"]);
    // a bad budget is refused, nothing is told
    assert.match(
      String(
        (
          await post("discovery-start", {
            mode: "start",
            budget: { ...STD, discoveryScreens: 500 },
          })
        ).json.error,
      ),
      /screens is at most 200/,
    );
    assert.equal(told.length, 1);
    // a second request replaces the first; cancel takes it back
    await post("discovery-start", { mode: "start", budget: STD, preset: "standard" });
    assert.equal(told.length, 2);
    assert.equal((await get()).pending?.id, "dr-2");
    assert.equal((await post("discovery-cancel", {})).status, 200);
    assert.equal((await get()).pending, null);
    assert.equal((await post("discovery-cancel", {})).status, 400, "nothing waiting");
    // a session that ran out of budget: enhance is possible and the extend offer doubles what it had
    const app = appDir(seed.root, rt.requireProject().app.slug);
    writeSessionRecord(app, {
      id: "20261019-090000",
      startedAt: "2026-10-19T07:00:00Z",
      budgets: STD,
      closedAt: "2026-10-19T07:20:00Z",
      usage: { screens: 40, actions: 120, minutes: 20 },
      exhausted: true,
    });
    fs.mkdirSync(path.join(app, "discovery", "20261019-090000"), { recursive: true });
    const s1 = await get();
    assert.deepEqual(
      [s1.status, s1.extend?.base, s1.extend?.budget],
      [
        "budget",
        "20261019-090000",
        { discoveryScreens: 80, discoveryActions: 300, discoveryMinutes: 40 },
      ],
    );
    const enh = await post("discovery-start", {
      mode: "enhance",
      base: "20261019-090000",
      notes: "go deeper on checkout",
      budget: s1.extend?.budget,
    });
    assert.equal(enh.status, 200);
    assert.match(
      told.at(-1) ?? "",
      /ENHANCE the discovery[\s\S]*80 screens, 300 actions, 40 minutes[\s\S]*Build on what exists: 1 earlier session \(the newest is 20261019-090000\)/,
    );
    assert.equal((enh.json.request as { base: string }).base, "20261019-090000");
    // a running session blocks a new request
    (rt as unknown as { discovery: unknown }).discovery = {
      isClosed: false,
      id: "20261019-120000",
    };
    assert.equal((await get()).status, "running");
    assert.match(
      String((await post("discovery-start", { mode: "start", budget: STD })).json.error),
      /a discovery session is running/,
    );
    (rt as unknown as { discovery: unknown }).discovery = undefined;
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
  "a real session takes the budget it was given, writes how it ended, and the page reads it",
  { skip, timeout: 120_000 },
  async () => {
    const fixture: FixtureHandle = await serveFixture(0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-dsess-"));
    try {
      const app = ensureApp(root, "Acme Pulse", fixture.url);
      const tiny = { discoveryScreens: 1, discoveryActions: 30, discoveryMinutes: 5 };
      const d = await DiscoverySession.open({
        root,
        app,
        viewport: { width: 1600, height: 900 },
        budgets: tiny,
        project: "p",
        request: "dr-7",
      });
      const dir = appDir(root, app.slug);
      // open: the record exists, with the budget and the request, and no end yet
      const [opened] = listSessions(dir);
      assert.deepEqual(
        [
          opened?.id,
          opened?.request,
          opened?.budgets?.discoveryScreens,
          opened?.closedAt,
          opened?.older,
        ],
        [d.id, "dr-7", 1, undefined, false],
      );
      assert.equal(
        discoveryStatus(listSessions(dir)),
        "interrupted",
        "open and not running here: cut off",
      );
      assert.equal(discoveryStatus(listSessions(dir), d.id), "running");
      await d.look();
      assert.equal(d.budget().exhausted, true, "one screen was the whole budget");
      await d.close();
      const [closed] = listSessions(dir);
      assert.deepEqual([closed?.screens, closed?.exhausted, closed?.older], [1, true, false]);
      assert.ok(closed?.closedAt);
      assert.equal(
        discoveryStatus(listSessions(dir)),
        "budget",
        "the page says the budget ran out",
      );
    } finally {
      await fixture.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

async function playwright() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await playwright();
const skipBrowser = !browserType && "needs Playwright Chromium";

test(
  "in the browser: the Discovery group says where it stands, Start and Enhance ask in a window with a budget choice, Extend after a used-up budget, take it back",
  { skip: skipBrowser, timeout: 120_000 },
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
    const told: string[] = [];
    const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
    r.notifyAgent = (t) => told.push(t);
    r.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const app = appDir(seed.root, rt.requireProject().app.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
      const dlg = answerDialogs(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // the summary points at it
      await page.goto(`${panel.url}#/project`);
      await page.waitForSelector("[data-act=open-discovery]");
      await page.click("[data-act=open-discovery]");
      await page.waitForSelector(".ds-discovery");
      assert.match(await page.locator("[data-status-word]").innerText(), /Not started/);
      assert.equal(
        await page.locator("[data-act=enhance-discovery]").count(),
        0,
        "nothing to enhance yet",
      );
      // start: the window, the choice fills the numbers, a number makes it custom
      await page.click("[data-act=start-discovery]");
      await page.waitForSelector("[data-act=ask-discovery]");
      assert.equal(
        await page.inputValue("[data-budget=discoveryScreens]"),
        "40",
        "standard is the Config value",
      );
      await page.click("[data-preset=quick]");
      assert.deepEqual(
        await page.evaluate(
          "['discoveryScreens','discoveryActions','discoveryMinutes'].map((k) => document.querySelector(`[data-budget=${k}]`).value)",
        ),
        ["20", "75", "10"],
      );
      await page.fill("[data-budget=discoveryActions]", "90");
      assert.equal(await page.locator("[data-preset=custom]").getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("[data-preset=quick]").getAttribute("aria-pressed"), "false");
      await page.fill("[data-field=notes]", "focus on search");
      await page.fill("[data-field=areas]", "Search box\n\nCart and checkout");
      await page.click("[data-act=ask-discovery]");
      await page.waitForSelector("[data-pending]");
      assert.equal(told.length, 1);
      assert.match(told[0] ?? "", /20 screens, 90 actions, 10 minutes/);
      assert.match(told[0] ?? "", /Their notes: focus on search/);
      assert.match(told[0] ?? "", /Areas they want covered[^\n]*Search box; Cart and checkout/);
      assert.match(
        await page.locator("[data-pending]").innerText(),
        /start request \(20 screens, 90 actions, 10 minutes\)/,
      );
      // take it back
      await page.click("[data-act=take-back]");
      await page.waitForSelector("[data-pending]", { state: "detached" });
      // a session that used up its budget: the page says why, offers to extend; the window doubles the budget
      writeSessionRecord(app, {
        id: "20261019-090000",
        startedAt: "2026-10-19T07:00:00Z",
        budgets: STD,
        closedAt: "2026-10-19T07:20:00Z",
        usage: { screens: 40, actions: 120, minutes: 20 },
        exhausted: true,
      });
      fs.mkdirSync(path.join(app, "discovery", "20261019-090000"), { recursive: true });
      rt.bus.publish(
        "discovery.closed",
        { session: "20261019-090000", message: "closed" },
        seed.slug,
      );
      await page.waitForSelector("[data-status=budget]");
      assert.match(await page.locator("[data-status-word]").innerText(), /Budget used/);
      assert.match(
        await page.locator(".ds-discovery").innerText(),
        /used up its budget \(40 of 40 screens, 120 of 150 actions\)/,
      );
      assert.match(
        await page.locator("[data-session='20261019-090000']").innerText(),
        /40 of 40[\s\S]*budget used up/,
      );
      await page.click("[data-act=extend-budget]");
      await page.waitForSelector("[data-mode=extend]");
      assert.match(await page.locator("[data-mode=extend]").innerText(), /twice what it had/);
      assert.deepEqual(
        await page.evaluate(
          "['discoveryScreens','discoveryActions','discoveryMinutes'].map((k) => document.querySelector(`[data-budget=${k}]`).value)",
        ),
        ["80", "300", "40"],
      );
      await page.fill("[data-field=notes]", "go deeper on checkout");
      await page.click("[data-act=ask-discovery]");
      await page.waitForSelector("[data-pending]");
      assert.match(
        told.at(-1) ?? "",
        /ENHANCE the discovery[\s\S]*80 screens, 300 actions, 40 minutes[\s\S]*Build on what exists: 1 earlier session/,
      );
      // a refused budget says so and keeps the window open
      await page.click("[data-act=take-back]");
      await page.waitForSelector("[data-pending]", { state: "detached" });
      await page.click("[data-act=enhance-discovery]");
      await page.waitForSelector("[data-act=ask-discovery]");
      await page.fill("[data-budget=discoveryScreens]", "500");
      await page.click("[data-act=ask-discovery]");
      await page.waitForSelector(".ds-toast[role=alert]");
      assert.match(
        await page.locator(".ds-toast[role=alert]").first().innerText(),
        /screens is at most 200/,
      );
      assert.equal(
        await page.locator("[data-act=ask-discovery]").count(),
        1,
        "the window is still open",
      );
      await page.keyboard.press("Escape");
      dlg.stop();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
