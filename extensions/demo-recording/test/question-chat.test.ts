/**
 * Item 11b (P4, D141 to D143): a question in the chat, a typed reply that answers it, and the Allow for a spend as one of these questions.
 * The chat part runs in a REAL pi session with a scripted model (test/helpers/pi-session.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cmdAnswer } from "../src/commands/demo.ts";
import { resolveConfig } from "../src/config.ts";
import { registerDirectorWatch } from "../src/director/watch.ts";
import { registerQuestionChat } from "../src/question-chat.ts";
import { answerFor, askForGrant, settleGrantQuestion } from "../src/question-flow.ts";
import {
  answerQuestion,
  askQuestion,
  cancelAskedSince,
  matchReply,
  pendingQuestions,
  questionText,
  readQuestions,
} from "../src/questions.ts";
import { QUESTION_MESSAGE, Runtime } from "../src/runtime.ts";
import { askFirst } from "../src/tools/spend.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";
import { fauxAssistantMessage, fauxSession } from "./helpers/pi-session.ts";

// biome-ignore lint/suspicious/noExplicitAny: pi's extension API and messages, passed through as they are
type Api = any;
const options = [{ label: "Cut to three scenes" }, { label: "Keep all five" }];
const ask = (dir: string, what = "Which story?", opts = options, at = new Date()) =>
  askQuestion(dir, { what, options: opts }, at);
const textOf = (m: Api) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((c: Api) => c.text ?? "").join("");

function runtime(agent?: Api) {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }), root: seed.root, panelPort: 0 }),
    agent,
  );
  rt.setActiveProject(seed.slug);
  return {
    rt,
    seed,
    done: async () => {
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    },
  };
}

test("which question a reply answers: an exact number or word of exactly one waiting question; a fit with several is ambiguous; anything else nothing", () => {
  const { dir } = seedPanelProject();
  const a = ask(dir);
  assert.equal((matchReply([a], "2") as { option: { word: string } }).option.word, "keep");
  assert.equal((matchReply([a], "Cut") as { option: { key: string } }).option.key, "1");
  assert.equal(matchReply([a], "what does that cost?"), undefined);
  assert.equal(matchReply([], "1"), undefined);
  const b = ask(dir, "Which voice?", [{ label: "Warm one" }, { label: "Neutral one" }]);
  assert.equal(matchReply([a, b], "1"), "ambiguous", "both have a 1");
  const hit = matchReply([a, b], "warm") as { question: { id: string } };
  assert.equal(hit.question.id, b.id, "a word that only one has is unambiguous");
  assert.equal((matchReply([a, b], "cut") as { question: { id: string } }).question.id, a.id);
});

test("the chat message: who asks, what, why, the options with numbers, what to type", () => {
  const { dir } = seedPanelProject();
  const q = askQuestion(dir, {
    role: "Researcher",
    what: "Which story?",
    why: "It orders the scenes",
    options,
  });
  assert.equal(
    questionText(q),
    "Researcher asks (q-1): Which story?\nIt orders the scenes\n  1  Cut to three scenes\n  2  Keep all five\nType 1 (cut) or 2 (keep), or answer in the panel. It waits for you.",
  );
});

test("stopping the run cancels what that run asked and nobody answered; earlier questions and the Allow for a spend stay", () => {
  const { dir } = seedPanelProject();
  const old = ask(dir, "Asked before?", options, new Date("2026-10-20T10:00:00Z"));
  const later = ask(
    dir,
    "Asked in the run?",
    [{ label: "Yes please" }, { label: "No thanks" }],
    new Date("2026-10-20T10:05:00Z"),
  );
  const grant = askQuestion(dir, {
    what: "Allow the Director to record?",
    options: [{ label: "Allow" }, { label: "Deny" }],
    grant: { kind: "take", target: "storyboard:1", request: "abc", summary: "record" },
  });
  const gone = cancelAskedSince(
    dir,
    Date.parse("2026-10-20T10:02:00Z"),
    "you stopped the run that asked it",
    new Date(),
  );
  assert.deepEqual(
    gone.map((q) => q.id),
    [later.id],
    "only what the run asked",
  );
  assert.deepEqual(
    pendingQuestions(dir)
      .map((q) => q.id)
      .sort(),
    [old.id, grant.id].sort(),
  );
  assert.equal(
    readQuestions(dir).find((q) => q.id === later.id)?.cancelled?.why,
    "you stopped the run that asked it",
  );
});

test("an aborted run cancels its question (through the real watch); a run that ended normally keeps it, as the Director stops after asking", async () => {
  const { rt, seed, done } = runtime();
  const handlers = new Map<string, (e: Api) => Promise<void>>();
  registerDirectorWatch(
    { on: (n: string, f: (e: Api) => Promise<void>) => handlers.set(n, f) } as never,
    rt,
  );
  try {
    const run = async (settle: { aborted?: boolean }) => {
      await handlers.get("before_agent_start")?.({ prompt: "go" });
      const q = ask(seed.dir, `Asked ${Math.random()}?`);
      await handlers.get("agent_settled")?.(settle);
      return q;
    };
    const kept = await run({});
    assert.equal(
      readQuestions(seed.dir).find((q) => q.id === kept.id)?.status,
      "pending",
      "a normal end keeps it: the Director stopped after asking",
    );
    await new Promise((r) => setTimeout(r, 15)); // the clock has a millisecond
    const lost = await run({ aborted: true });
    assert.equal(readQuestions(seed.dir).find((q) => q.id === lost.id)?.status, "cancelled");
    assert.equal(
      readQuestions(seed.dir).find((q) => q.id === kept.id)?.status,
      "pending",
      "the earlier run's question is not touched",
    );
  } finally {
    await done();
  }
});

test("the Allow for a spend is a question: asked once, 'allow' or 'deny' answers it, the grant and the Director's message are the old ones", () => {
  const sent: string[] = [];
  const quiet: string[] = [];
  const { rt, seed, done } = runtime({
    sendUserMessage: (t: string) => sent.push(t),
    sendMessage: (m: Api) => quiet.push(m.content),
  });
  return (async () => {
    try {
      askFirst(rt, "tts", "vo:1", "synthesize voice-over v1 (about 1,231 characters)");
      askFirst(rt, "tts", "vo:1", "synthesize voice-over v1 (about 1,231 characters)");
      const qs = pendingQuestions(seed.dir);
      assert.equal(qs.length, 1, "asking again does not ask twice");
      assert.equal(
        qs[0]?.what,
        "Allow the Director to synthesize voice-over v1 (about 1,231 characters)?",
      );
      assert.deepEqual(
        qs[0]?.options.map((o) => o.word),
        ["allow", "deny"],
      );
      assert.equal(qs[0]?.grant?.kind, "tts");
      assert.match(
        quiet[0] ?? "",
        /Director asks \(q-1\): Allow the Director to synthesize voice-over v1/,
        "shown in the chat",
      );
      // the chat says allow
      const r = answerFor(rt, "q-1", "allow", "chat");
      assert.ok(r.ok);
      assert.equal(rt.grants.has("tts", seed.slug, "vo:1"), true, "the one-use grant");
      assert.equal(rt.grants.pending(seed.slug).length, 0, "the old request is closed too");
      assert.match(sent.at(-1) ?? "", /ALLOWED: synthesize voice-over v1/);
      // a second answer from the panel is told who got there first
      const again = answerFor(rt, "q-1", "deny", "panel");
      assert.deepEqual([again.ok, !again.ok && again.reason], [false, "already"]);
      assert.equal(rt.grants.has("tts", seed.slug, "vo:1"), true, "the first answer stands");
      // deny: a quiet note, no grant
      askFirst(rt, "take", "storyboard:1", "record a new take of storyboard v1");
      const n = sent.length;
      assert.ok(answerFor(rt, "q-2", "2", "chat").ok);
      assert.equal(rt.grants.has("take", seed.slug, "storyboard:1"), false);
      assert.equal(sent.length, n, "deny starts no turn");
      assert.match(quiet.at(-1) ?? "", /did NOT allow: record a new take of storyboard v1/);
      // a grant question that outlived a restart (the request is gone) is still answerable
      const q3 = askForGrant(rt, {
        id: "gone",
        kind: "take",
        target: "storyboard:9",
        summary: "record storyboard v9",
      });
      assert.ok(q3);
      assert.ok(answerFor(rt, q3.id, "allow", "panel").ok);
      assert.equal(rt.grants.has("take", seed.slug, "storyboard:9"), true);
      // the limit of three waiting questions does not apply to it
      ask(seed.dir, "One?", [{ label: "Aaa" }, { label: "Bbb" }]);
      ask(seed.dir, "Two?", [{ label: "Ccc" }, { label: "Ddd" }]);
      ask(seed.dir, "Three?", [{ label: "Eee" }, { label: "Fff" }]);
      askFirst(rt, "tts", "vo:7", "synthesize voice-over v7");
      assert.equal(pendingQuestions(seed.dir).length, 4);
    } finally {
      await done();
    }
  })();
});

test("the old ways to answer a spend request answer its question too: the panel's grant routes and /demo allow", async () => {
  const { rt, seed, done } = runtime({
    sendUserMessage: () => undefined,
    sendMessage: () => undefined,
  });
  try {
    askFirst(rt, "tts", "vo:1", "synthesize voice-over v1");
    askFirst(rt, "take", "storyboard:1", "record a take");
    const [a, b] = rt.grants.pending(seed.slug);
    assert.ok(a && b);
    settleGrantQuestion(rt, { request: a.id }, "allow", "chat");
    settleGrantQuestion(rt, { kind: "take", target: "storyboard:1" }, "deny", "panel");
    const all = readQuestions(seed.dir);
    assert.deepEqual(
      all.map((q) => [q.id, q.status, q.answer?.word, q.answer?.by]),
      [
        ["q-1", "answered", "allow", "chat"],
        ["q-2", "answered", "deny", "panel"],
      ],
    );
    settleGrantQuestion(rt, { request: "none" }, "allow", "chat"); // nothing waits: nothing happens
    assert.equal(readQuestions(seed.dir).length, 2);
    // and through the real routes
    const panel = await rt.ensurePanel();
    const auth = { authorization: `Bearer ${panel.token}`, "content-type": "application/json" };
    askFirst(rt, "tts", "vo:2", "synthesize voice-over v2");
    const req = rt.grants.pending(seed.slug).find((r) => r.target === "vo:2");
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/grant`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ request: req?.id }),
    });
    assert.equal(res.status, 200);
    assert.equal(readQuestions(seed.dir).at(-1)?.answer?.word, "allow");
    askFirst(rt, "take", "storyboard:2", "record a take of v2");
    const req2 = rt.grants.pending(seed.slug).find((r) => r.target === "storyboard:2");
    await fetch(`http://127.0.0.1:${panel.port}/api/grant-deny`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ request: req2?.id }),
    });
    assert.equal(readQuestions(seed.dir).at(-1)?.answer?.word, "deny");
    // /demo allow in the chat
    askFirst(rt, "tts", "vo:3", "synthesize voice-over v3");
    const req3 = rt.grants.pending(seed.slug).find((r) => r.target === "vo:3");
    const notes: string[] = [];
    cmdAnswer(rt, "allow", [req3?.id ?? ""], {
      ui: { notify: (t: string) => notes.push(t) },
    } as never);
    assert.equal(readQuestions(seed.dir).at(-1)?.answer?.word, "allow");
    assert.equal(readQuestions(seed.dir).at(-1)?.answer?.by, "chat");
    assert.equal(pendingQuestions(seed.dir).length, 0, "nothing keeps asking");
  } finally {
    await done();
  }
});

test(
  "in a real pi session: a reply that is exactly an option answers the question and is swallowed; every other reply is normal chat",
  { timeout: 60_000 },
  async () => {
    let rt!: Runtime;
    let seed!: ReturnType<typeof seedPanelProject>;
    let cleanup!: () => Promise<void>;
    let piApi!: Api;
    const ext = (pi: Api) => {
      piApi = pi;
      const r = runtime(pi);
      rt = r.rt;
      seed = r.seed;
      cleanup = r.done;
      registerQuestionChat(pi, rt);
    };
    const s = await fauxSession({ extensions: [ext] });
    try {
      const seen: string[][] = [];
      const reply = (text: string) => (ctx: Api) => {
        seen.push(ctx.messages.map((m: Api) => `${m.role}:${textOf(m)}`));
        return fauxAssistantMessage(text);
      };
      // the question appears in the chat as a custom message of its own, and starts no turn
      const q = ask(seed.dir);
      rt.publishQuestion(q);
      const shown = s.session.messages.find((m: Api) => m.customType === QUESTION_MESSAGE);
      assert.match(
        textOf(shown),
        /Director asks \(q-1\): Which story\?[\s\S]*1 {2}Cut to three scenes[\s\S]*Type 1 \(cut\) or 2 \(keep\)/,
      );
      assert.equal(
        s.seen.filter((x) => x.ev === "agent_start").length,
        0,
        "showing a question starts no turn",
      );

      // a reply that is not an option: normal chat, the question still waits
      s.faux.setResponses([reply("It would cost about two credits.")]);
      await s.session.prompt("hmm, what does that cost?");
      await s.settled(1);
      assert.equal(pendingQuestions(seed.dir).length, 1);
      assert.ok(
        s.session.messages.some(
          (m: Api) => m.role === "user" && /what does that cost/.test(textOf(m)),
        ),
      );

      // a message the extension itself sends ("1") is not you: it does not answer
      s.faux.setResponses([reply("ok")]);
      piApi.sendUserMessage("1");
      await s.settled(2);
      assert.equal(pendingQuestions(seed.dir).length, 1, "source extension never answers");

      // your exact word answers it: the reply is swallowed, the Director is woken with the answer
      s.faux.setResponses([reply("Going with three scenes.")]);
      await s.session.prompt("Cut");
      await s.settled(3);
      assert.equal(pendingQuestions(seed.dir).length, 0);
      assert.equal(readQuestions(seed.dir)[0]?.answer?.by, "chat");
      const woken = seen.at(-1)?.join("\n") ?? "";
      assert.match(
        woken,
        /The user answered your question q-1 \("Which story\?"\) with 1 · Cut to three scenes \(in the chat\)/,
      );
      const users = s.session.messages.filter((m: Api) => m.role === "user").map(textOf);
      assert.ok(!users.includes("Cut"), "the swallowed reply is not a user message of its own");

      // with nothing waiting, "1" is just chat
      s.faux.setResponses([reply("A 1?")]);
      await s.session.prompt("1");
      await s.settled(4);
      assert.ok(s.session.messages.some((m: Api) => m.role === "user" && textOf(m) === "1"));

      // two waiting questions that both have a 1: ambiguous, so chat; a word only one has answers that one
      ask(seed.dir, "Which story again?");
      ask(seed.dir, "Which voice?", [{ label: "Warm one" }, { label: "Neutral one" }]);
      s.faux.setResponses([reply("Which one do you mean?")]);
      await s.session.prompt("1");
      await s.settled(5);
      assert.equal(pendingQuestions(seed.dir).length, 2, "ambiguous: nothing answered");
      s.faux.setResponses([reply("Warm it is.")]);
      await s.session.prompt("warm");
      await s.settled(6);
      assert.deepEqual(
        pendingQuestions(seed.dir).map((x) => x.what),
        ["Which story again?"],
      );
      assert.equal(
        readQuestions(seed.dir).find((x) => x.what === "Which voice?")?.answer?.label,
        "Warm one",
      );
    } finally {
      s.dispose();
      await cleanup();
    }
  },
);
