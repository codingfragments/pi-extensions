# Top 10 Extensions & Customizations

Ranked roughly by daily-value-to-build-cost ratio, not strict priority order.
Each entry notes the likely implementation shape (extension / skill / prompt
/ theme) per repo conventions.

1. **Vim modal input editor** (extension)
   Limited modal editing (normal + insert only, no visual/`:`) for the prompt
   input box: word/line/end-of-line objects, `d`/`c`/`y` operators, counts
   (`3dw`, `2yy`). No registers beyond one implicit last-yank/delete buffer.
   Mandatory always-active panic shortcut (real `registerShortcut`) resets to
   plain insert from any state; persistent mode indicator via
   `ctx.ui.setStatus`. State machine is a pure, unit-tested function,
   independent of rendering. Complex edits (multi-line restructuring,
   macros) hand off to `$EDITOR` rather than being reimplemented in-process.

2. **`ask-user` tool + custom TUI form** (extension: tool + `ctx.ui.custom`)
   A single tool the agent can call mid-turn with a *batch* of questions,
   rendered as one form. Two composable primitives — `choice` (with
   `multiple`/`allowNotes`/`allowOther` modifiers) and `text` — cover
   free text, single/multi-choice, yes/no, choice-with-clarifying-note, and
   "none of these fit, here's my own answer" in one schema. Partial-submit
   with per-question skip; soft per-turn call budget with a context reminder
   past threshold, no hard cap; non-interactive contexts get a structured
   "state your assumption and continue" error instead of silent guessing.
   Works for a single question posted alone or a full batch at once.

3. **Essential scoping/planning skill pack** (skills)
   `scope-me` (turn a vague ask into a written brief before coding, built on
   top of the `ask-user` tool once it exists), `plan-before-code` (force an
   explicit plan + confirmation before edits on non-trivial tasks),
   `checkpoint` (mid-task summary + risk check-in). `grill-me` stays
   plain-chat/free-form by design — adversarial interrogation doesn't fit
   choice-widgets — with an `ask-user` integration noted as a possible
   future enhancement, not a commitment.

4. **Session status widget** (extension, `ctx.ui.setWidget` / `setStatus`)
   Always-visible footer/header widget: current git branch, dirty-file
   count, active model, elapsed session time, token burn — glanceable
   context without asking the agent.

5. **Editor ergonomics pack** (extension)
   Non-vim quality-of-life bindings: multi-line paste handling, quick
   clear-input, jump-to-start/end, kill-line, a shortcut to open the last
   response in `$EDITOR`.

6. **Pre-flight guard extension** (extension, `tool_call` hook)
   Blocks/confirms risky tool calls (e.g. `rm -rf`, force-push, editing
   files outside repo root, `old/`/`.oh-my-zsh/` per this dotfiles repo's own
   rules) with a clear reason, reusable across all my projects.

7. **Diff-review skill + command** (skill + command)
   `/review` renders a structured self-review pass over the working diff
   before I commit — style, risk, missed tests — separate from `grill-me`'s
   adversarial plan review.

8. **Personal theme** (theme)
   A terminal theme tuned to my color scheme/contrast preferences, matching
   the rest of the dotfiles aesthetic (fish/tmux/nvim), reducing context
   switching.

9. **Prompt template library** (prompts)
   Reusable `.md` prompt templates for recurring task shapes I hit often
   (bugfix triage, dependency bump, changelog entry, PR description) callable
   via pi's prompt-template mechanism instead of retyping boilerplate asks.

10. **Session journal extension** (extension, `session_shutdown` +
    `pi.appendEntry`)
    On session end, auto-append a one-paragraph summary (goal, outcome,
    follow-ups) to a local journal file — cheap retrospective trail across
    all my pi sessions without manual note-taking.

## Sequencing note

Items 1, 3, and 5 map to Phase 1 (editing ergonomics) in `PLAN.md`. Item 2
is Phase 2. Items 4, 6–10 are Phase 3, ordered here by expected value but
open to reshuffling once Phase 1–2 are dogfooded.
