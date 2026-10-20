/**
 * Item 11a (P4, A4; D140 to D143): the Director asks a question and STOPS; the engine stores it, the user answers it once from the panel,
 * and the Director is woken with the answer. Nothing blocks, nothing approves.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { bandHiddenAt, nextBand, suggestions } from "../src/panel/public/frame-state.js";
import {
  LIMITS,
  answerQuestion,
  answeredMessage,
  askQuestion,
  cancelQuestion,
  dismissedMessage,
  pendingQuestions,
  pickOption,
  questionsContext,
  readQuestions,
  wordOf,
} from "../src/questions.ts";
import { Runtime } from "../src/runtime.ts";
import { registerAskTool } from "../src/tools/ask.ts";
import { projectContext } from "../src/workdir/context.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const options = [{ label: "Compare first, then the chat" }, { label: "Chat first, then compare" }];
const ask = (dir: string, patch: Record<string, unknown> = {}) =>
  askQuestion(dir, { what: "Which story do we tell first?", options, ...patch });

test("the word of an option: its first word, lower case; numbers and symbols are not words", () => {
  assert.equal(wordOf("Approve it as it is"), "approve");
  assert.equal(wordOf("  “Compare” first"), "compare");
  assert.equal(wordOf("don't change"), "don't");
  assert.equal(wordOf("— nothing"), "nothing");
  assert.equal(wordOf("???"), "");
  assert.equal(wordOf(""), "");
});

test("asking: numbered options with a word each, ids that do not repeat, one persistent store", () => {
  const { dir } = seedPanelProject();
  const q = ask(dir, { why: "It decides the order of the scenes", role: "Storyboard writer" });
  assert.deepEqual(
    [q.id, q.role, q.status, q.why],
    ["q-1", "Storyboard writer", "pending", "It decides the order of the scenes"],
  );
  assert.deepEqual(
    q.options.map((o) => [o.key, o.word, o.label]),
    [
      ["1", "compare", "Compare first, then the chat"],
      ["2", "chat", "Chat first, then compare"],
    ],
  );
  assert.equal(ask(dir, { what: "A second question?" }).id, "q-2");
  assert.deepEqual(
    readQuestions(dir).map((x) => x.id),
    ["q-1", "q-2"],
  );
  assert.deepEqual(
    pendingQuestions(dir).map((x) => x.id),
    ["q-1", "q-2"],
  );
  assert.equal(
    ask(dir, { what: "Third?", role: undefined }).role,
    "Director",
    "the Director by default",
  );
});

test("every rule refuses with the reason, all at once", () => {
  const { dir } = seedPanelProject();
  const msg = (patch: Record<string, unknown>) => {
    try {
      ask(dir, patch);
      return "";
    } catch (e) {
      return String((e as Error).message);
    }
  };
  assert.match(msg({ what: "" }), /question not asked, fix these:\n- what is required/);
  assert.match(msg({ what: "x".repeat(301) }), /what is 301 characters/);
  assert.match(msg({ why: "y".repeat(301) }), /why is 301 characters/);
  assert.match(msg({ role: "Cutter" }), /role must be one of: Director, Researcher/);
  assert.match(msg({ options: [{ label: "only one" }] }), /give 2 to 4 options \(you gave 1\)/);
  assert.match(
    msg({ options: Array.from({ length: 5 }, (_, i) => ({ label: `option${i}` })) }),
    /give 2 to 4 options \(you gave 5\)/,
  );
  assert.match(msg({ options: [{ label: "" }, { label: "fine" }] }), /option 1 has no label/);
  assert.match(
    msg({ options: [{ label: "a".repeat(61) }, { label: "fine" }] }),
    /option 1 is 61 characters/,
  );
  assert.match(
    msg({ options: [{ label: "???" }, { label: "fine" }] }),
    /option 1 \("\?\?\?"\) needs a word to start with/,
  );
  assert.match(
    msg({ options: [{ label: "Keep both" }, { label: "Keep the new one" }] }),
    /option 2 starts with "keep", like option 1: start each option with a different word, because the user may type it/,
  );
  assert.match(
    msg({ options: [{ label: "2 scenes" }, { label: "Three scenes" }] }),
    /option 1 starts with a number \("2"\)/,
  );
  assert.ok(
    msg({ what: "", options: [] }).split("\n").length >= 3,
    "an empty question lists every missing part",
  );
  assert.deepEqual(readQuestions(dir), [], "a refused question stores nothing");
  // no spam: a question that is already waiting, and too many waiting at once
  ask(dir);
  assert.match(msg({}), /that question is already waiting for the user: do not ask it twice/);
  ask(dir, { what: "Another?" });
  ask(dir, { what: "And another?" });
  assert.match(
    msg({ what: "One too many?" }),
    /3 questions are still waiting for the user \(q-1, q-2, q-3\): wait for them/,
  );
});

test("a reply names an option by its number or its word, exactly (case and a closing full stop aside); nothing else is an answer", () => {
  const { dir } = seedPanelProject();
  const q = ask(dir);
  for (const ok of ["1", " 1 ", "compare", "Compare", "COMPARE.", "compare!"])
    assert.equal(pickOption(q, ok)?.key, "1", ok);
  for (const ok of ["2", "chat"]) assert.equal(pickOption(q, ok)?.key, "2", ok);
  for (const no of [
    "",
    "3",
    "0",
    "yes",
    "ok",
    "compare first",
    "hmm, what does that cost?",
    "1 or 2",
    "comp",
  ])
    assert.equal(pickOption(q, no), undefined, no);
});

test("answering resolves it exactly once, from either place; the second answer is told who got there first; an unknown id or option is refused", () => {
  const { dir } = seedPanelProject();
  const q = ask(dir);
  assert.deepEqual(answerQuestion(dir, "q-9", "1", "panel"), { ok: false, reason: "unknown" });
  const bad = answerQuestion(dir, q.id, "yes", "panel");
  assert.deepEqual([bad.ok, !bad.ok && bad.reason], [false, "no-such-option"]);
  assert.equal(pendingQuestions(dir).length, 1, "a wrong reply did not resolve it");
  const first = answerQuestion(dir, q.id, "chat", "panel", new Date("2026-10-20T10:00:00Z"));
  assert.ok(first.ok);
  assert.deepEqual(first.ok && first.question.answer, {
    key: "2",
    word: "chat",
    label: "Chat first, then compare",
    by: "panel",
    at: "2026-10-20T10:00:00.000Z",
  });
  const second = answerQuestion(dir, q.id, "1", "chat");
  assert.deepEqual(
    [second.ok, !second.ok && second.reason, !second.ok && second.question?.answer?.key],
    [false, "already", "2"],
    "the first answer stands",
  );
  assert.deepEqual(pendingQuestions(dir), []);
  // a dismissed question cannot be answered either
  const q2 = ask(dir, { what: "Dismiss me?" });
  assert.equal(cancelQuestion(dir, q2.id, "you dismissed it").cancelled?.why, "you dismissed it");
  assert.deepEqual(
    [answerQuestion(dir, q2.id, "1", "chat").ok, readQuestions(dir).at(-1)?.status],
    [false, "cancelled"],
  );
  assert.throws(() => cancelQuestion(dir, q2.id, "again"), /already cancelled/);
  assert.throws(() => cancelQuestion(dir, "q-9", "x"), /no question q-9/);
});

test("what the Director is told: the answer with the question and the place, or the dismissal; and the context a fresh Director reads", () => {
  const { dir } = seedPanelProject();
  const q = ask(dir);
  const done = answerQuestion(dir, q.id, "2", "chat");
  assert.ok(done.ok);
  assert.equal(
    answeredMessage("[demo-panel]", (done as { question: ReturnType<typeof ask> }).question),
    '[demo-panel] The user answered your question q-1 ("Which story do we tell first?") with 2 · Chat first, then compare (in the chat). Go on with that. Do not ask it again.',
  );
  const q2 = ask(dir, {
    what: "Keep the long intro?",
    options: [{ label: "Keep it" }, { label: "Drop it" }],
  });
  const gone = cancelQuestion(dir, q2.id, "you dismissed it");
  assert.match(
    dismissedMessage("[demo-panel]", gone),
    /dismissed your question q-2 \("Keep the long intro\?"\) without choosing \(you dismissed it\)\. Do not ask it again unless they bring it back/,
  );
  ask(dir, { what: "What is the focus?", options: [{ label: "Search" }, { label: "Checkout" }] });
  const ctx = projectContext(dir, "keycraft");
  assert.match(ctx, /## Questions to the user \(1 waiting\)/);
  assert.match(ctx, /- q-3 WAITING \[Director\] What is the focus\? — 1 Search · 2 Checkout/);
  assert.match(
    ctx,
    /- q-1 answered 2 · Chat first, then compare \(chat\): Which story do we tell first\?/,
  );
  assert.match(ctx, /- q-2 dismissed \(you dismissed it\): Keep the long intro\?/);
  assert.deepEqual(questionsContext(fs.mkdtempSync(path.join(path.dirname(dir), "empty-"))), []);
});

test("the tool: asks and returns at once; refuses a bad question with the reasons; lists what is pending; it cannot answer", async () => {
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
  try {
    const tools = new Map<
      string,
      {
        parameters: unknown;
        execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }>;
      }
    >();
    registerAskTool(
      { registerTool: (t: { name: string }) => tools.set(t.name, t as never) } as never,
      rt,
    );
    const tool = tools.get("demo_rec_ask");
    assert.ok(tool);
    const run = async (params: Record<string, unknown>) =>
      (await tool.execute("id", params, undefined, undefined, undefined)).content
        .map((c) => c.text ?? "")
        .join("\n");
    const events: string[] = [];
    rt.bus.subscribe((e: { type: string }) => events.push(e.type));
    assert.match(await run({ action: "pending" }), /You have asked nothing yet/);
    await assert.rejects(
      () =>
        run({
          action: "ask",
          question: "Which?",
          options: [{ label: "Keep a" }, { label: "Keep b" }],
        }),
      /question not asked[\s\S]*start each option with a different word/,
    );
    assert.deepEqual(readQuestions(seed.dir), []);
    const reply = await run({
      action: "ask",
      question: "Which angle?",
      why: "it decides the scenes",
      options,
      role: "Researcher",
    });
    assert.match(
      reply,
      /Asked q-1: "Which angle\?" \(1 Compare first, then the chat · 2 Chat first, then compare\)\. The user answers in the panel; the answer arrives as a message\. STOP now/,
    );
    assert.ok(events.includes("question.asked"));
    assert.equal(readQuestions(seed.dir)[0]?.role, "Researcher");
    assert.match(await run({ action: "pending" }), /^q-1 PENDING: Which angle\?$/);
    // the user answers (the engine function the route calls); the tool shows it
    answerQuestion(seed.dir, "q-1", "1", "panel");
    assert.match(
      await run({ action: "pending" }),
      /^q-1 ANSWERED → 1 · Compare first, then the chat: Which angle\?$/,
    );
    // the tool has no way to answer or approve
    assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties).sort(), [
      "action",
      "options",
      "question",
      "role",
      "why",
    ]);
    assert.doesNotMatch(JSON.stringify(tool.parameters), /approve|answer"|accept/i);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the routes: list, answer once (the Director is woken with the answer), a second answer and a wrong option are refused, dismiss is a quiet note", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  const woke: string[] = [];
  const quiet: string[] = [];
  const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
  r.notifyAgent = (t) => woke.push(t);
  r.tellAgent = (t) => quiet.push(t);
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}/api`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async () =>
    (await (await fetch(`${base}/questions`, { headers: auth })).json()) as {
      pending: { id: string }[];
      recent: { id: string; status: string }[];
    };
  const post = async (n: string, body: unknown) => {
    const res = await fetch(`${base}/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    assert.deepEqual(await get(), { pending: [], recent: [] });
    ask(seed.dir);
    ask(seed.dir, {
      what: "Keep the intro?",
      options: [{ label: "Keep it" }, { label: "Drop it" }],
    });
    assert.deepEqual(
      (await get()).pending.map((q) => q.id),
      ["q-1", "q-2"],
    );
    const bad = await post("question-answer", { id: "q-1", option: "maybe" });
    assert.equal(bad.status, 400);
    assert.match(
      String(bad.json.error),
      /q-1 has no option "maybe": choose 1 \(compare\), 2 \(chat\)/,
    );
    assert.equal(woke.length, 0, "a wrong reply wakes nobody");
    const ok = await post("question-answer", { id: "q-1", option: "compare" });
    assert.equal(ok.status, 200);
    assert.equal(woke.length, 1);
    assert.match(
      woke[0] ?? "",
      /The user answered your question q-1 \("Which story do we tell first\?"\) with 1 · Compare first, then the chat \(in the panel\)/,
    );
    const again = await post("question-answer", { id: "q-1", option: "2" });
    assert.equal(again.status, 400);
    assert.match(
      String(again.json.error),
      /q-1 was already answered with 1 · Compare first, then the chat in the panel/,
    );
    assert.equal(woke.length, 1, "a second answer wakes nobody");
    assert.match(
      String((await post("question-answer", { id: "q-9", option: "1" })).json.error),
      /there is no question q-9/,
    );
    // dismiss: a quiet note, no turn
    const gone = await post("question-cancel", { id: "q-2" });
    assert.equal(gone.status, 200);
    assert.deepEqual([woke.length, quiet.length], [1, 1]);
    assert.match(quiet[0] ?? "", /dismissed your question q-2/);
    const s = await get();
    assert.deepEqual(
      [s.pending, s.recent.map((q) => [q.id, q.status])],
      [
        [],
        [
          ["q-1", "answered"],
          ["q-2", "cancelled"],
        ],
      ],
    );
    assert.match(
      String((await post("question-answer", { id: "q-2", option: "1" })).json.error),
      /q-2 was dismissed \(you dismissed it\)/,
    );
    assert.equal(LIMITS.pending, 3);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the band: a pending question outranks what else needs you and the Director working, but not a block; it lists what else waits and is never hidden", () => {
  const stages = {
    project: {},
    next: { who: "user", stage: "storyboard", text: "review storyboard v2" },
  } as never;
  const needs = {
    storyboard: { state: "needs", why: "Storyboard v2 is waiting for review" },
    vo: { state: "complete" },
  } as never;
  const q = [
    { id: "q-1", role: "Researcher", what: "Which angle?" },
    { id: "q-2", role: "Director", what: "Keep it?" },
  ];
  const band = nextBand({ stages, states: needs, jobs: [], director: undefined, questions: q });
  assert.deepEqual(
    [band?.tone, band?.label, band?.text, band?.action, band?.question],
    ["needs", "The Director asks", "Researcher: Which angle? (+1 more question)", null, true],
  );
  assert.deepEqual(
    band?.more,
    [{ tab: "storyboard", text: "Storyboard v2 is waiting for review" }],
    "what else waits is still reachable",
  );
  assert.equal(bandHiddenAt(band, "storyboard"), false, "never hidden: it has no page to be on");
  assert.equal(
    nextBand({ stages, states: needs, jobs: [], questions: q.slice(0, 1) })?.text,
    "Researcher: Which angle?",
  );
  // the Director working: the question still comes first (it waits for exactly this)
  const working = nextBand({
    stages,
    states: needs,
    jobs: [],
    director: { working: true, task: "writing", step: { tool: "t", label: "x" } },
    questions: q,
  });
  assert.equal(working?.label, "The Director asks");
  // a block outranks it; nothing pending leaves the band as it was
  const blocked = nextBand({
    stages,
    states: { storyboard: { state: "blocked", why: "cannot record" } } as never,
    jobs: [],
    questions: q,
  });
  assert.equal(blocked?.tone, "blocked");
  assert.equal(nextBand({ stages, states: needs, jobs: [], questions: [] })?.label, "Needs you");
  // the header's Suggestions: the question first, then what else waits
  assert.deepEqual(
    suggestions(band, "voice").map((x) => [x.tab, x.first ?? false, x.here]),
    [
      ["voice", true, true],
      ["storyboard", false, false],
    ],
  );
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
  "in the browser: the question is in the bar and the band, an option answers it once and wakes the Director, an answer from elsewhere clears it, a stale click says who got there first, dismiss is quiet",
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
    const woke: string[] = [];
    const quiet: string[] = [];
    const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
    r.notifyAgent = (t) => woke.push(t);
    r.tellAgent = (t) => quiet.push(t);
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const asked = (q: ReturnType<typeof ask>) =>
      rt.bus.publish(
        "question.asked",
        { id: q.id, role: q.role, by: "agent", message: `${q.role} asks: ${q.what}` },
        seed.slug,
      );
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const dlg = answerDialogs(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".ds-next");
      assert.equal(await page.locator("[data-question]").count(), 0, "nothing is asked");
      const q1 = ask(seed.dir, {
        why: "It decides the order of the scenes",
        role: "Storyboard writer",
      });
      asked(q1);
      await page.waitForSelector("[data-question=q-1]");
      const bar = await page.locator("[data-question=q-1]").innerText();
      assert.match(bar, /Storyboard writer/);
      assert.match(bar, /Which story do we tell first\?/);
      assert.match(bar, /It decides the order of the scenes/);
      assert.match(bar, /1\s+Compare first, then the chat[\s\S]*2\s+Chat first, then compare/);
      assert.match(
        bar,
        /In the chat type\s+1\s+\(\s*compare\s*\)\s+or\s+2\s+\(\s*chat\s*\);\s+anything else is normal chat/,
      );
      assert.equal(await page.locator("[data-question=q-1] [data-act=answer-question]").count(), 2);
      // the band says it too, and so does the header's Suggestions
      assert.match(
        await page.locator(".ds-next").innerText(),
        /THE DIRECTOR ASKS[\s\S]*Storyboard writer: Which story do we tell first\?/i,
      );
      await page.click(".ds-suggest > summary");
      assert.match(
        await page.locator(".ds-suggest ul").innerText(),
        /Storyboard writer: Which story do we tell first\?/,
      );
      await page.keyboard.press("Escape");
      // answer with option 2: the Director is woken once, the bar and the band clear
      await page.click("[data-question=q-1] [data-option='2']");
      await page.waitForSelector("[data-question]", { state: "detached" });
      assert.equal(woke.length, 1);
      assert.match(
        woke[0] ?? "",
        /answered your question q-1 \("Which story do we tell first\?"\) with 2 · Chat first, then compare \(in the panel\)/,
      );
      assert.equal(readQuestions(seed.dir)[0]?.status, "answered");
      assert.doesNotMatch(await page.locator(".ds-next").innerText(), /The Director asks/i);
      // answered somewhere else (the chat, from 11b): the engine event clears it here
      const q2 = ask(seed.dir, {
        what: "Keep the long intro?",
        options: [{ label: "Keep it" }, { label: "Drop it" }],
      });
      asked(q2);
      await page.waitForSelector("[data-question=q-2]");
      const elsewhere = answerQuestion(seed.dir, "q-2", "drop", "chat");
      assert.ok(elsewhere.ok);
      rt.bus.publish(
        "question.answered",
        { id: "q-2", option: "2", by: "chat", message: "answered q-2" },
        seed.slug,
      );
      await page.waitForSelector("[data-question]", { state: "detached" });
      // a stale click (the page has not heard yet): it says who got there first, and the first answer stands
      const q3 = ask(seed.dir, {
        what: "Which voice?",
        options: [{ label: "Warm" }, { label: "Neutral" }],
      });
      asked(q3);
      await page.waitForSelector("[data-question=q-3]");
      answerQuestion(seed.dir, "q-3", "1", "chat");
      await page.click("[data-question=q-3] [data-option='2']");
      await page.waitForSelector(".ds-toast[role=alert]");
      assert.match(
        await page.locator(".ds-toast[role=alert]").first().innerText(),
        /q-3 was already answered with 1 · Warm in the chat/,
      );
      assert.equal(woke.length, 1, "the stale click woke nobody");
      assert.equal(readQuestions(seed.dir).find((x) => x.id === "q-3")?.answer?.key, "1");
      rt.bus.publish(
        "question.answered",
        { id: "q-3", option: "1", by: "chat", message: "answered q-3" },
        seed.slug,
      );
      await page.waitForSelector("[data-question]", { state: "detached" });
      // dismiss: no turn, a quiet note
      const q4 = ask(seed.dir, {
        what: "Add a bonus scene?",
        options: [{ label: "Add it" }, { label: "Skip it" }],
      });
      asked(q4);
      await page.waitForSelector("[data-question=q-4]");
      await page.click("[data-question=q-4] [data-act=dismiss-question]");
      await page.waitForSelector("[data-question]", { state: "detached" });
      assert.deepEqual([woke.length, quiet.length], [1, 1]);
      assert.match(quiet[0] ?? "", /dismissed your question q-4/);
      dlg.stop();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
