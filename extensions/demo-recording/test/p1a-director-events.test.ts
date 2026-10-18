/**
 * P1a PR 14 (the A2 spike): what pi really tells an extension about a run, pinned in a REAL agent session with a scripted
 * model (test/helpers/pi-session.ts). These are the facts the Director's visible state is built on (docs/DIRECTOR_STATE.md);
 * if a pi upgrade changes one, this test says which.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxSession, fauxText, fauxToolCall } from "./helpers/pi-session.ts";

// biome-ignore lint/suspicious/noExplicitAny: pi's extension API
type Api = any;

/** A tool that takes a moment, so a run has something in flight. */
const work =
  (ms = 120) =>
  (pi: Api) =>
    pi.registerTool({
      name: "work",
      label: "Work",
      description: "do some work",
      parameters: { type: "object", properties: {} },
      async execute() {
        await new Promise((r) => setTimeout(r, ms));
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    });

/** Commands that do what our panel and our jobs do to the session. */
const senders = (pi: Api) => {
  pi.registerCommand("panel", {
    description: "a panel approval reaches the Director",
    handler: async () =>
      pi.sendUserMessage("[demo-panel] The user approved storyboard v2", { deliverAs: "followUp" }),
  });
  pi.registerCommand("report", {
    description: "a finished job is reported",
    handler: async () =>
      pi.sendMessage(
        {
          customType: "demo-recording",
          content: "[demo-recording] Voice synthesis finished",
          display: true,
        },
        { triggerTurn: true },
      ),
  });
};

test("a run you start: the order of events, what is busy when, and the end", async () => {
  const s = await fauxSession({ extensions: [work()] });
  try {
    s.faux.setResponses([
      fauxAssistantMessage([fauxText("working"), fauxToolCall("work", {})]),
      fauxAssistantMessage("all done"),
    ]);
    await s.session.prompt("please do some work");
    await s.settled();
    assert.deepEqual(s.names(), [
      "input",
      "before_agent_start",
      "agent_start",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "turn_end",
      "agent_end",
      "agent_before_settle",
      "agent_settled",
    ]);
    const by = (ev: string) => s.seen.filter((x) => x.ev === ev);
    assert.deepEqual(by("input")[0]?.d.source, "interactive", "what you typed in pi");
    assert.equal(by("input")[0]?.idle, true, "idle until the input is taken");
    assert.equal(by("before_agent_start")[0]?.idle, false, "busy from before_agent_start on");
    assert.deepEqual(by("tool_execution_start")[0]?.d.tool, "work", "which tool runs");
    assert.deepEqual(by("tool_execution_end")[0]?.d.isError, false);
    assert.equal(by("agent_settled")[0]?.idle, true, "idle again at agent_settled");
    assert.equal(by("agent_settled")[0]?.d.aborted, false);
  } finally {
    s.dispose();
  }
});

test("what started a run: you typing, our panel message, or our report", async () => {
  const s = await fauxSession({ extensions: [senders] });
  try {
    s.faux.setResponses([
      fauxAssistantMessage("noted"),
      fauxAssistantMessage("noted"),
      fauxAssistantMessage("noted"),
    ]);
    // one at a time: a message that arrives while a run is starting or going is taken into that run (no run of its own)
    await s.session.prompt("a question");
    await s.settled(1);
    await s.session.prompt("/panel");
    await s.settled(2);
    await s.session.prompt("/report");
    await s.settled(3);
    const starts = s.seen.filter((x) => x.ev === "before_agent_start").map((x) => x.d);
    assert.deepEqual(starts[0], {
      messageType: "user",
      prompt: "a question",
      customType: undefined,
    });
    assert.deepEqual(starts[1], {
      messageType: "user",
      prompt: "[demo-panel] The user approved storyboard v2",
      customType: undefined,
    });
    assert.deepEqual(starts[2]?.messageType, "custom");
    assert.deepEqual(starts[2]?.customType, "demo-recording");
    // the input event says who sent a user message: you in pi ("interactive"), or an extension (our panel bridge)
    assert.deepEqual(
      s.seen
        .filter((x) => x.ev === "input")
        .map((x) => [String(x.d.text).slice(0, 12), x.d.source]),
      [
        ["a question", "interactive"],
        ["[demo-panel]", "extension"], // a /command you type is handled before input: it has no input event
      ],
    );
  } finally {
    s.dispose();
  }
});

test("Escape: the run ends with agent_settled aborted, and there is no final boundary", async () => {
  const s = await fauxSession({ extensions: [work(150)] });
  try {
    s.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("work", {})]),
      fauxAssistantMessage("never"),
    ]);
    const running = s.session.prompt("do work, then be aborted");
    await new Promise((r) => setTimeout(r, 40));
    await s.session.abort();
    await running.catch(() => undefined);
    await s.settled();
    const settled = s.seen.find((x) => x.ev === "agent_settled");
    assert.equal(settled?.d.aborted, true);
    assert.equal(
      s.seen.some((x) => x.ev === "agent_before_settle"),
      false,
      "no agent_before_settle after an abort",
    );
    assert.equal(settled?.idle, true);
  } finally {
    s.dispose();
  }
});

test(
  "a failing model that pi retries: agent_end is NOT the end, agent_settled is",
  { timeout: 30_000 },
  async () => {
    const s = await fauxSession();
    try {
      s.faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
        fauxAssistantMessage("recovered"),
      ]);
      await s.session.prompt("this fails once").catch(() => undefined);
      await s.settled(1, 20_000);
      const names = s.names();
      assert.equal(
        names.filter((n) => n === "agent_end").length,
        2,
        "the failed run and the retry each end",
      );
      assert.equal(names.filter((n) => n === "agent_settled").length, 1, "but pi settles once");
      assert.ok(
        names.lastIndexOf("agent_end") < names.indexOf("agent_settled"),
        "and only after the retry has ended",
      );
      const firstEnd = s.seen.find((x) => x.ev === "agent_end");
      const settled = s.seen.find((x) => x.ev === "agent_settled");
      assert.ok(
        (settled?.at ?? 0) - (firstEnd?.at ?? 0) >= 1000,
        "a gap of seconds between the first agent_end and the end: 'idle' there would be wrong",
      );
      assert.equal(
        s.seen.filter((x) => x.ev === "before_agent_start").length,
        1,
        "the retry is not a new run",
      );
    } finally {
      s.dispose();
    }
  },
);

test("you type while the Director works (steer): the same run takes it in, no second run", async () => {
  const s = await fauxSession({ extensions: [work(150)] });
  try {
    s.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("work", {})]),
      fauxAssistantMessage("saw your note"),
    ]);
    const running = s.session.prompt("start work");
    await new Promise((r) => setTimeout(r, 40));
    await s.session.prompt("also, be brief", { streamingBehavior: "steer" } as never);
    await running;
    await s.settled();
    const inputs = s.seen.filter((x) => x.ev === "input");
    assert.equal(inputs[1]?.d.streamingBehavior, "steer");
    assert.equal(inputs[1]?.idle, false, "while busy");
    assert.equal(s.seen.filter((x) => x.ev === "agent_start").length, 1);
    assert.equal(s.seen.filter((x) => x.ev === "agent_settled").length, 1);
  } finally {
    s.dispose();
  }
});

test(
  "our extension loads in a real session and the Director can use its tools",
  { timeout: 60_000 },
  async () => {
    const saved = { ...process.env };
    const root = await import("node:fs").then((fs) =>
      fs.mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/p1a-real-`),
    );
    process.env.DEMO_REC_ROOT = root;
    process.env.DEMO_REC_CONFIG = `${root}/none.json`;
    process.env.DEMO_REC_NO_OPEN = "1";
    const { default: ext } = await import(`../index.ts?real-${Date.now()}`);
    const s = await fauxSession({ extensions: [ext] });
    try {
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("demo_rec_config", { action: "show", key: "fps" })]),
        fauxAssistantMessage("fps is shown"),
      ]);
      await s.session.prompt("what is the frame rate?");
      await s.settled();
      const start = s.seen.find((x) => x.ev === "tool_execution_start");
      const end = s.seen.find((x) => x.ev === "tool_execution_end");
      assert.equal(start?.d.tool, "demo_rec_config");
      assert.deepEqual(start?.d.args, { action: "show", key: "fps" });
      assert.equal(end?.d.isError, false);
      const text = JSON.stringify(s.session.messages);
      assert.match(text, /fps = 30/, "the tool's answer reached the model");
    } finally {
      s.dispose();
      for (const k of Object.keys(process.env))
        if (!(k in saved)) Reflect.deleteProperty(process.env, k);
      Object.assign(process.env, saved);
    }
  },
);
