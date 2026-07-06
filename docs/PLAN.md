# Plan: Personal pi Coding Experience

## Goal

Build a self-authored, self-hosted pi setup ("codingfragments") that replaces
default/off-the-shelf pi UX in the areas that matter most to me:

1. An **ask-me TUI** — a structured way to interrogate/scope a task before
   the agent starts working (turns vague requests into a scoped brief).
2. A **better editor experience** — vim keybindings and general editing
   ergonomics inside pi's prompt/input surfaces.
3. A small set of **essential prompts** that consistently scope, plan, and
   checkpoint agent work (of which `grill-me` is the first example already
   shipped as a skill).

Everything lives in this repo (`pi-extensions`), is independently loadable,
versioned, and can later be installed elsewhere via `pi install
git:github.com/codingfragments/pi-extensions@<ref>`.

## Non-goals (for v1)

- Not building a general-purpose extension marketplace/product for others.
- Not replacing pi's core agent loop, model routing, or provider system.
- Not trying to reimplement a full modal editor (Vim) — only bind the
  keystrokes/motions that matter for day-to-day prompt editing.
- Not building team/multi-user features (`.pi/teams` stays out of scope for
  this personal-tooling effort).

## Guiding principles

- **Own the workflow layer, not the model layer.** Extensions shape how I
  scope, review, and interact — not how models are called.
- **Skills/prompts before tools.** Prefer a `SKILL.md` or prompt template
  over a custom tool/extension whenever behavior can be expressed as
  instructions rather than code (per repo convention).
- **One extension, one job.** Keep `extensions/*` folders small and
  independently installable, per `AGENTS.md` conventions already in this
  repo.
- **Dogfood daily.** Every extension should be something used in real pi
  sessions within days of being built, not theoretical.
- **TUI features are additive, not disruptive.** Vim bindings and custom
  panels must have an escape hatch (toggle off) so a broken keybinding never
  blocks work.

## Phases

### Phase 0 — Foundations (this week)
- Confirm repo scaffolding (`.pi/settings.json`, `extensions/_template`,
  `skills/`, `prompts/`, `docs/`) — already in place.
- Write this plan + top-10 backlog (this document).
- Decide the TUI component API surface needed (`ctx.ui.custom`) by reading
  `docs/tui.md` before writing any TUI code.

### Phase 1 — Editing ergonomics (highest daily-value, do first)
- **Vim modal input extension** for the pi prompt editor. MVP scope, fixed by
  design review (see Decisions Log): normal + insert modes only (no visual,
  no `:` ex-commands); objects limited to word/line/end-of-line; operators
  `d`/`c`/`y` composing with those objects; **counts supported**
  (`3dw`, `2yy`, etc.); no registers beyond one implicit last-yank/delete
  buffer. Complex edits (multi-line restructuring, macros, registers) are
  explicitly punted to a `$EDITOR`-handoff shortcut, not reimplemented
  in-process.
  - **Non-negotiable safety requirement:** a dedicated, always-active panic
    shortcut (real `registerShortcut`, not vim-emulated) that force-resets
    to plain insert mode from any internal state, plus a persistent mode
    indicator via `ctx.ui.setStatus`.
  - **Non-negotiable testing requirement:** the mode/count/operator/object
    state machine must be implemented as a pure `(state, keystroke) ->
    newState` function with unit tests, independent of TUI rendering. The
    first test written must assert `Esc`/panic-key returns to plain insert
    from every reachable state.
- Essential prompt-scoping skills (task-scope, plan-before-code,
  checkpoint/review) — see item 3 in `TOP10.md`.

### Phase 2 — `ask-user` tool + custom TUI form
- A single tool (`ask-user`) the agent can call mid-turn with a **batch** of
  questions (`questions: [...]`), not a pre-flight-only gate. See Decisions
  Log for the full schema shape agreed during design review.
- Rendered via one custom `ctx.ui.custom` form component (v1: simple
  vertical stack with a cursor between questions; left/right navigation
  layout considered but deferred to implementation time).
- Soft budget: track `ask-user` **calls** (not individual questions) per
  agent turn; after a threshold, inject a reminder into context rather than
  blocking further calls. No hard cap, no cross-session cap.
- Non-interactive contexts (`ctx.hasUI === false`, e.g. `-p`/json/rpc modes):
  return a structured error asking the model to state an explicit assumption
  and continue, rather than guessing on the tool's behalf.

### Phase 3 — Everything else in the top-10 backlog
- Prioritize by daily friction removed vs. build cost.

## Success criteria

- I stop reaching for ad-hoc manual prompt-scoping and instead run a
  slash command / skill.
- Vim bindings feel native enough that I don't miss my editor's modal
  editing when writing prompts.
- Each shipped extension has a README, is independently installable, and
  has been used in at least 3 real sessions before being considered "done".

## Decisions log (from `/grill-me` design review)

1. **`ask-user` is a tool, not a pre-flight-only gate.** The agent can call it
   mid-turn whenever genuinely blocked, not just before starting work.
2. **Soft budget, not a hard cap**, on `ask-user` usage: count calls (batches)
   per agent turn; past a threshold, inject a context reminder rather than
   refusing further calls. No cross-session limit — use the journal (top-10
   item 10) to notice chronic over-asking instead.
3. **Non-interactive degrade path is uniform and hard-erroring**: if
   `ctx.hasUI` is false, `ask-user` returns a structured error telling the
   model to state an explicit assumption and continue — no silent
   auto-defaulting on the tool's behalf.
4. **Single tool, batched questions.** One `ask-user` tool takes an array of
   questions rendered as one form in one round-trip, not N separate tool
   calls for N questions.
5. **Two composable primitives, not five named kinds.** Base kinds are
   `choice` and `text`, with modifiers: `multiple` (multi-select),
   `allowNotes` (free-text note attached to a selection), `allowOther`
   (escape hatch: a free-text answer *replaces* picking any listed option,
   for when none of the choices fit). `yes_no`/`proposal`-style questions
   are documentation sugar over `choice`, not separate schema types.
6. **Partial-submit with per-question skip** is the default cancel/incomplete
   behavior; the agent sees per-question `answered | skipped` status and may
   re-ask skipped/blocking questions later (within budget). Whole-call abort
   rides on the existing `AbortSignal`/Ctrl-C mechanism rather than bespoke
   cancel plumbing.
7. **One custom `ctx.ui.custom` form component for the whole batch** (not a
   loop of `ctx.ui.select`/`ctx.ui.input` calls). v1 layout: simple vertical
   stack with a cursor between questions; left/right navigation is a
   candidate layout improvement, decide at implementation time. Must work
   equally well for a single question posted alone (agent produces them one
   at a time) and for a full batch posted at once.
8. **Phasing stays vim-bindings-first** (Phase 1) despite `ask-user` being
   higher-leverage/higher-risk — explicit choice to bank a fast, low-risk,
   self-contained win before tackling the harder custom TUI component.
9. **`grill-me` is not retrofitted onto `ask-user`.** Adversarial, open-ended
   interrogation stays plain chat; `ask-user` is reserved for genuinely
   enumerable/form-shaped decisions. Tracked as a possible future
   enhancement in `grill-me`'s own `SKILL.md`, not a plan commitment.
10. **Vim MVP is modal-with-limits, not full emulation and not a pure
    `$EDITOR`-handoff.** Normal + insert modes only (no visual, no `:`);
    objects limited to word/line/end-of-line; operators `d`/`c`/`y`; counts
    included (e.g. `3dw`, `2d3w`); no registers beyond one implicit
    last-yank/delete buffer. `$EDITOR` handoff remains the escape hatch for
    anything bigger (multi-line restructuring, macros).
11. **Non-negotiable for vim mode:** an always-active real `registerShortcut`
    panic key that force-resets to plain insert from any internal state, a
    persistent `ctx.ui.setStatus` mode indicator, and a pure
    `(state, keystroke) -> newState` function covered by unit tests — the
    panic-key-recovers-from-every-state test is written first, before any
    motion/operator logic.

## Open questions (not yet resolved)

- Should prompts/skills be versioned independently from extensions, given
  they can be installed piecemeal?
- What's the deprecation/retirement policy when an experiment doesn't earn
  its keep?
- Exact `ask-user` result payload shape (per-question status, notes,
  "other" text) — defer to implementation, informed by decisions 4–6 above.
- Left/right vs. up/down navigation for the `ask-user` form component —
  explicitly deferred to implementation time (decision 7).
- **Sharing this repo as a package (deferred until something is actually
  ready to ship):** local static-path config and a `packages` git/npm entry
  for this same repo are not deduplicated against each other — running both
  on one machine double-registers every tool/skill/command (see README's
  "Don't run the static path and the git package at the same time"). Before
  the first tagged release: (1) audit tool/skill/command names for
  collision-resistance against other consumers' installed packages (see
  `AGENTS.md` conventions), (2) decide whether to keep this as one monorepo
  package or split into per-extension packages given the filtering support
  already documented in `README.md`, (3) confirm the static-path entries in
  `~/.pi/agent/settings.json` stay as the only active mechanism on this dev
  machine even after a `packages` entry exists for others to consume.
