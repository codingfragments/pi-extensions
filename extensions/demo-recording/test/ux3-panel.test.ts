/**
 * UX3 in the browser (D99, D103, D118): what you are viewing and how it relates to the production line,
 * the History, the four actions with their consequence, disabled controls that say why, a stale plan, and
 * one vocabulary on every screen. Runs on the seeded project (test/helpers/panel-seed.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { readState } from "../src/workdir/state.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();
const skip = !browserType && "needs Playwright Chromium";

async function setup() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
    root: seed.root,
    panelPort: 0,
  }));
  const turns: string[] = [];
  const notes: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = (t) => notes.push(t);
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dlg = answerDialogs(page);
  const state = () => readState(seed.dir) as NonNullable<ReturnType<typeof readState>>;
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, rt, turns, notes, panel, page, dlg, state, errors, close };
}

const waitFor = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fn(), "timed out waiting");
};

test(
  "viewing: the summary names the version, its source and how it relates to the line; History and links only look",
  { skip, timeout: 90_000 },
  async () => {
    const { seed, page, panel, state, errors, close } = await setup();
    try {
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".stage-summary");
      const summary = page.locator(".stage-summary");
      assert.match(
        await summary.innerText(),
        /Viewing\s*v2[\s\S]*Draft version[\s\S]*Based on recording take-001/,
      );
      assert.match(
        await summary.innerText(),
        /You are viewing a new draft\. Voice over v1 is in the production line, so the next steps still use v1\./,
      );

      const before = fs.readFileSync(path.join(seed.dir, "state.json"), "utf8");
      // History: every version, with where it stands; keyboard and Escape
      const button = page.locator(".history-btn");
      await button.focus();
      await button.press("Enter");
      const pop = page.locator(".ds-histpop");
      await pop.waitFor();
      assert.equal(
        await page.evaluate("document.activeElement?.tagName"),
        "A",
        "focus moves into the list",
      );
      const text = await pop.innerText();
      assert.match(text, /v2[\s\S]*based on recording take-001[\s\S]*Viewing[\s\S]*Draft version/);
      assert.match(text, /v1[\s\S]*In production line[\s\S]*Approved/);
      assert.equal(
        await pop.getByRole("button", { name: "Use for next steps" }).count(),
        0,
        "v1 is already in the line, v2 is not approved",
      );
      await page.keyboard.press("Escape");
      await pop.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate(`document.activeElement?.classList.contains("history-btn")`),
        true,
        "focus returns to History",
      );

      // a View link only changes the route; Back returns
      await button.click();
      await pop.getByRole("link", { name: "v1" }).click();
      await page.waitForFunction(`location.hash === "#/voice/v1"`);
      await page.waitForFunction(
        `/Viewing\\s*v1/.test(document.querySelector(".stage-summary")?.textContent ?? "")`,
      );
      assert.match(
        await summary.innerText(),
        /Viewing\s*v1[\s\S]*In production line[\s\S]*Approved/,
      );
      assert.equal(
        await page.locator(".stage-summary .ds-notice").count(),
        0,
        "viewing the line's own version has no notice",
      );
      await page.goBack();
      await page.waitForFunction(`location.hash === "#/voice"`);
      assert.equal(
        fs.readFileSync(path.join(seed.dir, "state.json"), "utf8"),
        before,
        "looking changed nothing",
      );
      assert.equal(state().line.vo, 1);

      // a version that does not exist is said, not silently replaced
      await page.goto(`${panel.url}#/voice/v9`);
      await page.waitForSelector("main .card.error");
      assert.match(await page.locator("main .card.error").innerText(), /Show the latest/);
      // the other screens say the same for a version that does not exist
      for (const [screen, label] of [
        ["storyboard", "Storyboard v9"],
        ["annotations", "Annotations v9"],
        ["recording", "Recording take-009"],
        ["render", "Render v99"],
      ] as const) {
        await page.goto(`${panel.url}#/${screen}/v${screen === "render" ? 99 : 9}`);
        await page.waitForFunction(
          `document.querySelector(".stage-summary .ds-notice[data-tone=warn]")`,
        );
        assert.match(
          await page.locator(".stage-summary .ds-notice[data-tone=warn]").innerText(),
          new RegExp(`${label} does not exist\\. Show the latest`),
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "actions: Approve only keeps the line and starts nothing; Approve & use asks when something leaves the line, then starts one turn",
  { skip, timeout: 90_000 },
  async () => {
    const { seed, page, panel, dlg, state, turns, notes, close } = await setup();
    try {
      await page.goto(`${panel.url}#/storyboard`);
      await page.waitForSelector(".version-actions");
      // wait for the plans: the buttons are enabled, the hint names the Director
      await page.waitForFunction(
        `document.querySelector(".version-actions [data-intent=approve-use]")`,
      );
      assert.match(
        await page.locator(".version-actions .cost-hint").innerText(),
        /starts the Director/,
      );

      // Approve only: no dialog, no turn, the line is as it was, the user is told
      await page.getByRole("button", { name: "Approve only" }).click();
      await page.waitForSelector(".toast");
      assert.match(
        await page.locator(".toast").first().innerText(),
        /storyboard v2 approved\. The production line is unchanged\./i,
      );
      assert.deepEqual(dlg.seen, [], "nothing leaves the line, so no dialog");
      assert.equal(state().line.storyboard, 1);
      assert.ok(state().accepted.storyboard?.["2"]);
      assert.deepEqual([turns.length, notes.length], [0, 1], "a quiet note, no turn");
      assert.equal(
        await page.locator("nav.steps a[data-tab=storyboard]").getAttribute("data-state"),
        "complete",
        "no newer draft is waiting any more",
      );

      // Use for next steps: v2 takes over, and what was built on v1 leaves the line: the dialog says so
      await page.getByRole("button", { name: "Use for next steps" }).click();
      await waitFor(() => dlg.seen.length === 1);
      assert.match(
        dlg.seen[0] ?? "",
        /Use storyboard v2 for the next steps\?[\s\S]*Production line now[\s\S]*After[\s\S]*Recording: take-001 → none \(stays approved\)/,
      );
      await waitFor(() => state().line.storyboard === 2);
      assert.deepEqual(
        Object.keys(state().accepted.recording ?? {}),
        ["1"],
        "take-001 stays approved",
      );

      // Use v1 again, then Approve & use on a draft: a dialog first (the old line leaves), one turn after
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".version-actions");
      await page.locator("nav.steps a", { hasText: "Storyboard" }).click();
      await page.getByRole("button", { name: "Withdraw approval" }).click();
      await waitFor(() => dlg.seen.length === 2);
      assert.match(dlg.seen[1] ?? "", /Withdraw the approval of storyboard v2\?/);
      await waitFor(() => state().accepted.storyboard?.["2"] === undefined);
      assert.equal(turns.length, 0, "no turn so far: only Approve & use starts the Director");

      await page.getByRole("button", { name: "Approve & use v2" }).click();
      await waitFor(() => turns.length === 1);
      assert.match(
        turns[0] ?? "",
        /Storyboard v2 .* APPROVED[\s\S]*Production line: storyboard v2/,
      );
      assert.equal(state().line.storyboard, 2);
      assert.equal(state().line.recording, undefined);
      assert.ok(
        dlg.seen.some((d) =>
          /Approve and use storyboard v2\?[\s\S]*Recording: take-001 → none/.test(d),
        ),
      );
      void seed;
    } finally {
      await close();
    }
  },
);

test(
  "a disabled action says why; a stale plan is shown again, never applied",
  { skip, timeout: 90_000 },
  async () => {
    const { page, panel, dlg, state, close } = await setup();
    try {
      // Render: final v1 is blocked by QA. The button is disabled and the reason is next to it.
      await page.goto(`${panel.url}#/render/v1`);
      await page.waitForSelector(".ds-inspector[data-version='1']");
      const card = page.locator(".ds-inspector[data-version='1']");
      const btn = card.getByRole("button", { name: "Approve final v1" });
      assert.equal(await btn.getAttribute("aria-disabled"), "true");
      assert.match(await card.locator(".ds-why").first().innerText(), /blocking item/i);
      await btn.click({ force: true }); // a user pressing it anyway
      assert.equal(state().accepted.render?.["1"], undefined, "a disabled action does nothing");
      assert.equal(dlg.seen.length, 0);

      // A stale plan: the server says the project moved on while the dialog was open
      await page.goto(`${panel.url}#/storyboard`);
      await page.waitForSelector(
        ".version-actions [data-intent=use], .version-actions [data-intent=approve-use]",
      );
      let calls = 0;
      await page.route("**/api/version-act", async (route) => {
        calls++;
        if (calls > 1) return route.continue();
        const body = JSON.parse(route.request().postData() ?? "{}");
        const plan = await (
          await page.request.post(`${panel.url.split("?")[0]}api/version-plan`, {
            headers: {
              authorization: `Bearer ${new URL(panel.url).searchParams.get("token")}`,
              "content-type": "application/json",
            },
            data: { stage: body.stage, version: body.version, intent: body.intent },
          })
        ).json();
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ stale: true, plan }),
        });
      });
      await page.getByRole("button", { name: "Approve & use v2" }).click();
      await waitFor(() => dlg.seen.length >= 2);
      assert.match(dlg.seen[0] ?? "", /Approve and use storyboard v2\?/);
      assert.match(
        dlg.seen[1] ?? "",
        /The project changed while you were looking; this is what happens now\./,
      );
      await waitFor(() => state().accepted.storyboard?.["2"] !== undefined);
      assert.equal(calls, 2, "asked again with the fresh plan, then applied once");
    } finally {
      await close();
    }
  },
);

test(
  "one vocabulary on every screen: approved, production line, blocked by dependency, variant",
  { skip, timeout: 90_000 },
  async () => {
    const { page, panel, close } = await setup();
    try {
      const old =
        /\b(accept(ed|ing)?|un-accept|working line|orphan(ed)?|flavou?rs?|request changes|work on this)\b/i;
      const problems: string[] = [];
      for (const screen of [
        "project",
        "storyboard",
        "recording",
        "voice",
        "annotations",
        "render",
      ]) {
        await page.goto(`${panel.url}#/${screen}`);
        await page.waitForSelector("main > *");
        await page.waitForTimeout(500);
        await page.evaluate(
          `document.querySelectorAll("main details").forEach((d) => { d.open = true; })`,
        );
        const text = (await page.locator("main").innerText()).split("\n");
        for (const line of text)
          if (old.test(line)) problems.push(`${screen}: ${line.trim().slice(0, 100)}`);
      }
      assert.deepEqual(problems, []);
    } finally {
      await close();
    }
  },
);
