/**
 * S7 7d (D147): the Login card on the Project page. The words for each state, and the card in a browser against the fixture app: no saved login, a window open,
 * logged in, expired, the app's own check, forget. The headed window is replaced by a headless one that acts as the user (`rt.loginSeam`).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readMeta } from "../src/auth/session.ts";
import { resolveConfig } from "../src/config.ts";
import { loginView, whenWords } from "../src/panel/public/login-core.js";
import { Runtime } from "../src/runtime.ts";
import { ensureProject, readApp } from "../src/workdir/layout.ts";
import { logInByHand, loginFixture } from "./helpers/login-fixture.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";

const app = { slug: "fixture", name: "Fixture", baseUrl: "http://app.test" };
const NOW = Date.parse("2026-10-21T12:00:00Z");

test("the card says what is going on: each state, its words and the actions it offers", () => {
  assert.equal(loginView({ project: null }), null);
  const none = loginView({ project: "p", app, session: { state: "none" } }, NOW);
  assert.deepEqual([none?.title, none?.actions], ["No saved login", ["start"]]);
  assert.match(none?.text ?? "", /An app that needs no login can ignore this/);
  const win = loginView({ project: "p", app, session: { state: "none" }, windowOpen: true }, NOW);
  assert.deepEqual([win?.title, win?.actions], ["A browser window is open", ["confirm", "cancel"]]);
  assert.match(
    win?.text ?? "",
    /Log in by hand in the window on http:\/\/app\.test .*press “I'm logged in”/,
  );
  const ok = loginView(
    {
      project: "p",
      app,
      session: {
        state: "valid",
        savedAt: "2026-10-21T11:30:00Z",
        checkedAt: "2026-10-21T11:59:50Z",
        reason: "no login address, no password field",
      },
    },
    NOW,
  );
  assert.deepEqual(
    [ok?.title, ok?.tone, ok?.actions],
    ["Logged in", "ok", ["check", "start", "forget"]],
  );
  assert.match(ok?.text ?? "", /saved 30 min ago, checked just now/);
  const gone = loginView(
    {
      project: "p",
      app,
      session: {
        state: "expired",
        savedAt: "2026-10-18T12:00:00Z",
        reason: "the page has a password field",
      },
    },
    NOW,
  );
  assert.deepEqual(
    [gone?.title, gone?.tone, gone?.actions],
    ["The saved login has expired", "warn", ["start", "check", "forget"]],
  );
  assert.match(gone?.text ?? "", /Log in again; discovery and recordings are refused until you do/);
  const unk = loginView(
    {
      project: "p",
      app,
      session: { state: "unknown", reason: "the app could not be reached: net::ERR" },
    },
    NOW,
  );
  assert.equal(unk?.title, "Could not check the saved login");
  assert.equal(whenWords("nonsense", NOW), "");
});

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

test(
  "in the browser: log in from the card, check, expire, the app's own check, forget",
  { skip: !browserType && "needs Playwright Chromium", timeout: 180_000 },
  async () => {
    const fx = await loginFixture();
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s7card-"));
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const p = ensureProject(root, { project: "p", appName: "Fixture", appUrl: fx.base });
      rt.setActiveProject(p.slug);
      rt.loginSeam = { headed: false, afterOpen: (pg) => logInByHand(pg) };
      const panel = await rt.ensurePanel();
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const dlg = answerDialogs(page);
      const card = page.locator(".ds-login");
      const state = () => card.getAttribute("data-login-state");
      await page.goto(`${panel.url}#/project`);
      await card.waitFor();
      assert.equal(await state(), "none");
      assert.match(await card.innerText(), /Login for Fixture: No saved login/);
      // log in: a window opens (headless here), the card says so, "I'm logged in" saves and checks
      await page.click("[data-act=login-start]");
      await page.waitForSelector(".ds-login[data-login-state=window]");
      assert.match(await card.innerText(), /A browser window is open/);
      assert.equal(await page.locator("[data-act=login-confirm]").count(), 1);
      assert.equal(await page.locator("[data-act=login-cancel]").count(), 1);
      await page.click("[data-act=login-confirm]");
      await page.waitForSelector(".ds-login[data-login-state=valid]");
      assert.match(await card.innerText(), /Logged in/);
      assert.equal(readMeta(root, p.app.slug).state, "valid");
      // the window can be cancelled: nothing changes
      await page.click("[data-act=login-start]");
      await page.waitForSelector(".ds-login[data-login-state=window]");
      await page.click("[data-act=login-cancel]");
      await page.waitForSelector(".ds-login[data-login-state=valid]");
      assert.equal(rt.login, undefined, "no window is left open");
      // the server forgets the session: Check now says so, the card turns to a warning with Log in again
      fx.expire();
      await page.click("[data-act=login-check]");
      await page.waitForSelector(".ds-login[data-login-state=expired]");
      assert.match(
        await card.innerText(),
        /The saved login has expired[\s\S]*refused until you do/,
      );
      assert.equal(await page.locator("[data-act=login-start]").count(), 1);
      // log in again
      await page.click("[data-act=login-start]");
      await page.waitForSelector(".ds-login[data-login-state=window]");
      await page.click("[data-act=login-confirm]");
      await page.waitForSelector(".ds-login[data-login-state=valid]");
      // the app's own check: open the details, a text that is not there makes the saved login "expired", the right one "valid"
      await card.locator("summary").click();
      await page.fill("[data-rule=text]", "Billing overview");
      await page.click("[data-act=login-rule-save]");
      await page.waitForFunction("true");
      assert.equal(readApp(root, p.app.slug)?.login?.expectText, "Billing overview");
      await page.click("[data-act=login-check]");
      await page.waitForSelector(".ds-login[data-login-state=expired]");
      assert.match(await card.innerText(), /The app's own check did not find “Billing overview”/);
      await page.fill("[data-rule=text]", "Welcome back");
      await page.click("[data-act=login-rule-save]");
      await page.click("[data-act=login-check]");
      await page.waitForSelector(".ds-login[data-login-state=valid]");
      await page.fill("[data-rule=text]", "");
      await page.click("[data-act=login-rule-save]");
      await page.waitForFunction("true");
      for (let i = 0; i < 40 && readApp(root, p.app.slug)?.login; i++)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        readApp(root, p.app.slug)?.login,
        undefined,
        "all three empty: back to the default",
      );
      // forget: a dialog first, then none
      await page.click("[data-act=login-forget]");
      await page.waitForSelector(".ds-login[data-login-state=none]");
      assert.equal(readMeta(root, p.app.slug).state, "none");
      dlg.stop();
      assert.deepEqual(errors, []);
      // no window open: confirming says so
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/login-confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${panel.token}`, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 400);
      assert.match(
        String(((await res.json()) as { error: string }).error),
        /no login window is open/,
      );
    } finally {
      await browser.close();
      await rt.shutdown();
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
