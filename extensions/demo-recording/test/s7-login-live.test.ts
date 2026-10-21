/**
 * The login window is checked while it is open (R3-9): "Check this window" looks at it without closing anything; "I'm logged in" looks at the window first and keeps it
 * open, saying why, when you are not in yet or when what it holds cannot be reused; the chat's `/demo login` asks again in the same way. A real Chromium against the
 * login fixture.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { hasState, loginSession, readMeta } from "../src/auth/session.ts";
import { cmdLogin } from "../src/commands/demo.ts";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { logInByHand, loginFixture } from "./helpers/login-fixture.ts";

async function chromiumOk() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumOk()) && "needs Playwright Chromium";
const setup = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s7live-"));

test(
  "the engine: a window that still looks logged out is kept and says why; a login a saved state cannot keep is kept too; giving up saves nothing",
  { skip, timeout: 120_000 },
  async () => {
    const fx = await loginFixture();
    const root = setup();
    try {
      const { app } = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      // 1. "I'm logged in" pressed too early: the window is on the login page. It is kept, the reason says so, and the second try saves
      let page: Page | undefined;
      let live: (() => Promise<{ state: string; reason: string }>) | undefined;
      const whys: string[] = [];
      const first = await loginSession({
        root,
        app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: async (p) => {
          page = p;
        },
        onOpened: (api) => {
          live = api.check;
        },
        confirmAgain: async (why) => {
          whys.push(why);
          // between the two answers: the window can be looked at, and then you log in
          assert.equal((await live?.())?.state, "expired");
          await logInByHand(page as Page);
          assert.equal((await live?.())?.state, "valid");
        },
      });
      assert.equal(first.saved, true, first.problem);
      assert.equal(whys.length, 1);
      assert.match(
        whys[0] ?? "",
        /^this window still looks logged out \(.*login.*\)\. Finish logging in/,
      );
      assert.equal(readMeta(root, app.slug).state, "valid");

      // 2. a login only kept in sessionStorage: a fresh browser cannot use it, the window is kept, and giving up leaves the saved one alone
      const before = fs.readFileSync(
        path.join(root, "apps", app.slug, "auth", "state.json"),
        "utf8",
      );
      const whys2: string[] = [];
      const second = await loginSession({
        root,
        app,
        headed: false,
        waitForDone: Promise.resolve(),
        afterOpen: (p) => logInByHand(p, "session"),
        confirmAgain: (why) => {
          whys2.push(why);
          return Promise.reject(new Error("you cancelled the login"));
        },
      });
      assert.equal(whys2.length, 1);
      assert.match(
        whys2[0] ?? "",
        /^a fresh browser with this login is logged out .*sessionStorage.*Nothing was saved$/,
      );
      assert.deepEqual([second.saved, second.problem], [false, "you cancelled the login"]);
      assert.equal(
        fs.readFileSync(path.join(root, "apps", app.slug, "auth", "state.json"), "utf8"),
        before,
        "the earlier login is untouched",
      );
      assert.equal(
        fs.readdirSync(path.join(root, "apps", app.slug, "auth")).filter((f) => f.includes(".new"))
          .length,
        0,
      );
    } finally {
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the panel: Check this window, then I'm logged in too early keeps the window and says why, then it saves",
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
      let win: Page | undefined;
      rt.loginSeam = {
        headed: false,
        afterOpen: async (pg) => {
          win = pg;
        },
      };
      const panel = await rt.ensurePanel();
      const call = async (name: string) => {
        const res = await fetch(`http://127.0.0.1:${panel.port}/api/${name}`, {
          method: "POST",
          headers: { authorization: `Bearer ${panel.token}`, "content-type": "application/json" },
          body: "{}",
        });
        return {
          status: res.status,
          body: (await res.json()) as Record<string, unknown> & {
            probe: { state: string };
            windowOpen: boolean;
            saved: boolean;
            notYet: boolean;
            problem: string;
          },
        };
      };
      assert.equal((await call("login-check-live")).status, 400, "no window: nothing to look at");
      await call("login-start");
      const early = await call("login-check-live");
      assert.equal(early.body.probe.state, "expired");
      assert.equal(early.body.windowOpen, true);
      // too early: not saved, not closed, the reason is the answer
      const notYet = await call("login-confirm");
      assert.equal(notYet.body.saved, false);
      assert.equal(notYet.body.notYet, true);
      assert.match(String(notYet.body.problem), /this window still looks logged out/);
      assert.equal(notYet.body.windowOpen, true, "the window stays open");
      assert.equal(hasState(root, p.app.slug), false);
      assert.ok(
        rt.bus.recent().some((e) => e.type === "auth.not-yet"),
        "the panel hears about it",
      );
      // log in by hand, look again, confirm
      await logInByHand(win as Page);
      assert.equal((await call("login-check-live")).body.probe.state, "valid");
      const saved = await call("login-confirm");
      assert.equal(saved.body.saved, true);
      assert.equal(saved.body.windowOpen, false);
      assert.equal(readMeta(root, p.app.slug).state, "valid");
    } finally {
      await rt.shutdown();
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "/demo login: pressing Yes too early is told why and asked again, with the window still open",
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
      let win: Page | undefined;
      rt.loginSeam = {
        headed: false,
        afterOpen: async (pg) => {
          win = pg;
        },
      };
      const asked: string[] = [];
      const said: string[] = [];
      const ctx = {
        hasUI: true,
        ui: {
          notify: (t: string) => said.push(t),
          confirm: async (t: string, m: string) => {
            asked.push(`${t} | ${m}`);
            if (asked.length === 2) await logInByHand(win as Page); // you log in now, then say Yes again
            return true;
          },
        },
      } as never;
      await cmdLogin(rt, ctx);
      assert.equal(asked.length, 2, "asked twice");
      assert.match(asked[0] ?? "", /^Log in to Fixture \|/);
      assert.match(
        asked[1] ?? "",
        /^Not logged in yet: Fixture \| this window still looks logged out .*The window is still open\. Press Yes when you are logged in, No to cancel\.$/s,
      );
      assert.match(said.at(-1) ?? "", /^saved the login for Fixture/);
      assert.equal(readMeta(root, p.app.slug).state, "valid");
      assert.equal(rt.login, undefined);
    } finally {
      await rt.shutdown();
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
