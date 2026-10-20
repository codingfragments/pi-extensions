/**
 * P4 spike (item 11): what pi really lets an extension do for "a question you can answer in the chat or in the panel" (A4, F18) and
 * "the role that speaks is labelled" (A5, F23). A REAL pi session with a scripted model; every claim below is observed, not read from docs.
 *
 *   S1  a typed reply reaches the extension as an `input` event with its source; the model's text never does
 *   S2  an `input` handler can RESOLVE a tool that is waiting, and swallow the reply ("handled"), also while the run is streaming
 *   S3  aborting the run aborts the waiting tool (its signal), so a pending question can be cleaned up
 *   S4  `message_end` can replace the assistant's text, the replacement is persisted AND seen by the model on the next request
 *   S5  the API has a markdown transformer and a message renderer (the rendering side of a label)
 *   S6  `sendMessage` puts a custom, displayed message into the session (a question shown in the chat), and what the model sees of it
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxSession, fauxToolCall } from "./helpers/pi-session.ts";

// biome-ignore lint/suspicious/noExplicitAny: pi's extension API, passed through as it is
type Api = any;

/** A tool that waits for an answer from outside (the pending question), and the means to answer it. */
function waitingTool() {
  const wait: { resolve?: (t: string) => void; aborted: boolean; started: boolean } = {
    aborted: false,
    started: false,
  };
  const factory = (pi: Api) => {
    pi.registerTool({
      name: "ask",
      label: "Ask",
      description: "Ask the user and wait",
      parameters: Type.Object({ question: Type.String() }),
      async execute(_id: string, params: { question: string }, signal?: AbortSignal) {
        wait.started = true;
        const answer = await new Promise<string>((resolve, reject) => {
          wait.resolve = resolve;
          signal?.addEventListener("abort", () => {
            wait.aborted = true;
            reject(new Error("the question was abandoned"));
          });
        });
        return {
          content: [{ type: "text", text: `The user answered: ${answer}` }],
          details: { answered: answer },
        };
      },
    });
  };
  return { wait, factory };
}

const textOf = (m: Api) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((c: Api) => c.text ?? "").join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 8000) {
  for (let i = 0; i < ms / 20 && !f(); i++) await sleep(20);
  assert.ok(f(), "timed out");
}

test(
  "S1+S2: a reply typed while a tool waits is an `input` with its source; a handler resolves the wait and swallows the reply",
  { timeout: 40_000 },
  async () => {
    const { wait, factory } = waitingTool();
    const inputs: { source: string; text: string; streamingBehavior?: string }[] = [];
    const answerer = (pi: Api) => {
      pi.on("input", async (e: Api) => {
        inputs.push({ source: e.source, text: e.text, streamingBehavior: e.streamingBehavior });
        // the rule under test: while a question is pending, what YOU type resolves it (never what an extension sends)
        if (wait.resolve && e.source !== "extension") {
          const r = wait.resolve;
          wait.resolve = undefined;
          r(e.text);
          return { action: "handled" };
        }
        return { action: "continue" };
      });
    };
    const s = await fauxSession({ extensions: [factory, answerer] });
    try {
      let seenByModel = "";
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("ask", { question: "Approve storyboard v2?" })]),
        (ctx: Api) => {
          seenByModel = JSON.stringify(ctx.messages);
          return fauxAssistantMessage("Understood, going on.");
        },
      ]);
      const run = s.session.prompt("please ask me");
      await until(() => wait.started);
      // you answer in the chat while the Director waits: pi calls it a steer
      await s.session.prompt("yes, approve it", { streamingBehavior: "steer" });
      await run;
      await s.settled(1);
      assert.deepEqual(
        inputs.map((i) => [i.source, i.text, i.streamingBehavior]),
        [
          ["interactive", "please ask me", undefined],
          ["interactive", "yes, approve it", "steer"],
        ],
      );
      // the tool returned the answer; the model saw it as the tool's result
      assert.match(seenByModel, /The user answered: yes, approve it/);
      // "handled": the reply is not a user message of its own (the model does not see it twice)
      const users = s.session.messages.filter((m: Api) => m.role === "user").map(textOf);
      assert.deepEqual(
        users,
        ["please ask me"],
        "the swallowed reply is not in the transcript as a user message",
      );
      assert.equal(wait.aborted, false);
    } finally {
      s.dispose();
    }
  },
);

test(
  'S1b: a message our own extension sends as a user message is an `input` with source "extension"',
  { timeout: 40_000 },
  async () => {
    const sources: string[] = [];
    let pi!: Api;
    const bridge = (p: Api) => {
      pi = p;
      p.on("input", async (e: Api) => {
        sources.push(`${e.source}:${e.text}`);
        return { action: "continue" };
      });
    };
    const s = await fauxSession({ extensions: [bridge] });
    try {
      s.faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok again")]);
      // what the panel's click does to reach the Director: it must not be mistaken for you typing
      pi.sendUserMessage("[demo-panel] approved from the panel");
      await s.settled(1);
      await s.session.prompt("a reply typed by the user");
      assert.deepEqual(sources, [
        "extension:[demo-panel] approved from the panel",
        "interactive:a reply typed by the user",
      ]);
    } finally {
      s.dispose();
    }
  },
);

test(
  "S3: aborting the run aborts the waiting tool, so the pending question can be cleaned up",
  { timeout: 40_000 },
  async () => {
    const { wait, factory } = waitingTool();
    const s = await fauxSession({ extensions: [factory] });
    try {
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("ask", { question: "Approve?" })]),
        fauxAssistantMessage("stopped"),
      ]);
      const run = s.session.prompt("ask me").catch(() => undefined);
      await until(() => wait.started);
      await s.session.abort();
      await run;
      await until(() => wait.aborted);
      assert.equal(wait.aborted, true, "the tool saw the abort");
    } finally {
      s.dispose();
    }
  },
);

test(
  "S4: message_end can replace the assistant's text; it is persisted and the model sees it on the next request",
  { timeout: 40_000 },
  async () => {
    const labeller = (pi: Api) => {
      pi.on("message_end", async (e: Api) => {
        if (e.message?.role !== "assistant") return undefined;
        const parts = (e.message.content ?? []) as Api[];
        if (!parts.some((c) => c.type === "text")) return undefined;
        const content = parts.map((c, i) =>
          c.type === "text" && i === parts.findIndex((x) => x.type === "text")
            ? { ...c, text: `Director · ${c.text}` }
            : c,
        );
        return { message: { ...e.message, content } };
      });
    };
    const s = await fauxSession({ extensions: [labeller] });
    try {
      let second = "";
      s.faux.setResponses([
        fauxAssistantMessage("First answer."),
        (ctx: Api) => {
          second = JSON.stringify(ctx.messages);
          return fauxAssistantMessage("Second answer.");
        },
      ]);
      await s.session.prompt("one");
      await s.session.prompt("two");
      const assistants = s.session.messages.filter((m: Api) => m.role === "assistant").map(textOf);
      assert.deepEqual(
        assistants,
        ["Director · First answer.", "Director · Second answer."],
        "the label is in the stored message",
      );
      assert.match(
        second,
        /Director · First answer\./,
        "and the model sees its own earlier text with the label",
      );
    } finally {
      s.dispose();
    }
  },
);

test(
  "S5+S6: a markdown transformer and a message renderer exist; sendMessage adds a displayed custom message, and the model sees it on its next request",
  { timeout: 40_000 },
  async () => {
    const have: Record<string, string> = {};
    const q = (pi: Api) => {
      have.markdown = typeof pi.registerMarkdownTransformer;
      have.renderer = typeof pi.registerMessageRenderer;
      have.entryRenderer = typeof pi.registerEntryRenderer;
      pi.registerMessageRenderer("demo-question", () => undefined);
      pi.registerMarkdownTransformer((md: string) => md);
    };
    let pi!: Api;
    const grab = (p: Api) => {
      pi = p;
    };
    const s = await fauxSession({ extensions: [q, grab] });
    try {
      assert.deepEqual(have, {
        markdown: "function",
        renderer: "function",
        entryRenderer: "function",
      });
      let seen = "";
      s.faux.setResponses([
        (ctx: Api) => {
          seen = JSON.stringify(ctx.messages);
          return fauxAssistantMessage("fine");
        },
      ]);
      // a question shown in the chat while nothing runs: stored, displayed, no turn started
      pi.sendMessage({
        customType: "demo-question",
        content: "Director asks: approve storyboard v2? (a) approve (b) change",
        display: true,
        details: { id: "q-1" },
      });
      await sleep(50);
      const custom = (s.session.messages as Api[]).find((m) => m.role === "custom");
      assert.ok(custom, "a custom message is in the session");
      assert.deepEqual(
        [custom.customType, custom.display, custom.details?.id],
        ["demo-question", true, "q-1"],
      );
      assert.equal(s.names().includes("agent_start"), false, "no turn was started by it");
      await s.session.prompt("go");
      assert.match(
        seen,
        /Director asks: approve storyboard v2\?/,
        "the model's next request includes it",
      );
    } finally {
      s.dispose();
    }
  },
);
