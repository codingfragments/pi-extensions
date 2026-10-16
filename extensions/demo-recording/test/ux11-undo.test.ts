/**
 * UX11 (D127): Undo after approve, approve & use, use and withdraw. One click takes the action back, once, and only
 * while nothing else has changed the approvals or the production line; the Director is told in a note; deleting
 * files has no Undo.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { UNDO_TTL_MS } from "../src/panel/version-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { readState } from "../src/workdir/state.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

// biome-ignore lint/suspicious/noExplicitAny: the tests index into replies of many shapes
type Reply = Record<string, any>;

function setup() {
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
  const t = rt.routeTables();
  const post = async (name: string, body: Record<string, unknown>) =>
    (await (t.post[name] as (b: Record<string, unknown>) => unknown)(body)) as Reply;
  const state = () => readState(seed.dir) as NonNullable<ReturnType<typeof readState>>;
  const act = async (stage: string, version: number, intent: string) => {
    const plan = await post("version-plan", { stage, version, intent });
    return post("version-act", { stage, version, intent, token: plan.token });
  };
  /** What Undo has to restore: the approvals, the line and the phase (not the log). */
  const core = () => {
    const s = state();
    return JSON.stringify({ a: s.accepted, l: s.line, p: s.phase });
  };
  return { seed, rt, turns, notes, post, state, act, core };
}

test("every approve, use and withdraw returns a one-time Undo", async () => {
  const { rt, act } = setup();
  try {
    for (const [stage, v, intent] of [
      ["vo", 2, "approve-only"],
      ["vo", 2, "use"],
      ["vo", 2, "withdraw"],
      ["storyboard", 2, "approve-use"],
    ] as const) {
      const r = await act(stage, v, intent);
      assert.equal(typeof r.undo, "string", `${intent} can be undone`);
    }
  } finally {
    await rt.shutdown();
  }
});

test("Undo of Approve only puts the approvals back and tells the Director in a note, not a turn", async () => {
  const { rt, act, post, core, state, turns, notes } = setup();
  try {
    const before = core();
    const r = await act("vo", 2, "approve-only");
    assert.notEqual(core(), before);
    notes.length = 0;
    const u = await post("version-undo", { undo: r.undo });
    assert.equal(u.undone, true);
    assert.equal(core(), before, "approvals, line and phase exactly as before");
    assert.equal(
      state().history.at(-1)?.event,
      "undone",
      "the log keeps both the action and the undo",
    );
    assert.equal(turns.length, 0, "no turn was started");
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /UNDID[\s\S]*approving voice-over v2[\s\S]*Disregard/);
  } finally {
    await rt.shutdown();
  }
});

test("Undo of Approve & use restores the line and the phase; the turn it started is answered by a note", async () => {
  const { rt, act, post, core, turns, notes } = setup();
  try {
    const before = core();
    const r = await act("storyboard", 2, "approve-use");
    assert.equal(turns.length, 1, "approve & use started a turn");
    assert.notEqual(core(), before);
    const u = await post("version-undo", { undo: r.undo });
    assert.equal(u.undone, true);
    assert.equal(core(), before);
    assert.match(notes.at(-1) ?? "", /UNDID[\s\S]*approving and using storyboard v2[\s\S]*stop/);
  } finally {
    await rt.shutdown();
  }
});

test("Undo of Use restores the line; Undo of Withdraw restores the approval with its original time", async () => {
  const { rt, act, post, core, state } = setup();
  try {
    await act("vo", 2, "approve-only");
    const beforeUse = core();
    const used = await act("vo", 2, "use");
    assert.equal(state().line.vo, 2);
    assert.equal((await post("version-undo", { undo: used.undo })).undone, true);
    assert.equal(core(), beforeUse);
    const at = state().accepted.vo?.["1"];
    assert.ok(at);
    const before = core();
    const w = await act("vo", 1, "withdraw");
    assert.equal(state().accepted.vo?.["1"], undefined);
    assert.equal((await post("version-undo", { undo: w.undo })).undone, true);
    assert.equal(state().accepted.vo?.["1"], at, "the same approval time, not a new approval");
    assert.equal(core(), before);
  } finally {
    await rt.shutdown();
  }
});

test("Undo is refused, with the reason, when something else changed since; once; and not when too old", async () => {
  const { rt, act, post, core } = setup();
  try {
    const a = await act("vo", 2, "approve-only");
    await act("storyboard", 2, "approve-only"); // the approvals moved on
    const afterB = core();
    const refused = await post("version-undo", { undo: a.undo });
    assert.equal(refused.stale, true);
    assert.match(refused.reason, /changed since[\s\S]*Withdraw approval or Use for next steps/);
    assert.equal(core(), afterB, "a refused Undo writes nothing");
    // single use
    const c = await act("annotations", 1, "withdraw");
    assert.equal((await post("version-undo", { undo: c.undo })).undone, true);
    const again = await post("version-undo", { undo: c.undo });
    assert.equal(again.stale, true);
    assert.match(again.reason, /already undone/);
    // unknown id
    assert.equal((await post("version-undo", { undo: "nope" })).stale, true);
    // too old
    const d = await act("annotations", 1, "withdraw");
    const real = Date.now;
    mock.method(Date, "now", () => real() + UNDO_TTL_MS + 1000);
    try {
      assert.equal((await post("version-undo", { undo: d.undo })).stale, true);
    } finally {
      mock.restoreAll();
    }
  } finally {
    await rt.shutdown();
  }
});

test("Delete files has no Undo, and a refused action offers none", async () => {
  const { rt, post } = setup();
  try {
    const plan = await post("version-plan", { stage: "vo", version: 2, intent: "withdraw" });
    assert.ok(plan.blockers.length > 0, "v2 is not approved: nothing to withdraw");
    const r = await post("version-act", {
      stage: "vo",
      version: 2,
      intent: "withdraw",
      token: plan.token,
    }).catch((e: Error) => ({ error: e.message }) as Reply);
    assert.equal(r.undo, undefined);
    const del = await post("render-delete", { version: 3, confirmAccepted: false }).catch(
      (e: Error) => ({ error: e.message }) as Reply,
    );
    assert.equal(del.undo, undefined, "files are removed for good; the dialog is the safeguard");
  } finally {
    await rt.shutdown();
  }
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
const skip = !browserType && "needs Playwright Chromium";

test(
  "in the panel: the toast offers Undo and the screen follows; after another change Undo says why it is refused",
  { skip, timeout: 90_000 },
  async () => {
    const { seed, rt, core } = setup();
    const cfg = path.join(seed.root, "ux11-config.json");
    fs.writeFileSync(cfg, "{}");
    process.env.DEMO_REC_CONFIG = cfg;
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const page = await (
      await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const dlg = answerDialogs(page);
    try {
      const before = core();
      await page.goto(`${panel.url}#/voice/v2`);
      await page.waitForSelector("[data-intent=approve-only]");
      await page.click("[data-intent=approve-only]");
      const undo = page.locator(".ds-toast [data-act=toast-action]");
      await undo.waitFor();
      assert.equal(await undo.innerText(), "Undo");
      await page.waitForFunction(
        "/Approved/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
      );
      assert.notEqual(core(), before);
      // hovering keeps the toast: it is not taken away from under the pointer
      await undo.hover();
      await undo.click();
      await page.waitForSelector(".ds-toast:has-text('Undone')");
      assert.equal(core(), before, "the project is exactly as it was");
      await page.waitForFunction(
        "!/Approved/.test(document.querySelector('.stage-summary')?.innerText ?? '') || /Not approved|Draft version/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
      );
      assert.equal(
        await page.locator("[data-intent=approve-only]").count(),
        1,
        "the screen shows it as not approved",
      );
      // approve again, then change something else, then Undo: refused with the reason, nothing written
      await page.click("[data-intent=approve-only]");
      await page.locator(".ds-toast [data-act=toast-action]").last().waitFor();
      const [last] = await page.locator(".ds-toast [data-act=toast-action]").all();
      // another action by someone else (the Director, another tab)
      const t = rt.routeTables();
      const plan = (await (t.post["version-plan"] as (b: unknown) => unknown)({
        stage: "storyboard",
        version: 2,
        intent: "approve-only",
      })) as Reply;
      await (t.post["version-act"] as (b: unknown) => unknown)({
        stage: "storyboard",
        version: 2,
        intent: "approve-only",
        token: plan.token,
      });
      const mid = core();
      await (last as NonNullable<typeof last>).click();
      await page.waitForSelector(".ds-toast:has-text('no longer safe')");
      assert.equal(core(), mid, "a refused Undo writes nothing");
      assert.deepEqual(errors, []);
    } finally {
      dlg.stop();
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
