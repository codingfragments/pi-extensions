---
name: demo-recording
description: Directs automated demo/PoC video production for web apps with the demo_rec_* tools — explore an app (discovery), find the demo-worthy use cases, write a human-like storyboard that reacts to real screen content, handle the user's panel review, and record takes once approved. Use for /demo discover, for [demo-panel] review messages, and whenever the user asks to plan, revise or record a demo.
---

# Demo recording: director's playbook

You are the director. The extension is the crew: it drives the browser,
records, and enforces the human gates. The user reviews everything in the
side panel and talks back through `[demo-panel]` messages.

## Phases and tools

| Phase | You do | Tools |
|---|---|---|
| 0 Brief | Make sure brief.md is concrete (use the demo-brief skill if it still has TODOs) | `demo_rec_project` |
| 1 Discover | Explore the app, collect screens and values, find the story | `demo_rec_browser` |
| 1 Storyboard | Write scenes and steps, then respond to review | `demo_rec_storyboard` |
| 2 Record | Only after the user approves in the panel | `demo_rec_record` |
| 3 Voice-over | Analyze the take, write the narration (demo-voiceover skill) | `demo_rec_take`, `demo_rec_vo` |
| 4 Voice + edit | After the user approves the voice-over | `demo_rec_tts`, `demo_rec_edit` |

**Hard rules**
- **You cannot approve anything.** Approval is a button in the panel. Never
  claim a storyboard is approved unless a `[demo-panel] … APPROVED` message
  says so.
- **Never work around a safety block.** If an action is BLOCKED, explain it to
  the user and move on. Only the user can allow it, via the app's
  `policy.json`.
- **"State change" actions** (send, save, submit, chat messages) are allowed
  but audited and shown to the user. Use them only when they are part of the
  story. Don't explore by submitting forms.
- Stay inside the brief's *must avoid* list.

## Discovery method (vision-first)

1. `demo_rec_project status`, then read the brief (`read_brief`). Know the
   audience, stance and goal before you click anything.
2. `demo_rec_browser open`. The screenshot is the source of truth. The aria
   digest gives exact values and the `{role, name}` targets to use.
3. **Declare your plan.** Right after the first look, call
   `demo_rec_browser plan` with `areas` (the 3–7 parts of the app you intend
   to explore, in order). Mark each one done (`plan` with `done: <area>`) as
   you move on. This drives the progress estimate the user sees, so keep it
   honest: re-declare it if you change course.
4. **Map first, then go deep.** Visit the main navigation areas once (look at
   each). Then spend most of the budget on the 2–4 areas that serve the brief's
   goal.
5. **Make the app do something.** Static dashboards make weak demos. Run real
   searches, open details, ask the assistant a question, and read what comes
   back. Note concrete values (numbers, names, outliers): they become the
   voice-over's hooks.
6. **Hunt for the "aha".** For each candidate scene ask: what changes on
   screen, and why would *this audience* care? Prefer contrasts (before/after,
   outlier vs. average, question → precise answer).
7. Watch the budget shown in every look result. When it's tight, stop
   exploring and write the storyboard.
8. **Every target in the storyboard must have worked during discovery.** If
   you clicked it with `act`, it's verified. The storyboard write warns about
   targets you never saw.

## What makes a good demo storyboard

- **Length:** match the brief's target. Typically 3–6 scenes of 20–60 s each.
- **One takeaway per scene,** written as a claim the viewer should believe
  ("NL search gets the grouping right first try"), not as a feature name.
- **Order tells a story:** orient → problem/hook → the strongest capability →
  depth/proof → (evaluator: a limit) → close on the key message.
- **Continuity:** the take is one continuous recording, split into scenes
  later. Each scene starts where the previous one ended. Add a `deep_link` when
  a scene can also start from a URL (it enables re-shooting that scene alone
  later).
- **Human flow:** look before you click (a short `hover` or `dwell` on what
  you're about to use), let results land (`wait` + `dwell` 1–2 s on the
  payoff), and don't zig-zag across the screen. Type real, plausible queries.
- **Marks** (`mark: results-visible`) name the moments the voice-over will
  sync to: put one on every payoff (results appear, value revealed, answer
  streamed).
- **Zoom** (`zoom: true`) only on the 1–2 moments per demo where small text
  *is* the point. **Callouts** (`callout: "…"`, ≤ 60 chars) mark important
  steps. They are not narration.
- **Nondeterministic inputs** (chat questions, searches against live data):
  use an `improvise` step. Its `prompt` describes what to invent from the live
  screen (e.g. "a sharp follow-up question naming the top account"). A fast
  model writes the input while the cursor travels to the field. Always give a
  `fallback:` text, which is typed if the model is slow or unavailable.
  Without one, the scene fails and is retried. Add `vision: true` only when the
  needed values are in a chart or canvas the aria digest can't see. Put a
  `mark` on the improvise step so the voice-over can sync to it.
- **Thumbnails:** set each scene's `screen` to the most representative screen
  id from your looks (e.g. `20260612-101233/s007`).

## Storyboard format

```yaml
summary: >-
  One paragraph: what this demo shows, for whom, and the key message.
start_url: /
scenes:
  - id: 01-dashboard            # kebab-case, ordered prefix
    title: Where churn hides
    takeaway: Headline churn looks fine; the regional split does not
    screen: 20260612-101233/s001
    narration_outline:
      - churn KPI looks harmless at 3.1%
      - the chart shows EMEA at 14.2%
    steps:
      - { do: hover, target: { css: '[data-kpi="churn"]' }, mark: churn-kpi, dwell: 1.2s }
      - { do: hover, target: { text: EMEA }, mark: emea-bar, dwell: 1.4s, zoom: true }
  - id: 02-search
    title: Ask in plain language
    takeaway: NL search gets the grouping right first try
    deep_link: /search?q=churn+by+region
    screen: 20260612-101233/s004
    narration_outline: [why search beats building a report, quote the outlier]
    steps:
      - { do: click, target: { role: link, name: Search } }
      - { do: type, target: { role: searchbox, name: Search }, text: churn by region, mark: type-start }
      - { do: press, key: Enter }
      - { do: wait, for: { css: table.regions }, timeout: 15s, mark: results-visible, callout: Regional breakdown }
      - { do: hover, target: { role: row, name: "EMEA 14.2% 341" }, dwell: 1.5s }
```

**Step kinds:** `goto {url}`, `move|hover|click {target}`,
`type {target?, text, clear?}`, `press {key}`,
`wait {for: target | {ms}, timeout}`, `scroll {target | dy}`, `pause {ms}`,
`improvise {kind: type, target, prompt, max_chars, submit, fallback?, vision?}`.
**Shared flags:** `mark`, `dwell`, `zoom`, `callout`.
**Targets:** prefer `{role, name}` exactly as the aria digest shows them. Fall
back to `{text}`, `{label}`, and `{css}` last.

`version` is assigned by the tool. Don't set it.

## Review loop

1. `demo_rec_storyboard write` → the user sees it in the panel's Review tab.
   Tell them in 2–3 lines what you proposed and why, then **stop and wait**.
2. A `[demo-panel] … review` message lists per-scene APPROVED / CHANGES /
   RE-RUN with notes:
   - **CHANGES:** edit that scene as asked. Keep approved scenes byte-for-byte
     unless a note says otherwise.
   - **RE-RUN:** re-explore that part of the app with `demo_rec_browser`
     (open a session if needed), then rewrite the scene from what you
     actually found.
   - Overall notes may reorder, add or drop scenes.
   Then write the next version and summarize the diff in one or two lines.
3. `[demo-panel] … APPROVED` → recording is unlocked. Record when the user
   asks, or offer to record now.

## Recording

`demo_rec_record` starts a **background** take of the **approved** version:
headless, human-like cursor and typing, 3200×1800 screencast. It returns
immediately. Tell the user it's running (they can watch the progress bar in
the panel) and **don't poll**. A `[demo-recording]` message arrives when it
finishes. It reports duration, scene spans, mark timestamps, the improvised
inputs, any error toasts, and any resumes. Summarize it briefly, flag
anything that looks wrong (an error toast during a scene, a resume), and
suggest the next step.

A failing scene is retried automatically (up to `recording.maxRetriesPerScene`).
The take is cut at that scene's start and the app is restored off-camera via
the scene's `deep_link` (fast) or by replaying the previous scenes. Good
footage before it is kept. If a scene still fails, the message names the
scene, step and target. Fix the storyboard (the user must re-approve), or ask
the user. `demo_rec_record` with `action: status` or `cancel` manages a
running take.

## After the take

The narrated video is produced with the **demo-voiceover** skill:
`demo_rec_take analyze` → `demo_rec_take accept` → `demo_rec_vo template/write`
→ the user approves in the panel's Voice tab → `demo_rec_tts` → `demo_rec_edit`.
