/**
 * S7 7b (D147): reusing a manual login. The plain rule, the optional rule per app, the probe, the login (saved owner-only and checked in a fresh browser), a login
 * that cannot be kept, forgetting, the check before discovery and recording, and `/demo login`, `/demo logout`, `/demo session`. A real Chromium against a fixture.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sessionGuardFor } from "../src/auth/guard.ts";
import {
  authDir,
  checkBeforeStart,
  factsOf,
  forgetSession,
  hasState,
  loginSession,
  looksLoggedOut,
  probeSession,
  readMeta,
  setLoginRule,
  statePath,
} from "../src/auth/session.ts";
import { cmdLogin, cmdLogout, cmdSession } from "../src/commands/demo.ts";
import { resolveConfig } from "../src/config.ts";
import { answerFor, loginSaved } from "../src/question-flow.ts";
import { pendingQuestions, readQuestions } from "../src/questions.ts";
import { readEvents } from "../src/recorder/events.ts";
import { recordTake } from "../src/recorder/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { registerBrowserTool } from "../src/tools/browser.ts";
import { ensureProject, readApp } from "../src/workdir/layout.ts";
import { logInByHand, loginFixture } from "./helpers/login-fixture.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const skip = !(await chromium()) && "needs Playwright Chromium";

test("the plain rule: a login-looking address or a visible password field; nothing else", () => {
  const out = (url: string, hasPassword = false) => looksLoggedOut({ url, hasPassword });
  for (const u of [
    "https://x.test/login",
    "https://x.test/users/sign_in",
    "https://x.test/signin?next=/a",
    "https://sso.x.test/",
    "https://x.test/auth/realms/x",
    "https://x.test/oauth2/authorize?c=1",
    "https://x.test/#/login",
    "https://x.test/accounts/login/",
  ])
    assert.equal(out(u).out, !u.includes("sso.x.test"), u);
  assert.equal(
    out("https://login.x.test/").out,
    false,
    "a host called login is not a path (the plain rule looks at the path)",
  );
  assert.equal(out("https://x.test/app", true).out, true);
  assert.match(out("https://x.test/app", true).reason, /password field/);
  assert.deepEqual(out("https://x.test/dashboard/billing"), {
    out: false,
    reason: "no login address, no password field",
  });
  assert.equal(
    out("https://x.test/blog/author-login-tips").out,
    false,
    "a word inside another word is not a login",
  );
});

const setup = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s7-"));

test(
  "login: saved owner-only, checked in a fresh browser, the record says when and nothing of the content",
  { skip, timeout: 120_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    try {
      const { app } = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      assert.deepEqual(readMeta(root, app.slug), { state: "none" });
      const done = Promise.resolve();
      const r = await loginSession({
        root,
        app,
        headed: false,
        waitForDone: done,
        afterOpen: (p) => logInByHand(p),
      });
      assert.equal(r.saved, true, r.problem);
      assert.equal(r.probe.state, "valid");
      assert.equal(
        fs.statSync(statePath(root, app.slug)).mode & 0o777,
        0o600,
        "the state is owner-only",
      );
      assert.equal(
        fs.statSync(authDir(root, app.slug)).mode & 0o777,
        0o700,
        "and so is its folder",
      );
      assert.equal(
        fs.readdirSync(authDir(root, app.slug)).filter((f) => f.includes(".new")).length,
        0,
        "no temporary file is left",
      );
      const meta = readMeta(root, app.slug);
      assert.equal(meta.state, "valid");
      assert.match(meta.savedAt ?? "", /^\d{4}-/);
      assert.ok(
        !JSON.stringify(meta).includes("sid"),
        "the record never holds what the state holds",
      );
      assert.equal(hasState(root, app.slug), true);
      // a later probe: valid, then the server forgets the session: expired, with the reason
      assert.equal((await probeSession({ root, app })).state, "valid");
      fx.expire();
      const gone = await probeSession({ root, app });
      assert.equal(gone.state, "expired");
      assert.match(gone.reason, /login address|password field/);
      assert.equal(readMeta(root, app.slug).state, "expired", "the record follows the last check");
      // forgetting
      assert.equal(forgetSession(root, app.slug), true);
      assert.deepEqual(readMeta(root, app.slug), { state: "none" });
      assert.equal(forgetSession(root, app.slug), false);
    } finally {
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a login a saved state cannot keep (sessionStorage) is NOT saved, said so, and the previous login stays",
  { skip, timeout: 120_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    try {
      const { app } = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      const first = await loginSession({
        root,
        app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (p) => logInByHand(p),
      });
      assert.equal(first.saved, true);
      const before = fs.readFileSync(statePath(root, app.slug), "utf8");
      const second = await loginSession({
        root,
        app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (p) => logInByHand(p, "session"),
      });
      assert.equal(second.saved, false);
      assert.match(
        second.problem ?? "",
        /a fresh browser with the saved login is logged out.*sessionStorage.*nothing was saved/,
      );
      assert.equal(
        fs.readFileSync(statePath(root, app.slug), "utf8"),
        before,
        "the earlier login is untouched",
      );
      assert.equal(
        fs.readdirSync(authDir(root, app.slug)).filter((f) => f.includes(".new")).length,
        0,
      );
      // giving up: the promise rejects, nothing is saved
      const gaveUp = Promise.reject(new Error("you cancelled the login"));
      gaveUp.catch(() => undefined);
      const third = await loginSession({ root, app, headed: false, waitForDone: gaveUp });
      assert.deepEqual([third.saved, third.problem], [false, "you cancelled the login"]);
      assert.equal(fs.readFileSync(statePath(root, app.slug), "utf8"), before);
    } finally {
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the app's own rule: a text or selector that proves you are in decides, and the plain rule is not asked",
  { skip, timeout: 120_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    try {
      const { app } = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      await loginSession({
        root,
        app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (p) => logInByHand(p),
      });
      const withRule = (rule: Parameters<typeof setLoginRule>[2]) =>
        setLoginRule(root, app.slug, rule);
      assert.equal(
        (await probeSession({ root, app: withRule({ expectText: "Welcome back" }) })).state,
        "valid",
      );
      assert.equal(
        (await probeSession({ root, app: withRule({ expectSelector: "h1" }) })).state,
        "valid",
      );
      const wrong = await probeSession({ root, app: withRule({ expectText: "Billing overview" }) });
      assert.equal(wrong.state, "expired");
      assert.match(wrong.reason, /the app's own check did not find “Billing overview”/);
      const sel = await probeSession({ root, app: withRule({ expectSelector: "#no-such" }) });
      assert.match(sel.reason, /did not find #no-such/);
      // another page to open
      assert.equal(
        (await probeSession({ root, app: withRule({ url: "/app", expectText: "Dashboard" }) }))
          .state,
        "valid",
      );
      // stored in app.json, cleared again
      assert.deepEqual(readApp(root, app.slug)?.login, { url: "/app", expectText: "Dashboard" });
      setLoginRule(root, app.slug, undefined);
      assert.equal(readApp(root, app.slug)?.login, undefined);
      // an app that cannot be reached is "unknown", not "expired"
      await fx.close();
      const down = await probeSession({ root, app: { ...app, login: undefined } });
      assert.equal(down.state, "unknown");
      assert.match(down.reason, /the app could not be reached/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "before discovery or a recording: no saved login passes, a good one passes, an expired one stops with what to do, an unreachable app passes with a note",
  { skip, timeout: 120_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    try {
      const { app } = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      assert.deepEqual(await checkBeforeStart({ root, app }), { ok: true });
      await loginSession({
        root,
        app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (p) => logInByHand(p),
      });
      assert.deepEqual(await checkBeforeStart({ root, app }), { ok: true });
      fx.expire();
      const stopped = await checkBeforeStart({ root, app });
      assert.equal(stopped.ok, false);
      assert.match(
        (stopped as { message: string }).message,
        /^the saved login for Fixture has expired \(.*\): log in again with \/demo login \(or on the Project page\), then start again$/,
      );
      await fx.close();
      const note = await checkBeforeStart({ root, app });
      assert.equal(note.ok, true);
      assert.match((note as { note?: string }).note ?? "", /could not check the login for Fixture/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the discovery browser refuses to open on an expired login, tells the panel, and opens when there is none",
  { skip, timeout: 120_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    try {
      const p = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      rt.setActiveProject(p.slug);
      const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
      registerBrowserTool(
        { registerTool: (t: { name: string }) => tools.set(t.name, t as never) } as never,
        rt,
      );
      const tool = tools.get("demo_rec_browser");
      assert.ok(tool);
      const events: string[] = [];
      rt.bus.subscribe((e: { type: string }) => events.push(e.type));
      await loginSession({
        root,
        app: p.app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (pg) => logInByHand(pg),
      });
      fx.expire();
      await assert.rejects(
        () => tool.execute("1", { action: "open" }, undefined, undefined, undefined),
        /the saved login for Fixture has expired/,
      );
      assert.ok(events.includes("auth.expired"));
      assert.equal(rt.discovery, undefined, "no browser was left open");
    } finally {
      await rt.closeDiscovery();
      await rt.shutdown();
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "/demo login, /demo session, /demo logout: the chat's way through the same engine",
  { skip, timeout: 120_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    try {
      const p = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      rt.setActiveProject(p.slug);
      const said: string[] = [];
      const asked: string[] = [];
      const ctx = (answer: boolean) =>
        ({
          hasUI: true,
          ui: {
            notify: (t: string) => said.push(t),
            confirm: async (t: string, m: string) => {
              asked.push(`${t} | ${m}`);
              return answer;
            },
          },
        }) as never;
      await cmdSession(rt, [], ctx(true));
      assert.match(said.at(-1) ?? "", /^no saved login for Fixture: \/demo login/);
      // cancelled: nothing saved
      await cmdLogin(rt, ctx(false), { headed: false, afterOpen: (pg) => logInByHand(pg) });
      assert.match(said.at(-1) ?? "", /^the login was not saved: you cancelled the login$/);
      assert.equal(hasState(root, p.app.slug), false);
      // confirmed: saved
      await cmdLogin(rt, ctx(true), { headed: false, afterOpen: (pg) => logInByHand(pg) });
      assert.match(
        asked.at(-1) ?? "",
        /^Log in to Fixture \| A browser window is open on http:\/\/127\.0\.0\.1:\d+\/?\. Log in by hand there/,
      );
      assert.match(
        said.at(-1) ?? "",
        /^saved the login for Fixture \(owner-only, never in a zip\)\. A fresh browser with it is logged in: /,
      );
      assert.equal(hasState(root, p.app.slug), true);
      assert.equal(rt.loginInProgress, false);
      assert.equal(readMeta(root, p.app.slug).state, "valid");
    } finally {
      await rt.shutdown();
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

// ---- 7c: a login that expires inside a take --------------------------------------------------------------------------------

const ffmpegOk = (await import("../src/media/ffmpeg.ts")).hasBinary("ffmpeg");
const skipTake = (!(await chromium()) || !ffmpegOk) && "needs Playwright Chromium + ffmpeg";

function takeOpts(root: string, base: string, yaml: string, extra: Record<string, unknown> = {}) {
  const projectDir = path.join(root, `proj${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    projectDir,
    storyboard: parseStoryboard(yaml, { version: 1 }),
    storyboardVersion: 1,
    baseUrl: base,
    viewport: { width: 800, height: 500, dpr: 1 },
    fps: 10,
    seed: 3,
    encode: false,
    ...extra,
  } as Parameters<typeof recordTake>[0];
}
const SB = `start_url: /app
scenes:
  - id: one
    title: Dashboard
    steps:
      - { do: pause, ms: 500 }
  - id: two
    title: Reports
    deep_link: /app/two
    steps:
      - { do: goto, url: /app/two }
      - { do: pause, ms: 500 }
`;

test(
  "a login that expires between scenes pauses the take, asks, and goes on from that scene after a new login",
  { skip: skipTake, timeout: 180_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    try {
      const p = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      rt.setActiveProject(p.slug);
      await loginSession({
        root,
        app: p.app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (pg) => logInByHand(pg),
      });
      const events: { type: string; data?: Record<string, unknown> }[] = [];
      rt.bus.subscribe((e) => events.push({ type: e.type, ...(e.data ? { data: e.data } : {}) }));
      const ac = new AbortController();
      const take = recordTake(
        takeOpts(p.dir, fx.base, SB, {
          storageState: statePath(root, p.app.slug),
          sessionGuard: sessionGuardFor(rt, p, ac.signal),
          signal: ac.signal,
          // the server forgets the session as soon as scene one is done: the next page is a login page
          onEvent: (e: { type: string; scene?: string }) => {
            if (e.type === "scene-end" && e.scene === "one") fx.expire();
          },
        }),
      );
      // the take pauses: a question, an event, nothing finished
      for (let i = 0; i < 200 && !pendingQuestions(p.dir).length; i++)
        await new Promise((r) => setTimeout(r, 100));
      const q = pendingQuestions(p.dir)[0];
      assert.ok(q, "the take asks");
      assert.deepEqual(
        [q.role, q.auth?.app, q.options.map((o) => o.word)],
        ["Operator", p.app.slug, ["login", "stop"]],
      );
      assert.match(q.what, /Your login for Fixture expired while recording \(scene two\)/);
      assert.ok(
        events.some(
          (e) =>
            e.type === "auth.expired" &&
            /expired while recording \(scene two\)/.test(String(e.data?.message)),
        ),
      );
      // you log in again (/demo login does exactly this) and the take goes on
      const r = await loginSession({
        root,
        app: p.app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (pg) => logInByHand(pg),
      });
      assert.equal(r.saved, true, r.problem);
      loginSaved(rt, p.app.slug, p.app.name);
      const result = await take;
      assert.equal(result.segments.length, 2, "one segment before the pause and one after");
      assert.match(
        result.segments[1]?.resumedAfter?.error ?? "",
        /the login expired; logged in again/,
      );
      assert.equal(result.segments[1]?.resumedAfter?.scene, "two");
      assert.deepEqual(
        result.scenes.map((s) => s.id),
        ["one", "two"],
        "both scenes are in the take, scene two once",
      );
      assert.ok(
        readEvents(path.join(result.takeDir, "events.jsonl")).some((e) => e.type === "stitch"),
      );
      const attempts = fs.readFileSync(path.join(result.takeDir, "attempts.jsonl"), "utf8");
      assert.match(attempts, /the login expired in scene two/);
      // the question was answered by the login, not left behind
      const all = readQuestions(p.dir);
      assert.deepEqual([all[0]?.status, all[0]?.answer?.word], ["answered", "login"]);
      assert.ok(events.some((e) => e.type === "auth.saved"));
    } finally {
      await rt.shutdown();
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "giving up on the pause (stop) ends the take as cancelled and leaves no question waiting",
  { skip: skipTake, timeout: 180_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    try {
      const p = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      rt.setActiveProject(p.slug);
      await loginSession({
        root,
        app: p.app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (pg) => logInByHand(pg),
      });
      const ac = new AbortController();
      const take = recordTake(
        takeOpts(p.dir, fx.base, SB, {
          storageState: statePath(root, p.app.slug),
          sessionGuard: sessionGuardFor(rt, p, ac.signal),
          signal: ac.signal,
          onEvent: (e: { type: string; scene?: string }) => {
            if (e.type === "scene-end" && e.scene === "one") fx.expire();
          },
        }),
      );
      take.catch(() => undefined);
      for (let i = 0; i < 200 && !pendingQuestions(p.dir).length; i++)
        await new Promise((r) => setTimeout(r, 100));
      const q = pendingQuestions(p.dir)[0];
      assert.ok(q);
      // "stop" from the panel or the chat: the engine cancels the recording job (here: the same abort)
      const answered = answerFor(rt, q.id, "stop", "chat");
      assert.ok(answered.ok);
      ac.abort();
      await assert.rejects(() => take, /recording cancelled/);
      assert.equal(pendingQuestions(p.dir).length, 0);
    } finally {
      await rt.shutdown();
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a page that looks like a login but is one you are still logged in to does not stop the take, and is not asked about twice",
  { skip: skipTake, timeout: 180_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    try {
      const p = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      await loginSession({
        root,
        app: p.app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (pg) => logInByHand(pg),
      });
      let suspected = 0;
      let confirmed = 0;
      const guard = {
        suspect: async (page: import("playwright").Page) => {
          const v = looksLoggedOut(await factsOf(page));
          if (v.out) suspected++;
          return v.out ? v.reason : undefined;
        },
        confirm: async () => {
          confirmed++;
          return (await probeSession({ root, app: p.app })).state === "expired";
        },
        waitForLogin: async () => {
          throw new Error("must not ask: the login is fine");
        },
      };
      const yaml = `start_url: /app
scenes:
  - id: settings
    title: Settings
    steps:
      - { do: goto, url: /app/settings }
      - { do: pause, ms: 300 }
      - { do: pause, ms: 300 }
`;
      const result = await recordTake(
        takeOpts(p.dir, fx.base, yaml, {
          storageState: statePath(root, p.app.slug),
          sessionGuard: guard,
        }),
      );
      assert.equal(result.segments.length, 1, "no pause, no new segment");
      assert.equal(
        suspected,
        1,
        "the password field is noticed once; the page is then cleared and not looked at again",
      );
      assert.equal(
        confirmed,
        1,
        "the saved login was confirmed once, in a fresh browser, and found good",
      );
    } finally {
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
