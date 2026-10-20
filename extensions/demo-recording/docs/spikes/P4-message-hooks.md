# Spike P4: what pi lets an extension do for a question you answer in the chat or the panel, and for role labels

**Questions (item 11).** A4 (F18): can the Director ask once, show it in the chat and the panel, wait, and take **either** answer, with the
chat answer able to change project state (and with no way for the model to answer for you)? A5 (F23): can the role that speaks be shown
once in front of its text?

**Answer: yes to the first, with one rule; yes to the second for what the extension sends, and for the model's own text only as a stored
prefix (a trade-off to decide).** Everything below was observed in a real pi session with a scripted model
(`test/p4-spike-hooks.test.ts`, no network), not read from the docs. pi 1.3.0.

## What was observed

| # | Observation | Consequence |
|---|---|---|
| S1 | What you type reaches the extension as an `input` event with `source: "interactive"`. A message our own extension sends with `pi.sendUserMessage` arrives as `source: "extension"`. The model's own text is an assistant message and **never** an `input`. | A chat answer can be recognised as **yours**, and it can never be forged by the model, nor by our own panel bridge. (This also matches `docs/DIRECTOR_STATE.md`.) |
| S2 | A tool's `execute` may await a promise. While it waits, what you type is an `input` with `streamingBehavior: "steer"` (it belongs to the same run). A handler may resolve that promise and return `{ action: "handled" }`: the tool returns your answer as its result, the run goes on, and the reply is **not** added to the transcript as a user message. | One mechanism serves both channels: a blocking tool `ask` waits on a pending question; the panel's click and a typed chat reply both resolve it. Resolving once is a property of the promise. |
| S3 | `session.abort()` aborts the waiting tool (its `signal` fires). | A pending question can be abandoned cleanly when you stop the run; the panel shows it as cancelled. |
| S4 | `message_end` can replace the assistant's text. The replacement is **stored**, and the model **sees it** on its next request. | A role label can be a prefix written into the model's finished message ("Director · …"), deterministic and persistent, **but it enters the model's own history** (it may start writing the label itself, and it costs a few tokens per message). |
| S5 | `pi.registerMarkdownTransformer` (render-time, user and assistant text; it gets `messageType`, `isStreaming`, `availableWidth` and **no message identity**), `pi.registerMessageRenderer(customType, …)` and `registerEntryRenderer` exist. | A custom message we send can be drawn exactly as we like (a labelled question card). A render-time label for the model's text cannot know which role wrote an older message, so it can only label by what is current: wrong after a resume or for earlier text. |
| S6 | `pi.sendMessage({ customType, content, display: true, details })` adds a displayed custom message to the session without starting a turn. The model sees its content on its next request. | A question can be shown in the chat as a labelled message at any time, and the model learns of it (and of the answer) without us using a user message. |

## Not observed (open, to settle in the design)

- **A time limit for a waiting tool.** Nothing in the docs or the run suggests pi cuts a tool off. A question nobody answers would block the
  run until you abort it, so the extension must set its own limit (or none, and say "waiting for you").
- **Natural language.** The `input` handler sees the raw text. "yes", "1", "approve" are easy; "hmm, what does that cost?" is not an answer.
  The rule below keeps this safe, but how forgiving the matching should be is a design choice.
- **RPC and print modes.** `source` also has `"rpc"`. Whether an RPC client counts as "you" is a decision, not a fact.

## The one rule this implies for the gates

**A chat reply resolves a pending question only if it arrives as an `input` whose source is not `"extension"` AND it names one of the
options exactly** (the number or the word shown). Anything else goes to the model as ordinary chat and the question stays pending. The model
has no path to answer: its output is never an `input`, and a pending question is resolved by the engine, not by a tool result the model
writes. That keeps "only you approve" true with two channels.

## What this makes possible, and what it costs

- **A4 is feasible without pi changes**: a `pending question` in the engine (id, what, options, cost, role), a blocking tool for the
  Director, a panel route and a chat `input` handler that resolve it, a custom message that shows it in the chat, the band and a dialog in
  the panel. Cost: the approval gates are re-expressed in terms of a question object; every gate that exists today (approve, Use, Allow,
  replace a verdict) stays a panel action, and the question is a second way to reach the same action.
- **A5: labels on what the extension sends are free** (our custom messages and the `[demo-*]` prefixes). **Labels on the model's text** are
  the trade-off: a stored prefix (S4) works and is persistent but enters the model's context; a render-time label (S5) is invisible to the
  model but cannot be correct for older messages. A middle way is a skill rule ("start a block with your role once") plus a check, which
  depends on the model obeying.

Run the spike again with `DEMO_REC_NO_OPEN=1 node --test extensions/demo-recording/test/p4-spike-hooks.test.ts`.
