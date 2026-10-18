# The Director's state: what pi tells an extension (the A2 spike)

Status: **finding and design; built in P1a PR 15** (`src/director/`, the band, the strip, the stepper and Activity). Question (F9, F13): can the panel say "the Director is working on X", so that it never
says "Needs you" while the Director is busy, and every Director task shows up? Answer: **yes, pi tells an extension everything needed, with
one trap (the end of a run).** Everything below was observed in a **real pi agent session with a scripted model** (no network, no
credits) and is pinned by `test/p1a-director-events.test.ts`, run through `test/helpers/pi-session.ts`: if a pi upgrade changes one fact, that
test says which. The same helper runs our extension inside a real session (a scripted Director calls `demo_rec_config`; the tool runs and its
answer reaches the model).

## What pi tells us

A run, in order (a tool call in the middle, then the answer):

```
input                 (only for text you or an extension send as a user message)
before_agent_start    a run is starting: pi is busy from here on (ctx.isIdle() is false)
agent_start
turn_start            (every model call is a turn)
message_start/end     (the user, assistant and tool-result messages)
tool_execution_start  toolName, args          ← which tool, with what
tool_execution_end    toolName, isError, durationMs
turn_end
turn_start … turn_end (the next model call)
agent_end             the run's messages are done: NOT the end of the work (below)
agent_before_settle   the last place an extension may add something
agent_settled         { aborted }             ← pi will not continue by itself: idle again
```

| Fact | What it means for us |
|---|---|
| `before_agent_start` has `messageType`: `"user"` (with the `prompt`) or `"custom"` (with the message and its `customType`) | We can tell **what started the run**: the text you typed in pi; our panel bridge (`sendUserMessage`: a user message whose text starts with `[demo-panel]`); or our job report (`sendMessage … triggerTurn`: `customType: "demo-recording"`). |
| The `input` event has `source`: `"interactive"` (you in pi) or `"extension"` (our bridge) | Tells you from the panel's messages. A `/command` you type is handled **before** input and has no input event; a custom message starts a run with no input event at all. |
| `tool_execution_start` has `toolName` and `args` | We can name the step: `demo_rec_vo write`, `demo_rec_browser act`, … |
| Between tools there is a turn (a model call) with no tool | The label for that time is "thinking". |
| **`agent_end` is not the end.** After a failing model call pi retries by itself: the first run ends, **seconds later** the retry runs, and only then does `agent_settled` fire (once). The retry is not a new `before_agent_start`. | The Director is **working until `agent_settled`**, never until `agent_end`. Treating `agent_end` as "idle" would flash "Needs you" for two seconds in the middle of a retry. |
| Escape: `agent_settled` with `aborted: true`, and no `agent_before_settle`. A running tool is not interrupted unless it honours its signal. | End the state on `agent_settled` either way; say "stopped" when aborted. |
| You type while the Director works (**steer**): an `input` with `streamingBehavior: "steer"`, taken into the **same** run: no second `agent_start`, one `agent_settled` | Optionally note "+ your message" in the task; never a second state. |
| A message that arrives **while a run is starting or going** (our panel bridge, a job report) is taken into that run and does not start one of its own | Several things can be folded into one Director run: the task label comes from the run's first message. |
| `ctx.isIdle()` is false from `before_agent_start` to `agent_settled`, true at `input` and at `agent_settled` | A cross-check, not the source. |
| Handlers are awaited in order | Ours must be cheap and never throw. |

What pi does **not** tell us: why a tool was chosen (nothing to show), anything about a run that happens in another pi session (one panel
belongs to one session), and "waiting for you" as such. Idle after `agent_settled` is the only thing that means "the Director waits for you".

## The design for PR 15 (the Director's state, visible)

**One small state machine in the engine**, fed by the events above (`src/director/state.ts`, pure and unit-tested):

```
working  = from before_agent_start to agent_settled (and cleared on session_shutdown)
task     = what started it, in words:  you typed "<first words>"  |  your approval / review / re-record from the panel  |  the report of a job
step     = the tool in flight (from tool_execution_start to _end), or "thinking" between tools
```

- **The task label** comes from the start: a typed prompt → "Answering you: <first words>"; a `[demo-panel]` message → a table of its known
  shapes ("Revising the storyboard from your notes", "Continuing after your approval of the voice-over", "Recording a new take", …) with
  the first sentence as the fallback; a `demo-recording` report → "Reading the report: <its first line>".
- **The step label** comes from `toolName` and the action (`demo_rec_vo write` → "Writing the voice-over", `demo_rec_browser act` →
  "Exploring the app", `demo_rec_take analyze` → "Analyzing the take", …; any other tool → "Using <tool>").
- **Bus events** `director.started`, `director.step`, `director.settled` (classes in `steps.js`: progress; a settle with `aborted` is quiet), so
  the log, the Activity list and a reload (`/api/state` carries the current state) all see the same thing.
- **The panel says it everywhere it says anything about progress**: the **band** shows "Director working: <task> · <step>" **instead of**
  "Needs you" (what waits for you becomes a small "N items wait for you" link beside it); the **strip** says it when no job runs; the
  **Activity drawer** gets a Director row under Running; the **stepper** marks the stage a tool belongs to as running while it runs. A task
  that ends quietly is a line in "Happened by itself" when it produced something.
- **No invented numbers:** no progress percentage (a run has none).
- **Failure modes handled:** retry gaps (end only at `agent_settled`), Escape, a session that closes (cleared on `session_shutdown`), a state
  with no event for a long time and no tool in flight is shown as "Director working (no news for N min)" instead of lying either way.

Acceptance for PR 15 (all through the real-session helper, so the whole path is tested, not a fake): a scripted Director run shows
"working" in the engine state, on the bus and in the panel's band and strip, while a tool runs and during the retry gap, and "idle" only at
`agent_settled`; an approval sent from the panel gets its task label; Escape ends it as stopped.

## Decided while building PR 15
- A `/demo` command typed in pi is **not** a Director task: it is not a run and has no events; only what it starts is (the skill it kicks off
  is labelled from the text that was sent, before pi expands the skill into a long prompt).
- The step label is the tool and its action, **without** the arguments (nothing like a scene name is shown); a step names the stage it
  concerns so the stepper can mark it.
- "Thinking" is no event of its own: it is the time between two tools, and the band says "· thinking".
- The Director's task shows in the band **instead of** "Needs you"; what waits for you is a small "N items wait for you" link beside it. A
  blocked stage still wins over "working" (a failed job is something to see even while the Director works).
