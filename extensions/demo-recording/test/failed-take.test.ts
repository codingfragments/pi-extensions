/**
 * A take that fails does not start the Director (R3-14, item 18): the Director is told quietly, the user is asked what now, and the Recording tab has a card for a
 * recommendation on the failed scene, kept as a note for the next take or sent to the Director now. Real Chromium + ffmpeg for the runner part.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { answerFor } from "../src/question-flow.ts";
import { pendingQuestions, readQuestions } from "../src/questions.ts";
import {
  type TakeFailure,
  failureWords,
  readFailedTake,
  recommendationDraft,
} from "../src/recorder/failure.ts";
import { type RecordOptions, recordTake } from "../src/recorder/runner.ts";
import { readNotes } from "../src/recording/notes.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { takeEnded } from "../src/tools/record.ts";
import { readInputs } from "../src/workdir/inputs.ts";
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
const skipRun = (!chromium || !hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

const SB = `start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: hover, target: { css: '[data-kpi="arr"]' }, dwell: 200 }
  - id: 02-search
    title: Search
    deep_link: /
    steps:
      - { do: click, target: { role: link, name: Search } }
      - { do: click, target: { role: button, name: NoSuchButtonXYZ } }
`;

test("a failure in words: where, what, after how much", () => {
  const sb = parseStoryboard(SB, { version: 1 });
  const f = (o: Partial<TakeFailure>): TakeFailure => ({
    kind: "retries",
    stalls: 0,
    message: "x",
    ...o,
  });
  assert.equal(
    failureWords(
      f({
        scene: "02-search",
        step: 1,
        attempts: 3,
        message:
          'scene 02-search, step 1 (click): target not visible within 8000 ms: button "NoSuchButtonXYZ"',
      }),
      sb,
    ),
    'scene 02-search (Search), step 2 (click) failed after 3 attempts: target not visible within 8000 ms: button "NoSuchButtonXYZ"',
  );
  assert.equal(
    failureWords(
      f({
        kind: "stalls",
        scene: "02-search",
        step: 0,
        stalls: 4,
        message:
          "scene 02-search, step 1 (click) did not finish in 60 s: the browser is frozen (nothing answers)",
      }),
      sb,
    ),
    "the browser froze 4 times in scene 02-search (Search), step 1 (click), more than a take survives: the browser is frozen (nothing answers)",
  );
  assert.match(
    failureWords(f({ kind: "setup", message: "net::ERR_CONNECTION_REFUSED" })),
    /^the take could not start: net::ERR/,
  );
  assert.match(
    failureWords(f({ kind: "no-resume", scene: "02-search", message: "boom" }), sb),
    /cannot be shot again without repeating state changes/,
  );
});

function failedTake(dir: string, id: string, meta: Record<string, unknown>, readme?: string) {
  const t = path.join(dir, "takes", id);
  fs.mkdirSync(path.join(t, "diagnostics", "stalled-1"), { recursive: true });
  fs.writeFileSync(
    path.join(t, "take.json"),
    JSON.stringify({ take: id, storyboardVersion: 1, ...meta }),
  );
  if (readme) fs.writeFileSync(path.join(t, "diagnostics", "stalled-1", "README.txt"), readme);
}

test("a failed take is read from take.json: the failure, its words, the diagnosis verdict; an older one without data still reads; a good one is not a failure", () => {
  const seed = seedPanelProject();
  try {
    failedTake(
      seed.dir,
      "take-090",
      {
        status: "failed",
        error: "boom",
        failure: {
          kind: "retries",
          scene: "01-dash",
          step: 0,
          attempts: 3,
          stalls: 1,
          message: "scene 01-dash, step 0 (hover): nothing there",
        },
        diagnostics: ["diagnostics/stalled-1"],
      },
      "STALLED in take-090\nVerdict: the page answers but cannot be screenshotted: the compositor is stuck\n",
    );
    const f = readFailedTake(seed.dir, "take-090");
    assert.ok(f);
    assert.equal(f.failure.kind, "retries");
    assert.match(f.words, /^scene 01-dash, step 1 failed after 3 attempts: nothing there$/);
    assert.equal(
      f.verdict,
      "the page answers but cannot be screenshotted: the compositor is stuck",
    );
    assert.match(
      recommendationDraft(f),
      /The diagnosis says: the page answers but cannot be screenshotted[\s\S]*What I would change: $/,
    );
    failedTake(seed.dir, "take-091", { status: "failed", error: "an older failure\nwith detail" });
    const old = readFailedTake(seed.dir, "take-091");
    assert.equal(old?.failure.kind, "error");
    assert.match(old?.words ?? "", /an older failure/);
    failedTake(seed.dir, "take-092", { status: "ok" });
    assert.equal(readFailedTake(seed.dir, "take-092"), undefined);
    assert.equal(readFailedTake(seed.dir, "take-404"), undefined);
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

let fixture: FixtureHandle;
let root: string;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "failed-take-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});
let n = 0;
const run = (extra: Partial<RecordOptions>): RecordOptions => {
  const projectDir = path.join(root, `p${++n}`);
  fs.mkdirSync(projectDir);
  return {
    projectDir,
    storyboard: parseStoryboard(SB, { version: 1 }),
    storyboardVersion: 1,
    baseUrl: fixture.url,
    viewport: { width: 1280, height: 720, dpr: 1 },
    fps: 30,
    seed: 7,
    ...extra,
  };
};
const metaOf = (o: RecordOptions) =>
  JSON.parse(fs.readFileSync(path.join(o.projectDir, "takes", "take-001", "take.json"), "utf8"));

test(
  "the runner says why it gave up: a scene that ran out of retries",
  { skip: skipRun, timeout: 240_000 },
  async () => {
    const o = run({ maxRetriesPerScene: 0 });
    await assert.rejects(recordTake(o), /NoSuchButtonXYZ[\s\S]*\(after 1 attempt\)/);
    const m = metaOf(o);
    assert.equal(m.status, "failed");
    assert.deepEqual(
      {
        kind: m.failure.kind,
        scene: m.failure.scene,
        step: m.failure.step,
        attempts: m.failure.attempts,
        stalls: m.failure.stalls,
      },
      { kind: "retries", scene: "02-search", step: 1, attempts: 1, stalls: 0 },
    );
    assert.match(m.failure.message, /target not visible/);
  },
);

test(
  "a cancelled take has no failure (it is not a problem to decide on)",
  { skip: skipRun, timeout: 120_000 },
  async () => {
    const o = run({ stepDeadlineMinMs: 120_000 });
    o.storyboard = parseStoryboard(
      "start_url: /\nscenes:\n  - id: a\n    title: A\n    steps:\n      - { do: pause, ms: 60s }\n",
      { version: 1 },
    );
    const ac = new AbortController();
    o.signal = ac.signal;
    setTimeout(() => ac.abort(), 2500);
    await assert.rejects(recordTake(o), /cancelled/);
    const m = metaOf(o);
    assert.equal(m.status, "cancelled");
    assert.equal("failure" in m, false);
  },
);

function runtimeWithAgent() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const turns: string[] = [];
  const notes: { content: string; triggerTurn?: boolean }[] = [];
  const agent = {
    sendUserMessage: (t: string) => turns.push(t),
    sendMessage: (m: { content: string }, o: { triggerTurn?: boolean }) =>
      notes.push({
        content: m.content,
        ...(o.triggerTurn !== undefined ? { triggerTurn: o.triggerTurn } : {}),
      }),
  };
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }), root: seed.root, panelPort: 0 }),
    agent as never,
  );
  rt.setActiveProject(seed.slug);
  return { rt, seed, turns, notes };
}

test("a failed take: the Director is told quietly (no turn), the user is asked what now, once; a cancelled take only gets a note", async () => {
  const { rt, seed, turns, notes } = runtimeWithAgent();
  try {
    const p = rt.requireProject();
    failedTake(seed.dir, "take-050", {
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
    });
    takeEnded(rt, p, 1, "failed", "boom");
    assert.deepEqual(turns, [], "no turn was started");
    const note = notes.find((x) => x.content.includes("Recording failed (take-050)"));
    assert.equal(note?.triggerTurn, false);
    assert.match(
      note?.content ?? "",
      /Recording failed \(take-050\): scene 01-dash \(Dashboard\), step 1 \(hover\) failed after 3 attempts: nothing there\./,
    );
    assert.match(
      note?.content ?? "",
      /do NOT start a discovery or a new take, and do not edit the storyboard, until they ask you to/,
    );
    const [q, ...more] = pendingQuestions(seed.dir);
    assert.equal(more.length, 0);
    assert.equal(q?.role, "Operator");
    assert.equal(q?.takeFailed?.take, "take-050");
    assert.deepEqual(
      q?.options.map((o) => o.word),
      ["add", "leave"],
    );
    assert.match(q?.what ?? "", /^take-050 failed: scene 01-dash/);
    // the same failure does not ask twice
    takeEnded(rt, p, 1, "failed", "boom");
    assert.equal(pendingQuestions(seed.dir).length, 1);
    // answering: "add" points at the Recording tab and wakes nobody; "leave" does nothing
    const events: string[] = [];
    rt.bus.subscribe((e) => events.push(`${e.type}`));
    answerFor(rt, q?.id as string, "add", "panel");
    assert.ok(events.includes("take.recommend-asked"));
    assert.deepEqual(turns, [], "still no turn");
    const before = notes.length;
    // a cancelled take: a note, no question
    takeEnded(rt, p, 1, "cancelled", "recording cancelled");
    assert.equal(notes.length, before + 1);
    assert.match(
      notes.at(-1)?.content ?? "",
      /Recording cancelled: recording cancelled\. Nothing is started by itself/,
    );
    assert.equal(notes.at(-1)?.triggerTurn, false);
    assert.equal(pendingQuestions(seed.dir).length, 0);
    assert.equal(
      readQuestions(seed.dir).filter((x) => x.takeFailed).length,
      1,
      "no new question for a cancel",
    );
    assert.deepEqual(turns, []);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("a failed edit is told quietly too (structural: the failure branch of the edit job uses the quiet note)", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "tools", "edit.ts"),
    "utf8",
  );
  const at = src.indexOf("Edit ${j.status}");
  assert.ok(at > 0, "the failure message of the edit job is there");
  const branch = src.slice(
    src.lastIndexOf("// a failed edit is the user's to decide on", at),
    at + 200,
  );
  assert.match(branch, /rt\.tellAgent\(/);
  assert.doesNotMatch(branch, /reportToAgent\(/);
});

test("the routes: a recommendation is saved as a note (nobody woken) or sent (the Director proposes a fix draft, never records); it answers the question; bad input is refused", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const told: string[] = [];
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => told.push(t);
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const post = async (route: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${panel.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    failedTake(seed.dir, "take-060", {
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
    });
    takeEnded(rt, rt.requireProject(), 1, "failed", "boom");
    assert.equal(pendingQuestions(seed.dir).length, 1);
    // refused
    assert.match(
      String((await post("take-recommend-save", { take: "take-001", text: "x" })).json.error),
      /take-001 did not fail/,
    );
    assert.match(
      String((await post("take-recommend-save", { take: "take-060", text: "  " })).json.error),
      /write your recommendation first/,
    );
    // saved: a note on the failed scene, the question answered, nobody woken
    const saved = await post("take-recommend-save", {
      take: "take-060",
      text: "Use the search link in the sidebar instead.",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.sent, false);
    const notes = readNotes(seed.dir, "take-060");
    assert.deepEqual(
      notes.map((x) => [x.scene, x.text, x.sent]),
      [["01-dash", "Use the search link in the sidebar instead.", undefined]],
    );
    assert.equal(
      pendingQuestions(seed.dir).length,
      0,
      "the question is answered by the recommendation",
    );
    assert.deepEqual(told, []);
    // sent: carried now, in the project's history, and the Director is asked for a draft, not a take
    const sent = await post("take-recommend-send", {
      take: "take-060",
      text: "Wait for the list before hovering.",
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.sent, true);
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /RECOMMENDATION on the failed take-060 of storyboard v1/);
    assert.match(told[0] ?? "", /Their recommendation: "Wait for the list before hovering\."/);
    assert.match(told[0] ?? "", /Do NOT record a take and do NOT approve anything/);
    assert.match(readNotes(seed.dir, "take-060").at(-1)?.sent ? "sent" : "open", /sent/);
    assert.ok(
      readInputs(seed.dir).some(
        (e) => e.kind === "review" && /recommendation on the failed take-060/.test(e.text),
      ),
    );
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test(
  "the Recording tab: a failed take has a card with what failed, the diagnosis and a box for the recommendation, prefilled; Save and Send both work",
  { skip: !chromium && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const told: string[] = [];
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => told.push(t);
    rt.setActiveProject(seed.slug);
    failedTake(
      seed.dir,
      "take-070",
      {
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
      },
      "STALLED\nVerdict: nothing answers: the browser process itself is stuck\n",
    );
    const panel = await rt.ensurePanel();
    const browser = await (chromium as NonNullable<typeof chromium>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector("#take-70");
      await page.click("#take-70 [data-act=review-take]");
      await page.waitForSelector("[data-failed-take=take-070]");
      const card = page.locator("[data-failed-take=take-070]");
      assert.match(await card.innerText(), /take-070 did not finish/);
      assert.match(
        await card.locator("[data-failure-words]").innerText(),
        /scene 01-dash \(Dashboard\), step 1 \(hover\) failed after 3 attempts: nothing there\./,
      );
      assert.match(
        await card.locator("[data-verdict]").innerText(),
        /nothing answers: the browser process itself is stuck/,
      );
      const box = card.locator("[data-field=recommendation]");
      assert.match(await box.inputValue(), /What I would change: $/);
      await box.fill(`${await box.inputValue()}use the search link`);
      await card.locator("[data-act=recommend-save]").click();
      await page.waitForFunction(
        "document.body.innerText.includes('Saved: it goes with the next take you request.')",
      );
      assert.equal(readNotes(seed.dir, "take-070").length, 1);
      assert.match(
        readNotes(seed.dir, "take-070")[0]?.text ?? "",
        /use the search link$/,
        "what you typed is what was saved",
      );
      assert.deepEqual(told, [], "saving wakes nobody");
      await card.locator("[data-act=recommend-send]").click();
      await page.waitForFunction("document.body.innerText.includes('Sent to the Director')");
      assert.equal(told.length, 1);
      assert.match(told[0] ?? "", /use the search link/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
