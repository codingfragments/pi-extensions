---
name: demo-recording
description: Directs automated demo/PoC video production for web apps with the demo_rec_* tools — explore an app (discovery), find the demo-worthy use cases, write a human-like storyboard that reacts to real screen content, handle the user's panel review, and record takes once approved. Use for /demo discover, for [demo-panel] review messages, and whenever the user asks to plan, revise or record a demo.
---

# Demo recording: director's playbook

**Say who is speaking (D144).** Start a block of your own text with your role once, e.g. `Director:` (and `Researcher` while exploring, `Storyboard writer` while writing a storyboard, `Operator` while recording`), so the user can tell the
cast apart in the chat. Once per block, not on every line, and never inside an artifact you write (a storyboard, a script, a brief).
Messages from the engine arrive already labelled: `[demo-recording · Cutter]` is a report, `[demo-panel · You]` is the user acting in the panel.

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
| 5 Annotations | After the edit (automatic) or a `[demo-panel]` request: suggest zooms, callouts, … (demo-annotations skill); the user approves in the panel | `demo_rec_annotations` |
| 6 Render | After the user approves annotations: offer a final (ask brands, subtitles); every final is QA-checked automatically — summarise the hard stops (broken files, a leaking redaction) and what needs the user's eyes, with the fixes; the user applies fixes / confirms / accepts in the Render tab | `demo_rec_render` (`qa` shows the report) |

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

## Stages, the production line and project memory

Work moves through the stages storyboard → recording (take) → voice-over →
annotations → render.
- **One parent per version.** Every version is based on exactly one version
  of the stage before it: a take records its storyboard version, a voice-over
  names its take.
- **Several approved versions per stage.** The user may approve two takes of
  one storyboard and give each its own voice-over. Approving resets nothing.
  A version can only be approved when its parent is approved.
- **Withdrawing an approval blocks, it never resets.** Approved work built on a
  version whose approval was withdrawn is flagged **blocked by dependency** and
  can't be used until that version is approved again. Nothing is deleted.
- **The production line** is what the user and you are working on, e.g.
  storyboard v2 → take-006 → voice-over v3. Your tools default to it:
  - `demo_rec_record` records its storyboard;
  - `demo_rec_vo template` uses its take;
  - `demo_rec_tts` / `demo_rec_edit` use its voice-over.

  Pass an explicit version only when the user asks for a different line.
- **What the user does in the panel, and what you get.** Looking at a version
  (History, the version links) tells you nothing. The four actions each arrive
  as a `[demo-panel]` message that names the line from the final state:
  - **Approve & use** (a turn): "… is APPROVED by the user … Production line: …".
    Continue from that version.
  - **Approve only** (a quiet note): "… APPROVED … as an alternative and left the
    production line unchanged". Nothing to start; keep working on the line.
  - **Use for next steps** (a quiet note): "… switched the production line to …".
    Work on the new line from then on.
  - **Withdraw approval** (a quiet note): "… WITHDREW the approval of …", with
    what is now blocked by dependency.

  `demo_rec_project status` shows the line and every approved version with its
  lineage.
- **Approval.** You can't approve anything yourself; the user does it in the
  panel. `demo_rec_take propose` only leaves a suggestion for a take. After an
  approval, say what comes next and what it costs, then wait: anything that
  spends credits or model time needs the user's Allow (the panel dialog or `/demo allow`).

**The project's memory** lives in the project, not in this chat:
- **Read it first.** When you (re)open a project, or see a
  `[demo-recording] # Project context …` message, read
  `demo_rec_project context`: the brief, the lineage, and every active input
  (commands, panel reviews, earlier chat directions). Follow it.
- **Record directions as they come.** When the user gives a project-relevant
  direction, source or asset in chat ("keep it under 3 minutes", "here's
  their pricing page", "never show the admin area"), record it right away
  with `demo_rec_project note text=… kind=direction|source|asset stage=…`,
  in their words. One input per note. Small talk and one-off questions are
  not inputs.
- **Withdrawals.** When the user takes a direction back ("forget the
  pricing angle"), mark that input outdated:
  `demo_rec_project mark id=in-NNNN reason=…`. Never re-add it from memory.
- **Already logged:** `/demo discover` and `/demo voiceover` notes, submitted
  panel reviews and inline edits are logged automatically. Don't note them
  again.

## Apps that need a login

The user logs in **by hand** (a password, OAuth, an e-mail link, a one-time code) with `/demo login`, and the saved session is reused by discovery and recordings. You never log
in yourself, never ask for or type a password, a code or a token, and never read the saved state. When `demo_rec_browser open` or `demo_rec_record start` is refused with
"the saved login … has expired", tell the user in one line to run `/demo login` (or use the Project page) and **stop**; start again when they say they have. If the app shows
a login page and there is no saved login, say so and ask them to log in the same way. A login page is never part of a storyboard.

## Discovery method (vision-first)

1. `demo_rec_project status`, then read the brief (`read_brief`) or
   `demo_rec_project context`. Know the persona, **depth** (poc / showcase /
   sales, see the demo-brief skill's depth table), stance, target length and
   goal before you click anything. Depth decides what to look for: poc = go
   deep and capture weaknesses, showcase = breadth, sales = a few outcome flows.
2. `demo_rec_browser open`. If the user started or enhanced discovery from the Project page, a `[demo-panel]` message says so (notes, areas to cover, budget, and for an enhance what to build on): the session then takes THAT request's budget by itself, so just open it; declare the areas in your plan, cover each, and for an enhance read the earlier findings first and say what the new session added. When the budget runs out, stop exploring and say so: the user can extend it from the Project page. The screenshot is the source of truth. The aria
   digest gives exact values and the `{role, name}` targets to use.
3. **Declare your plan.** Right after the first look, call
   `demo_rec_browser plan` with `areas` (the 3–7 parts of the app you intend
   to explore, in order) and `routes` (`{"Search": ["/search"], "Cart":
   ["/cart"]}`: looks and actions on those pages are counted for that area; a
   hash-routed app uses `/#/search`). Progress is MEASURED from what you saw,
   not from your flags: marking an area done (`done: <area>`) does not move the
   bar, and an area marked done with nothing seen is shown as such. Re-declare
   the plan if you change course. An area you will not explore is left out on
   purpose with `drop: <area>` and `why`. **The storyboard is refused** while a
   declared area was never seen and not dropped (the refusal names them): explore
   them, or pass `skipAreas: [{ area, why }]` with the write.
4. **Survey first, then go deep.** Right after the plan call
   `demo_rec_browser survey` ONCE: the engine visits the app's navigation by
   itself (about 2 s a page, no model between the pages, and the pages do not
   use the screen budget) and returns a contact sheet and one line per page
   (headings, rows, and whether it loads more on scroll). Choose from that the
   2–4 areas that serve the brief's goal and spend the budget there. Do not look
   at every page yourself, and do not survey twice (`paths: [...]` surveys only
   the routes you name). Then work economically:
   - **Walk a route in one call**: `act` with `steps: [{step: "goto", url: …},
     {step: "scroll", dy: 700}, {step: "click", target: …}]` (up to 8) runs them in
     order, stops at the first failure and says which, and returns ONE look of
     where it ended. One call per step is about three times slower.
   - **A look repeats nothing that did not change**: the page's unchanged
     navigation is one line ("unchanged since the last look"; its targets are
     still valid). `full_digest: true` sends everything.
   - **A list that loads more as you scroll extends once.** The engine measures
     what a scroll did: the first extension is allowed and noted, then scrolls
     down stay inside what is loaded and the answer says "NOT scrolled". One
     extension is enough to understand such a page: use the rows you have, or
     filter and search. Never try to scroll to the end of it.
   - **A frozen browser is restarted for you.** Every look and action has a
     deadline (Config `discovery.callTimeoutSec`). If the browser does not answer,
     it is diagnosed, killed and reopened on the same page with the saved login,
     and your call returns an error saying so: scroll position and typed text are
     gone. Try the step again once, or take another route; if the same page
     freezes it twice, leave it out and record that as a finding. Do not retry the
     same call in a loop.
   - **A scouting run** (the Project page's first-look preset) is the survey plus a
     few deep looks: write the storyboard proposal from that. The user enhances
     it later if they want more.
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
9. **Record findings as you go.** Whenever something is notable, call
   `demo_rec_project finding` with:
   - **kind:** strength, weakness, friction, value, use-case or length;
   - **evidence:** `screen:<id from the look>`, a URL, or later
     `take:take-006@71.5`.
   One finding per observation, in a sentence the user can judge without
   context. The engine adds its own findings (errors, fallbacks, retries, dead
   time, blocked or state-changing actions).
10. **Length check.** Estimate the demo's length from the planned scenes. If
    it is clearly outside the brief's target length (or the depth default),
    say so and record a `length` finding with a `suggestion` (a new min–max,
    or which scenes to cut or add).
11. **Respect the marks.** The user marks findings in the Project tab:
    - **use:** must appear in the recording *and* the narration. List the
      finding's id in the covering scene's `findings:`. The storyboard write
      warns about uncovered *use* findings.
    - **auto:** your call.
    - **ignore:** never bring it up.
12. **Write the discovery report** when you have finished exploring (also after
    an Enhance, and when the user asks to update it): `demo_rec_discovery
    context` (what you may cite, what the engine measured per area, the rules),
    then `demo_rec_discovery report`: a summary; what you **found** about the app
    (each item cites findings `f-…` or screens `<session>/s…`); what the
    project's **sources** added (cite `file:`/`ref:`/`input:` ids; none if the
    project has no sources); and the **guidance** for the storyboard: use cases
    (the scenes to build), must show, risks (what could go wrong on camera) and
    what to avoid, each with a why and its evidence. A claim without evidence, or
    an id that does not exist, is refused with the reason. Do not claim coverage:
    the engine fills it from what it measured. Then write the storyboard
    following the guidance; the storyboard write tells you if there is no report
    or if it does not cover the newest session.

13. **Ask when you need a decision you cannot make yourself.** Call
    `demo_rec_ask` with `question` (a sentence the user can answer with no
    context), `why` (what it decides or costs), and 2 to 4 `options`, each
    starting with a DIFFERENT word (the user may type that word or the option's
    number in the chat). Then **stop**: the question is shown in the panel and
    the chat, and the user's answer arrives as a message. Do not wait, guess,
    carry on as if it were answered, or ask it again. Use it for a real choice
    (which story first, whether to cut scenes, how to settle two notes that
    disagree), not for what you can decide, and **never to approve, spend or
    replace something**: those are the user's panel actions (Allow, approve,
    Use) and a question cannot do them. At most 3 questions wait at once.

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
- **Emphasis, not annotations.** Mark the moment that matters with
  `emphasis: "<why this moment matters>"` on the step (or the scene), e.g.
  `emphasis: the EMEA outlier is the story`. Don't decide zooms or callouts
  here: the Annotation designer chooses them after the voice-over, from the
  recording, your emphasis hints and what is actually said. The old `zoom:` and
  `callout:` flags still parse, but they become hints and the storyboard write
  warns about them.
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
title: What KeyCraft gets right # title card text, ≤ 60 chars (used if the brief has no Title)
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
    findings: [f-0003]            # findings this scene covers (every "use" finding must be covered)
    # confidence: { score: 2, why: the chart sometimes loads late }   # only where YOU doubt the scene
    steps:
      - { do: hover, target: { css: '[data-kpi="churn"]' }, mark: churn-kpi, dwell: 1.2s }
      - { do: hover, target: { text: EMEA }, mark: emea-bar, dwell: 1.4s, emphasis: the EMEA outlier is the story }
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
      - { do: wait, for: { css: table.regions }, timeout: 15s, mark: results-visible }
      - { do: hover, target: { role: row, name: "EMEA 14.2% 341" }, dwell: 1.5s }
```

**Step kinds:** `goto {url}`, `move|hover|click {target}`,
`type {target?, text, clear?}`, `press {key}`,
`wait {for: target | {ms}, timeout}`, `scroll {target | dy}`, `pause {ms}`,
`improvise {kind: type, target, prompt, max_chars, submit, fallback?, vision?}`.
**Shared flags:** `mark`, `dwell`, `emphasis`. A scene can carry its own `emphasis` too. The recorder logs a layout snapshot after every step and at every mark (`takes/take-NNN/layout.jsonl`), so later stages can point at anything on screen. You don't need to plan for that.
**Targets:** prefer `{role, name}` exactly as the aria digest shows them. Fall
back to `{text}`, `{label}`, and `{css}` last.

`version` is assigned by the tool. Don't set it.

**Confidence (D23, D77):** the panel rates every scene high / medium / low from
measured signals (targets never seen in discovery, css targets, failed takes,
improvised inputs, no `deep_link`, no screen, changes since the last version)
and lists those that "need your eyes" first. Add `confidence: {score: 1–5, why}`
to a scene **only when you doubt it** (an element you couldn't verify, timing
you're unsure of). 1–2 marks it low, 3 at most medium. It never raises a
level, so don't add 4–5 everywhere. Write results and review messages list the
low items first: fix what you can before the user reads it (e.g. verify a
target in discovery, add a `deep_link`).

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
   The user may approve all high-confidence scenes in one click; their marks
   (and any CHANGES) arrive in the same review message.
3. `[demo-panel] … APPROVED` → recording is unlocked. Call `demo_rec_record`: it asks the user to
   allow it and refuses until they do. Tell them in one line what you wait for, then stop.

**The user is asked before money and long jobs.** `demo_rec_tts start` and `demo_rec_record start` are
**refused until the user allows them**: the tool answers "NOT STARTED", files a request with the estimate, and
the panel and the chat show the question *Allow / Deny* (they answer it there, or type `/demo allow`). Say what you are waiting for in one line,
**stop, and do not retry or ask again**: a `[demo-recording] The user ALLOWED …` message arrives when they
answer (a `did NOT allow` note means don't try again unless they ask). The permission is for exactly that
version, for 15 minutes, once. When the user asks in the panel to compare two versions, a `[demo-panel]` message names the pair: call `demo_rec_compare context` (the facts are counted for you), then `demo_rec_compare answer` — be honest, not kind; the tool refuses invented evidence, a better/worse verdict without a measured fact, a missing `against` (your strongest argument against your own recommendation) and a recommendation that contradicts the verdict. You change no version. In the panel, *Request a new take* (its message may carry "Notes on earlier takes": one line per note, `take moment · scene: what the user noticed`; read each, fix what it asks in the next take or say why not, and answer it in your report), a separate designer run and *Generate voice
& render* open a dialog first; a `[demo-panel]` message for them arrives only after the user said yes (for the
take, the click is the permission), so don't ask again. The separate designer starts by itself after the edit
and announces itself (run-and-tell): don't start it yourself.
`demo_rec_tts check` shows the cost of the production line's voice-over before anything is spent.

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

## Suggested fixes for the QA (the fix loop)

When a `[demo-panel]` message says the user **flagged QA findings to fix and asks for suggested fixes** (a fix set, a round), the job is
a short one:

1. `demo_rec_qa context`: the findings they want fixed (in full), their context for this round, what they already decided to leave alone,
   and, on a rethink, the earlier rounds with **their decisions and notes**. Read all of it; do not raise what is already decided.
2. Think about the **cause**, not where it shows. A wrong number and a late narration in one scene often come from one sentence.
3. `demo_rec_qa propose`: **one proposal per stage**, the **earliest stage that needs a fix first**, each saying concretely what would change
   (the sentences, the marks, the steps), why it fixes the findings it names, and what applying it costs. **Group as much as possible: one run at
   one stage should fix as many findings as it can.** A finding you cannot fix goes under `unresolved` with an honest reason. The tool refuses two
   proposals for one stage and a finding nobody answers.
4. Say in one line what you propose, then **stop**. You cannot accept or apply anything. The user may add context and ask you to rethink: then
   call `demo_rec_qa context` again, use their notes and decisions, and propose again.

**Answer structured, never as a paragraph.** Every answer in the fix loop says (1) **which stage** you are addressing, (2) what changes as
**bullets, one per edit** (old → new), and (3) the **next steps from the fix to a new render**, numbered, each with what asks for the user's
Allow and what it costs. `demo_rec_qa propose` enforces the shape (summary ≤ 400 characters, title ≤ 90, why ≤ 320, bullets for the change,
`nextSteps` 2-7 items of ≤ 170) and returns the reply to give, already filled in: use it, at most 12 lines. The same goes for the reply after you
wrote an applied draft (the apply message has the exact shape). The panel shows the same bullets and steps.

When a `[demo-panel]` message says the user **ACCEPTED fix proposals and asks you to APPLY them**: call `demo_rec_qa context` (it lists the
accepted proposals with their own wording and notes), then write **ONE new draft** of that stage with the stage's tool, changing only what they
accepted. **Do not render, do not synthesize, do not touch later stages** (their fixes are kept as pending fixes: read them in the project context
when you write those stages). Stop after the draft; the user reads and approves it.

**Pending fixes.** What the user accepted for later stages waits in the project (`demo_rec_qa pending`, and the project context). When you write
that stage, `get`/`template`/`context` show them first and the `write` result reminds you; take each into account, then settle it with
`demo_rec_qa resolve` (`applied` with the version that carries it, or `dropped` with why) and say which in your reply. The user sees "N pending
fixes for this stage" on that stage's screen and can drop one.

A fix that belongs to the storyboard or to discovery is only a *proposal*: it never starts a discovery or a recording by itself.

## After the take

The narrated video is produced with the **demo-voiceover** skill:
`demo_rec_take analyze` → `demo_rec_take propose` → `demo_rec_vo template/write`
→ the user approves in the panel's Voice tab → `demo_rec_tts` → `demo_rec_edit`.
Then the **demo-annotations** skill suggests the visual emphasis
(`demo_rec_annotations context` → `suggest`); the user reviews and approves it in
the Annotations tab. Then offer a **final render** (`demo_rec_render action=start
kind=final`, asking which brands and whether to burn in subtitles); the edit
itself only makes drafts. The user approves the deliverable in the Render tab.
Shortcuts the user may type: `/demo voiceover`, `/demo render`, `/demo voices`,
`/demo config`. For settings questions use the **demo-config** skill.
