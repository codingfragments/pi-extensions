/**
 * The autoheal (item 18, part 2, R3-14): a bounded repair run only the user starts. A request of mode `heal` with the fixed budget, a read-only session, a message that
 * limits the Director to one output (a new draft storyboard), the question's third answer and the card's button.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { requestHeal } from "../src/discovery/heal.ts";
import { HEAL_BUDGET, pendingRequest, readRequests } from "../src/discovery/requests.ts";
import { BlockedActionError, DiscoverySession } from "../src/discovery/session.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { answerFor } from "../src/question-flow.ts";
import { pendingQuestions, readQuestions } from "../src/questions.ts";
import { Runtime } from "../src/runtime.ts";
import { takeEnded } from "../src/tools/record.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { ensureApp } from "../src/workdir/layout.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

async function chromiumOk() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const chromium = await chromiumOk();

function failedTake(dir: string, id: string) {
  const t = path.join(dir, "takes", id);
  fs.mkdirSync(path.join(t, "diagnostics", "stalled-1"), { recursive: true });
  fs.writeFileSync(
    path.join(t, "take.json"),
    JSON.stringify({
      take: id,
      storyboardVersion: 1,
      status: "failed",
      error: "boom",
      failure: {
        kind: "retries",
        scene: "01-dash",
        step: 0,
        attempts: 3,
        stalls: 0,
        message: "scene 01-dash, step 0 (hover): nothing there",
      },
      diagnostics: ["diagnostics/stalled-1"],
    }),
  );
  fs.writeFileSync(
    path.join(t, "diagnostics", "stalled-1", "README.txt"),
    "STALLED\nVerdict: the target is gone\n",
  );
}

function setup() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const told: string[] = [];
  const turns: string[] = [];
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }), root: seed.root, panelPort: 0 }),
    { sendUserMessage: (t: string) => turns.push(t), sendMessage: () => {} } as never,
  );
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => told.push(t);
  rt.setActiveProject(seed.slug);
  return { rt, seed, told, turns };
}

test("the heal budget is fixed: 10 screens, 15 actions, 6 minutes", () => {
  assert.deepEqual(HEAL_BUDGET, {
    discoveryScreens: 10,
    discoveryActions: 15,
    discoveryMinutes: 6,
  });
});

test("a repair request: stored as mode heal with the fixed budget, recorded, the Director told what to do and what not; the question is answered; a good take is refused", async () => {
  const { rt, seed, told } = setup();
  try {
    failedTake(seed.dir, "take-080");
    takeEnded(rt, rt.requireProject(), 1, "failed", "boom");
    const q = pendingQuestions(seed.dir)[0];
    assert.deepEqual(
      q?.options.map((o) => o.word),
      ["add", "heal", "leave"],
    );
    assert.throws(() => requestHeal(rt, { take: "take-001" }), /take-001 did not fail/);
    assert.equal(readRequests(seed.dir).length, 0);

    const req = requestHeal(rt, {
      take: "take-080",
      text: "scene facts.\n\nWhat I would change: ",
    });
    assert.equal(req.mode, "heal");
    assert.deepEqual(req.budget, HEAL_BUDGET);
    assert.deepEqual(req.heal, { take: "take-080", scene: "01-dash", storyboardVersion: 1 });
    assert.equal(req.notes, "scene facts.", "an empty 'What I would change:' is not a note");
    assert.equal(pendingRequest(seed.dir)?.id, req.id);
    assert.ok(readInputs(seed.dir).some((e) => /autoheal the failed take-080/.test(e.text)));
    assert.equal(
      pendingQuestions(seed.dir).length,
      0,
      "asking for the repair answers the question",
    );
    assert.equal(readQuestions(seed.dir).find((x) => x.id === q?.id)?.answer?.word, "heal");

    const msg = told.at(-1) ?? "";
    assert.match(msg, /REPAIR the failed take-080 of storyboard v1/);
    assert.match(msg, /10 screens, 15 actions, 6 minutes, and it is READ-ONLY/);
    assert.match(msg, /Diagnosis: the target is gone/);
    assert.match(msg, /The scene as written \(v1\): \{"id":"01-dash"/);
    assert.match(msg, /NEW DRAFT of the storyboard/);
    assert.match(
      msg,
      /You must NOT: record a take, approve anything, edit the brief, start another discovery, spend/,
    );
    assert.match(msg, /Their notes: scene facts\./);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the question's answer 'heal' starts the repair; 'add' and 'leave' do not", async () => {
  const { rt, seed, told } = setup();
  try {
    failedTake(seed.dir, "take-081");
    takeEnded(rt, rt.requireProject(), 1, "failed", "boom");
    const q = pendingQuestions(seed.dir)[0];
    answerFor(rt, q?.id as string, "leave", "panel");
    assert.equal(readRequests(seed.dir).length, 0);
    assert.deepEqual(told, []);
    failedTake(seed.dir, "take-082");
    takeEnded(rt, rt.requireProject(), 1, "failed", "boom");
    const q2 = pendingQuestions(seed.dir)[0];
    answerFor(rt, q2?.id as string, "heal", "chat");
    const [req] = readRequests(seed.dir);
    assert.equal(req?.mode, "heal");
    assert.equal(req?.heal?.take, "take-082");
    assert.match(told.at(-1) ?? "", /REPAIR the failed take-082/);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("a running discovery session refuses a repair; the route and the cost class exist", async () => {
  const { rt, seed } = setup();
  try {
    failedTake(seed.dir, "take-083");
    (rt as unknown as { discovery: unknown }).discovery = { isClosed: false };
    assert.throws(() => requestHeal(rt, { take: "take-083" }), /a discovery session is running/);
    (rt as unknown as { discovery: unknown }).discovery = undefined;
    const panel = await rt.ensurePanel();
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/take-heal`, {
      method: "POST",
      headers: { authorization: `Bearer ${panel.token}`, "content-type": "application/json" },
      body: JSON.stringify({ take: "take-083", text: "" }),
    });
    const j = (await res.json()) as { request?: { mode: string } };
    assert.equal(res.status, 200);
    assert.equal(j.request?.mode, "heal");
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

let fixture: FixtureHandle;
let root: string;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autoheal-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  "a read-only session looks and navigates but a state change is BLOCKED, not only audited",
  { skip: !chromium && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    const app = ensureApp(root, "Heal App", fixture.url);
    const open = (readOnly: boolean) =>
      DiscoverySession.open({
        root,
        app,
        viewport: { width: 1280, height: 800 },
        budgets: HEAL_BUDGET,
        ...(readOnly ? { readOnly: true } : {}),
      });
    const chat = (d: DiscoverySession) =>
      d.act({ action: "click", target: { role: "link", name: "Assistant" } }).then(() =>
        d.act({
          action: "type",
          target: { role: "textbox", name: "Ask a question" },
          text: "hello",
          submit: true,
        }),
      );
    const ro = await open(true);
    try {
      await ro.look();
      const nav = await ro.act({ action: "click", target: { role: "link", name: "Search" } });
      assert.equal(nav.verdict.level, "safe");
      await assert.rejects(
        chat(ro),
        (e: unknown) => e instanceof BlockedActionError && /read-only repair look/.test(String(e)),
      );
    } finally {
      await ro.close();
    }
    const rw = await open(false);
    try {
      const sent = await chat(rw);
      assert.equal(
        sent.verdict.level,
        "mutating",
        "the same action is only audited in a normal session",
      );
    } finally {
      await rw.close();
    }
  },
);

test(
  "the card: Heal it asks the Director for a repair (a request, a turn) and says so",
  { skip: !chromium && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    const { rt, seed, told } = setup();
    failedTake(seed.dir, "take-070");
    const panel = await rt.ensurePanel();
    const browser = await (chromium as NonNullable<typeof chromium>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector("#take-70");
      await page.click("#take-70 [data-act=review-take]");
      await page.waitForSelector("[data-failed-take=take-070]");
      await page.click("[data-failed-take=take-070] [data-act=heal]");
      await page.waitForFunction(
        "document.body.innerText.includes('Asked the Director to look and repair')",
      );
      assert.equal(readRequests(seed.dir)[0]?.mode, "heal");
      assert.match(told.at(-1) ?? "", /REPAIR the failed take-070/);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
