# Running plan: what is done, what is next, what is later

**The one place that says where we are and what comes next.** Everything else is detail behind it: the history in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), the findings in [REAL_RUN_FINDINGS.md](REAL_RUN_FINDINGS.md) and
[REAL_RUN2_FINDINGS.md](REAL_RUN2_FINDINGS.md), the decisions in [VISION.md](VISION.md) and [PLAN_QA_CHANGE.md](PLAN_QA_CHANGE.md), the later
phases in detail in [ROADMAP.md](ROADMAP.md), the ideas not scheduled in [FUTURE_IDEAS.md](FUTURE_IDEAS.md). If this page and another disagree,
this page is right and the other one is out of date: fix it.

Last updated: 2026-10-19, after the run 2 grill. Last merged before this page: #110. Item 2 (small fixes) merged as #112, #113 and the 2c PR. The suite at #108: 795 tests passing, 3 skipped.

## 1. Where we are

The engine, the panel and the first quality change are built and accepted: a real-app run (run 1) found 32 findings, P1 (the QA change) answered
them, and a second real run (run 2) accepted P1 and produced 12 more findings, which were grilled into the order below. **Nothing is half-built on
`main`.** The next piece of work is item 11 (P4, the Director in the open).

## 2. Done

| Area | What exists | Merged |
|---|---|---|
| **The pipeline (S0 to S5)** | brief, discovery, storyboard, the recorded take (human cursor, improvised inputs, resume), the voice-over written from the take, voice (ElevenLabs, OpenAI, local fallback), the audio-led edit, annotations (zoom, highlight, spotlight, callout, chapter, redaction), brands, final render with variants, QA, confidence signals, config | before the run-1 plan |
| **The control room (UX0 to UX19)** | the frame (stepper, band, strip, Activity), versions and approval, the project map, review workspaces, config search, brands editor, anchors under the narration, the user guide and a 101 | #88, #89 |
| **Run 1 and the plan** | 32 findings, the QA grill (D-QA-1 to D-QA-11), the roadmap | #90, #91 |
| **P1a Safety and truth** | the agent cannot approve; spending (voice, a take) needs your Allow (`/demo allow`, the panel's bar); the environment-override warning; QA diagnostics; the calibration test; narration anchors snapped to speech onsets | #92, #93, #94 |
| **P1b QA is a report** | hard stops only for broken files and a leaking redaction; a report with levels and "needs your eyes"; the checks popup; finding identity and ignores with scopes and reasons; run-and-tell notifications | #95, #96, #97, #98 |
| **P1c The fix loop** | the Director's work visible (band, strip, Activity); flag findings, ask for suggested fixes, decide, rethink; apply as ONE new draft at the earliest stage with pending fixes for later stages; the stage writers read and settle them; **timing hints `[@mark +300ms]`**; the render overrides retired | #99 to #104, #108 |
| **Panel work from the first use** | "Quality check" is not "Render"; the Render preview two fifths wide and pinned; the fix loop as a window; structured Director answers | #105, #106, #107 |
| **Run 2** | the run guide, P1d re-scoped, 12 findings collected, the grill | #109, #110 |

## 3. The plan, in order

Statuses: **done**, **next**, **planned**, **later** (needs something first), **you** (your time). Days are sequential for one person (S about 1,
M 2 to 4, L about 5 to 6): an order of magnitude, never a date. Σ is the running total.

| # | Work package | What changes for you | From | Status | Days | Σ |
|---|---|---|---|---|---:|---:|
| 1 | **Docs: decisions and the running plan** | the decisions recorded, this page, the early checks described and moved to the long tail | the grill | done | 1 | 1 |
| 2 | **Small fixes** (2a, 2b, 2c) | a missing brand falls back and a failing draft only warns (2a); the review buttons show their state with Revoke (2b); the voice button says it makes a draft (2c) | R2-8, R2-6, R2-7 | done | 2 | 3 |
| 3 | **List screens** | Voice over, Annotations, Storyboard: list 22rem, wrapping titles, the detail column pinned until the list ends (absorbs L1) | R2-5, R2-9, F19, F20 | done | 3 | 6 |
| 4 | **Docked Activity drawer** | 22rem, squeezes only the main content, remembered open, Render keeps two columns (absorbs L3) | R2-12, F7 | done | 2 | 8 |
| 5 | **Suggestions** | the band hides at its target; a header "Suggestions · N" | R2-11 | done | 2 | 10 |
| 6 | **Config** | edit the project value on the row; staged edits, one combined review | R2-1, R2-2 | done | 4 | 14 |
| 7 | **Recording review (R0 + R1)** | chapters with snapshots as navigation, a smaller pinned player, goal and findings above it, timestamped notes | R2-4, F10 | done | 8 | 22 |
| 8 | **Voice-over filmstrip + step through annotations (R2, L2)** | all the scene's frames under the narration, used and "not mentioned"; Previous / Next on annotations | F16, F19 | done | 4 | 26 |
| 9 | **Compare versions (narrowed L6)** | Advanced, compare two versions, an honest verdict naming its evidence; storyboard and voice-over first | R2-3, F14 | done | 5 | 31 |
| 10 | **P3 Discovery you can steer and read** | start or enhance from the Project page, a discovery report, measured progress, an enlarged live preview | F1, F2, F3, F5, F6 | done | 12 | 43 |
| 11 | **P4 The Director in the open (rest)** | a pending question answered in chat or panel; role labels in the chat | F18, F23 | **next** | 7 | 50 |
| 12 | **P5 Small options (rest)** | the logo bug option explained; zoom limits as settings | F28, F21 | later | 4 | 54 |
| 13 | **Run 3** | a full run on a different app, every screen at 1400 and 900 px | | you | 2 | 56 |
| 14 | **S7 Login and sessions** | required for v1, with the session checks | F4 | later | 8 | 64 |
| 15 | **S6 Parallel discovery lanes** | opt-in, built on item 10's measured progress | F6 | later | 6 | 70 |
| 16 | **S8 Native capture** | optional | | later | | |

What moved on the way: L1, L3 and L6 are absorbed into items 3, 4 and 9; the early checks and the discovery checks left the plan (long tail,
section 6); the filmstrip and step-through (8) follow the recording review (7) because they reuse its chapter and frame component.

## 4. The next items in detail

Each item is its own branch and PR (or a few, where stated), with tests, a docs update, before and after screenshots at 900 and 1400 px where the
panel changes, and CI green before merge.

**2. Small fixes** (three PRs, the decisions D-R2-3 to D-R2-5). **2a, 2b and 2c are done.**
- **2a, the brand (R2-8), done.** A helper resolves the default brand: the configured one when it exists, else the built-in `neutral`, saying so (a
  warning on the render, in the Render screen's Warnings, and in the edit report the Director gets; there is no separate Activity line); an explicitly chosen brand still fails fast. The draft render after the edit runs
  in its own guard: if it fails the edit still reports its numbers and hands over to the annotations, with "the draft failed: <why>" and a
  re-run. `/demo doctor` and Config warn when the configured brand is not under the current root. Test: a root without the configured brand ends
  with the edit report, a neutral draft, the warning and the annotation hand-off; an explicit unknown brand still fails.
- **2b, the review buttons (R2-6), done.** Mark reviewed / Needs changes / Re-run keep their names and get one line each saying what they do. Once one is
  chosen it is highlighted and is the state, with **Revoke**; the others stay available to switch; the state is also a badge in the section
  header. Storyboard and Voice over (one shared component). Test: for each status the pressed look differs (measured, both themes, both widths),
  the header badge and the list row agree, a second click or Revoke clears it, a reload keeps it. If the reading "highlighted plus Revoke, the
  others stay" is wrong, change D-R2-5 before building.
- **2c, wording (R2-7), done.** The voice button reads "Generate voice, edit and a draft to watch", and the cost dialog says the same. No setting.

**3. List screens** (D-R2-6), **done.** One change in the shared split layout (`.ds-split`) for Voice over, Storyboard and Annotations: the list is
22rem (was 20rem); a row's title is a wrapping block (up to three lines, the whole text on hover), because it was an inline span where `overflow`
does nothing; the detail is ONE pinned block under the header (`--hwrap-h`) holding the inspector, which scrolls inside it when it is tall, and the
action bar at its bottom (the bar had to move into the block: left outside it, it stayed behind in the middle of the pinned inspector), released at
the end of the list; the narrow layout (list behind a select) is unpinned and unchanged. The detail cell became a column (a sticky child of a grid
item can only move inside its own track). Tested with 40 rows of long text on each screen at 1400 and 900 px (list width, nothing past the edge,
wrapped to two or three lines, pinned at the line while scrolling, never below the strip, released at the end) and at 700 px (a select, nothing
pinned). **Not done:** the Brands editor shares the layout and gets the wrapping, but not the pin (its list is short); Annotations' Previous / Next
is item 8.

**4. Docked drawer** (D-R2-7), **done.** The page below the header is a row of the screen and the drawer (`.ds-body`); the drawer is a sticky 22rem
column from a 76rem window up (the list screens' 52rem narrow limit plus the drawer), an overlay below that; the header, the band and the strip
keep the full width, so `--hwrap-h` and every pin are untouched. The open state is stored when you toggle it and restored after a reload without
taking the focus; the system never opens it; Escape, focus back to the strip button and the contents are unchanged. **Deviation from the decision:**
Render's two-column limit is 56rem, not "about 60rem", so a 1280 px window keeps two columns with the drawer open (at 60rem it needed 1344 px);
between 1216 and 1279 px Render is one column while the drawer is open. Tested at 1400, 1280, 1100 and 900 px (full-width header and strip, the
main content narrower by 352 px and never under the drawer, the drawer between header and strip, Render's columns, the overlay below 76rem) and
the remembering. The old test of the overlay decision (D101) was rewritten. **Not tried on the real project;** the 22rem width is as decided.

**5. Suggestions** (D-R2-8), **done.** `bandHiddenAt(band, tab)` is true only for a "needs you" band whose target is the page you are on (Blocked,
Director working, Running and Done never hide). The band is collapsed, not removed (a grid row going to 0 in 0.18 s, `inert` so the keyboard cannot
reach it), so the header block shrinks and `--hwrap-h` follows; the pinned panels move up with it (tested). The header gets a **Suggestions · N**
menu (`suggestions(band, tab)`: the current suggestion, a stop, then what else waits; the one on this page is marked "you are here"; links only;
Escape, a click elsewhere or choosing one closes it; nothing stored). **Header room:** the new entry did not fit, and the stepper's labels used to
overlap the tools between about 1024 and 1260 px, so the header now gives up in three steps: below 96rem "Suggestions" is an icon and the count,
below 85rem Map and Config keep only their icons, below 80rem the step labels hide (all still read by screen readers; they used to hide at 64rem).
Checked for overlap at 1600 to 900 px. **Measuring:** the controls count (`scripts/ux-measure.ts`) counted the links inside a closed menu, which are
not shown; it no longer does (the menu on the band was counted too, so Annotations went 37 to 34 of its own). **Not tried on the real project;**
the 96/85/80rem steps are measured on the seeded one at the Macchiato theme only.

**6. Config** (D-R2-9). With a project open a row edits that project's override, labelled "Editing for <project>"; the global value is under
Scopes. Edits are staged; a "N changes: Review and save" bar opens one combined diff; one write per file. The backend needs a batch endpoint that
composes several changes to one file in memory, validates all of them and applies none if one fails. Leaving with unsaved edits asks; an
environment variable that wins is still said per line. **Risk:** staged edits against the search and the quick filters.

**Done.** `planBatch` / `applyBatch` (`src/config-edit.ts`) compose the changes per file in memory and run the real resolver after EACH change, so a
refusal names its setting (`fps: …`); nothing is written unless all pass, then one atomic write per file; `POST /api/config-batch` plans without
`confirm` (one diff per file, what each change does, per-change shadowing) and writes with it, publishing one `config.changed` per change so the log
reads as before. `config-set` stays (the Director's tool and old callers). In the panel (`config-stage.js` is the store: one staged value per
setting and scope, a newer one replaces the older, putting the saved value back unstages it) a row's own button is **Edit for <project>** (or
**Edit** with no project, or for a global-only setting), the editor says "Editing for <project>" and its button is "Stage change"; Scopes keeps
all four layers and their actions, now staging too; a staged row says "Staged · project: 24" with Discard; a sticky bar at the foot says "N changes
staged · Review and save · Discard all". Review is one dialog: the list "key (scope): before → after", a warning per change that a project override
or an environment variable hides ("no effect right now"), one diff per file; Cancel keeps everything staged. Staged edits survive Settings ⇄ Brands;
a click on a link to another screen asks ("Leave Config with N changes not saved?"), a reload gets the browser's warning, and staged project edits
are dropped (and said) if another project opens. **Not done / uncertain:** staged edits are not kept across a reload (said by the warning); a
Back-button navigation is not asked about (only links are); the search hides a staged row but the bar still names it; the old per-setting dialog
is gone (the review shows the same diff for all). Five old browser tests ended in the per-edit dialog and now go through the bar. **Not tried on the
real project.**

**7. Recording review** (D-R2-10). **R0** the shared chapter and frame component (frames: the start, each mark, the end; a click seeks; "used /
not mentioned" for the voice-over later). **R1** three columns: the chapters and frames (about 25 %), the smaller pinned player (about 50 %) with
the Director's comment and the scene's goal and findings above it (the storyboard scene's findings and what the take found: toasts, resumes,
fallbacks, dead time) and chapter marks on a thin bar under the video (native controls cannot host marks), and timestamped notes (about 25 %):
`+` adds a note at the current time and chapter, notes are editable, stored per take, reach the Director as a review message and the input log, and
feed "Request a new take". **Risk:** notes are a new concept; the `+` key must not clash with typing.

**Item 7 in three PRs** (notes decided: review input, bundled into the Director's message on "Request a new take", nothing sent as you type; the add-note
key works only while focus is in the player area and never in a text field, the button always works):
- **7a, R0, done.** `src/analysis/review.ts` (`reviewScenes`) builds per scene of a take its frames (start, each mark, notable events such as a toast, end;
  time order, file only when it exists), the storyboard scene's goal (`takeaway`, `emphasis`, outline), the findings it names, and what THIS take found
  there (the engine's findings: errors, fallbacks, dead time, resumes, placed by scene or by time); `GET /api/recordings` carries it as `review`.
  `chapters.js` is the shared component (`Chapters`: chapters with frame thumbnails, a click calls `onSeek(ms)`, the playhead marks the chapter and the
  frame, an optional `note(scene, frame)` for the voice-over's "used / not mentioned"; buttons are disabled when there is no video). The take card shows
  it under the player in place of the one-frame-per-scene grid; a click shows the player and seeks. **Not yet:** the three-column layout, the small
  pinned player, goal and findings above it (7b), notes (7c). Tested with a real video (a click seeks, the playhead moves the marker).
- **7b, R1, done.** The take cards became one line each (with a **Review** button; the workspace shows the picked take, else the one you are viewing, else
  the production line's, else the newest). The workspace is two columns (chapters about 40 %, the pane 60 %: decided because three would leave about 260 px
  for the chapters with the drawer open; the notes column joins in 7c): the pane is pinned below the header block and holds, top to bottom, the chapter you
  are in (goal and emphasis from the storyboard, the findings the scene names with their state, what this take found with its time, each a click to seek), the
  player (at most 40 % of the window height, always there, no "play raw take"), and the chapter bar (one segment per scene on the take's own time line, a
  click seeks, the playhead on top). `[` and `]` go to the previous / next chapter while focus is inside (never in a text field; in the "?" sheet and the
  tour). Below 52rem the columns stack, the player first and unpinned (the list screens' rule). **Decided with you:** no per-take "Director's comment" (the goal
  and findings carry it), "Request a new take" stays at the top. **Not done / uncertain:** a pane taller than its chapter list cannot move (a take of two or
  three short scenes has nothing to pin against); the chapter bar has no ticks for the findings; not tried on the real take.
- **7c, done.** Timestamped notes (decided: review input, nothing sent as you type). `src/recording/notes.ts` keeps them per take in
  `takes/<take>/notes.json` (id, time on the take clock, the scene, text up to 1000 characters; a sent note records which request carried it and is then
  read-only, though it can still be removed and Undo brings it back as it was). Routes `take-note-add / -edit / -delete / -restore`; `GET /api/recordings`
  carries each take's `notes` and `openNotes`. **Request a new take** bundles every open note of the storyboard's takes (take, moment, scene, text) into the
  Director's message and the input log (with `refs` to the notes), marks them sent, and never carries one twice. In the panel: **Add note at 0:23 · 02-search**
  under the video, or `N` / `+` with focus inside the workspace (never in a text field): the video pauses and the moment is fixed when you start; Ctrl/Cmd+Enter
  saves, Esc cancels; a note has a time chip that seeks, Edit, Delete with an Undo toast; "N open notes will go with it" next to the request button. The notes
  are a third pinned column from a 72rem container, else under the chapters, and between the player and the chapters when the columns stack.
  **Not done / uncertain:** notes are not offered to the voice-over writer (decided: new take only); nothing checks that the Director acted on a note; the
  composer is not kept if you navigate away before saving; not tried on the real take. **Item 7 is done.**

**8. Filmstrip and step-through** (two PRs), **done.**
- **8a, the voice-over filmstrip (F16).** `sectionFrames` (`src/panel/anchors.ts`) reads the same analysis as the recording review and returns every frame of
  the section's scene in time order (start, each mark, notable moments, end; a still only when it exists), an intro showing how the first scene opens and
  an outro how the last one ends, a bridge nothing. In the panel `FrameStrip` (in `chapters.js`, the 7a component's frame style) shows them under the
  narration; **which marks are used is read from the draft text as you type** (`marksSpoken`), so inserting one turns it "used" at once: a used mark says ✓
  and the first nine words it pins, an unused one says "not mentioned in the narration" and is a button that inserts `[@mark]` at the cursor (a space before
  and after, the box keeps the focus and the caret after it; where the box never had the cursor, at the end). The "At each anchor" cards stay as **Timing at
  each anchor** (time, page text, nudge) without repeating the picture. **Decided with you:** notable moments are shown (labelled, not clickable), the
  cards stay, click inserts.
- **8b, annotations step through (F19).** Previous / Next buttons flank the preview, "4 of 21" under it (with "shown (N in all)" when a filter hides some),
  disabled at the ends; they follow the filtered, grouped list and the selection and the address follow; `[` and `]` do the same with focus anywhere in the
  screen except a text field or over a dialog.
- **Not done / uncertain:** the strip's picture of a used mark is the take's still, not the narration's timing (the cards keep that); nothing re-checks the
  order of an inserted anchor until the version is validated, as before; an annotation whose list row is out of view is not scrolled to by the keys; not
  tried on the real take. Tested: `vo-filmstrip.test.ts` (frames, pins, intro and outro, a browser walk with the insert at the cursor) and
  `annotations-step.test.ts`; `ux19-anchors` now checks the cards without a picture.

**9. Compare versions** (D-R2-11), **done (9a the facts, 9b the Director's verdict).** Two PRs, decided with you; stored verdicts are reopened per
pair of versions ("Advanced shows how many", asking again replaces after asking), and the recommendation offers a "Use vN for next steps" button, not a link to
the fix window.
- **9a, done.** `src/compare/facts.ts` (`compareVersions`): deterministic and free. Storyboard: scenes, steps, marks, improvised inputs, scenes with a goal,
  findings covered, a title change; per scene added / removed / changed (with what: title, takeaway, emphasis, steps 1 → 2, marks, findings, outline) /
  unchanged, and a scene order change. Voice-over: sections, words, anchors used, speech estimate against usable footage, scenes where speech runs well over the
  footage, warnings, the recording it was written from when it differs; per section added / removed / changed (`words 19 → 19 (+2 −2)`) / unchanged. It also
  returns `evidence`: every id a verdict may cite (`fact:<id>`, `scene:<id>`, `section:<key>`, `order`). `GET /api/compare?stage=&a=&b=`. In the panel an
  **Advanced** menu (storyboard and voice-over, from two versions on) opens **Compare two versions…**: from / to (defaults: the production line's version
  against the one you are viewing, else the newest other), a swap, the facts table with the difference, the changes with a word and an icon each. Nothing
  is spent. (`api()` now shows the server's own error text instead of a status code.) **Not done:** the verdict (9b); recording, annotations and render.
- **9b, done.** `src/compare/verdict.ts` and the tool `demo_rec_compare` (context, answer; classified "free" and "proposal" in the ratchet). Asking
  (`POST /api/compare-ask`, cost class "turn") stores the ask for the pair (`compare/<stage>.v<a>-v<b>.json`, one per pair; asking again replaces it) and sends the
  Director the pair and the rules; the Director reads `context` (the facts and the ids it may cite) and calls `answer`. **Decided with you (strict):** the tool
  refuses, listing every problem at once, a verdict outside better / worse / different / no meaningful change; a headline over 140 characters; fewer than 2 or
  more than 6 points; evidence that is not in this pair's facts (the valid ids are listed in the refusal); fewer than 2 different pieces of evidence; a
  better or worse verdict without a measured `fact:` id; a missing `against` (the strongest argument against its own recommendation); a recommendation that
  contradicts the verdict (better with a or neither, worse with b or both). In the window: ask, "Waiting for the Director…" with "Give up on this ask", the verdict
  with its points as chips (a click jumps to the fact and flashes it; the facts it cites are marked), the argument against, the recommendation with
  **Use vN for next steps** (the existing Use action, no link to the fix window), **Ask again** (asks first, replaces) and **Advanced → Past comparisons (n)**.
  `compare.answered` is a run-and-tell event for the stage compared (`tab` may now be a function of the event). **Not done / uncertain:** nothing re-checks
  that the Director's claims are true beyond naming evidence that exists; a Director that stops without answering is only noticed by you (Give up, ask
  again); recording, annotations and render; never run against a real model's answer (a scripted answer in the tests); not tried on the real project.
- **9b, the original plan:** Advanced, "Compare two versions…" on storyboard and voice-over. The engine supplies the facts from the existing
diffs; the Director answers through a validated tool that refuses an answer without a verdict, the evidence it names (a scene, a section, a
number) and a recommendation; the note is stored in the project, linked to both versions, a visible Director turn that costs tokens and needs no
Allow, and can feed the fix window.

## 5. The later phases in outline

Details and slice sizes are in [ROADMAP.md](ROADMAP.md#w3-discovery); only the shape is here.
- **P3 Discovery (10), done (D4, D1, D3, D2).** The estimate of 12 days held (D4 half a day, D1 about 2.5, D3 and D2 about 4 each, as re-checked slice by slice).
  - **D4, the enlarged live preview.** The drawer's preview is a button that opens a larger window rendering the same source (the newest discovery screen
    or the polled live frame of a take), so it keeps updating; Escape closes it and the focus goes back. Tested with two real screens arriving while it is
    open; the recording case uses the same component and is not tested separately.
  - **D1, Project → Discovery.** Where discovery stands (not started, running, done, budget used, cut off), the sessions with what each used against its
    budget and how it ended, and **Start discovery**, **Enhance…** and **Extend the budget…** (twice what the last session had) in one window: notes, areas,
    a budget choice (quick = half, standard = Config, deep = double, or three numbers up to 200 screens / 800 actions / 120 minutes), and for an enhance
    which session it builds on. It is a request stored in the project (`discovery-requests.json`, one waiting at a time, "Take it back") sent to the
    Director with the notes, the areas and what to build on and not repeat; `demo_rec_browser open` takes the request's budget instead of Config's and a
    session writes `session.json` when it opens and closes (budgets, usage, whether the budget ran out), which is how the page says why it stopped; older
    sessions are read from their action log without budgets. Costs model tokens and browser time, no money; refused while a session runs. **Not done:**
    "sources" are the existing Sources & context group, not a field in the window.
  - **D3, measured progress** (`src/discovery/measure.ts`). Every look and action in the session's log is attributed to an area by the **route hints** of
    the plan (the longest route that prefixes the page's path; `/#/x` for hash routes; `/` is only home), else the area in hand, else "unassigned"; what
    happened before the plan is attributed by route when the plan arrives. Per area: looks, actions, and a state (seen and done, marked done with nothing
    seen, in hand, seen, not yet, left out with its reason). The bar is by that: a flag alone moves nothing, "marked done, nothing seen" is dashed and says so
    in words, a dropped area is struck and says so, the budget is still a floor. `demo_rec_browser plan` takes `routes`, `drop` + `why`;
    `demo_rec_storyboard write` is **refused** while a declared area of the latest session was never seen and not dropped (it names them; `skipAreas:
    [{ area, why }]` leaves them out with a reason kept in the log; a storyboard written since the session began ends the asking; sessions without a plan
    are left alone). The panel: an **Areas** table (state, looks, actions, routes, why dropped, pages nobody claimed), a "Not seen yet" notice, and in the
    drawer **"No activity for 2 min"** after 90 s without a look, action or plan change, or "The Director has stopped, but the session is still open" 15 s
    after its run ended with the session open: icon and words, never an error. **Decided with you:** route hints with the current area as fallback; refuse
    until covered or dropped with a reason. **Guesses:** the 90 s and 15 s; "about done" for the area in hand is 12 looks plus actions; a Director that gives
    no routes gets everything counted for the area in hand.
  - **D2, the discovery report** (`src/discovery/report.ts`, the tool `demo_rec_discovery`: context, report, get). A project artifact, versioned and immutable
    (`discovery-report/report.vN.json`), written by the Director at the end of every discovery (after an Enhance too, as a new version) and when you ask
    ("Ask the Director to write / update the report"; a Director turn, model tokens only). Structured: a summary; what it **found** about the app (2 to 12
    items, each citing findings `f-…` or screens `<session>/s…`); what the project's **sources** added (each citing `file:`, `ref:` or `input:`; required
    when the project has sources, and it must be empty when it has none: nothing is invented); and the **guidance**: use cases (1 to 6), must show, risks,
    avoid, each a title, a why and evidence. The tool **refuses**, listing every problem, a claim with no evidence, an id that does not exist (the valid kinds
    are named), a finding cited where a source belongs and the other way round, and the length limits. The **coverage is the engine's**: it is filled from what
    was measured per area (D3), whatever the Director says. The project context carries the report's summary and guidance, the storyboard write says
    whether there is a report or whether it misses the newest session (a warning, **no gate**: decided with you, D3 already gates the areas), and the
    storyboard screen says "Based on discovery report vN" (the newest stored before that version was written). Project → Discovery shows the report with its
    versions, every claim with its evidence as chips (a finding or a screen opens a **popup first**: the finding with its marks, its own picture and where the report uses it, the screen large with the findings that cite it, each with a way on: **Go to this finding** in the Findings list, scrolled to and marked whatever its filters, or **Open full size**; a source goes straight to its file or link; added after your first look at it), a notice when sessions ran
    after it, and the coverage line. **Not done / uncertain:** never run with a real Director; the report is not searched or compared (compare is the long
    tail); "based on" for a storyboard is by time, not recorded at write; not tried on the real project.
- **P4 The Director in the open (11):** A4 a pending question owned by the engine and answered in chat or panel (L), A5 role labels in the chat
  (S to M). The docked drawer (L3) moved to item 4.
- **P5 (12):** L4 the logo bug option explained (S), L5 zoom limits as settings (M). Compare (L6) moved to item 9.
- **Run 3 (13):** a full run on a different app, no login yet, every screen at 1400 and 900 px; its findings feed S7, S6 and S8.
- **S7 (14):** `/demo login`, a login probe, re-login on expiry, session checks before discovery and recording; needs the real app. **S6 (15):**
  parallel discovery lanes, opt-in, one bar per lane. **S8 (16):** native capture, optional.

## 6. Long tail (not scheduled)

The thin **early checks** (P1d; described in [FUTURE_IDEAS.md](FUTURE_IDEAS.md#early-checks-thin-config-gated-informational): informational only,
a switch per phase, off by default), the **coherence review** (Q8), **extra QA checks** (Q9), **discovery checks** (QS-disc), **compare** for
recording, annotations and render, a **stored suggestion history**, pending fixes **superseded** and **stale**, a **map node** for fix sets, a
**setting for the draft after the voice**, and the two flaky tests ([KNOWN_ISSUES.md](KNOWN_ISSUES.md)). Each says in FUTURE_IDEAS what would make
it worth building.

## 7. Where the decisions are

| Decisions | Where |
|---|---|
| The run 2 grill: D-R2-1 to D-R2-12 | [REAL_RUN2_FINDINGS.md](REAL_RUN2_FINDINGS.md#the-run-2-grill-decisions-d-r2-1-to-d-r2-12) |
| D135 to D139: the docked drawer (supersedes D101), config staging (amends D125), the band, the review state, early checks | [VISION.md](VISION.md) |
| The QA change: D-QA-1 to D-QA-12 | [PLAN_QA_CHANGE.md](PLAN_QA_CHANGE.md) |
| The product decisions D1 to D134 | [VISION.md](VISION.md) |

## 8. Rules and keeping this page true

- Every slice is its own branch and PR, squash-merged after CI is green; nothing is pushed or merged without your say-so; you approve, the
  agent proposes. Tests and a docs update come with the change.
- **Every PR that finishes or changes a work package updates this page in the same PR:** its status, the Σ, and what moved. A test
  (`test/running-plan.test.ts`) keeps the day arithmetic and the links honest; it cannot tell if a status is true, so do not skip this.
- New ideas and findings are collected in a findings document (as run 1 and run 2 were) and acted on only after a grill with you.

## 9. Open points to confirm

- **D-R2-5, the review buttons:** recorded as "chosen = highlighted state with Revoke, the others stay available". Confirm before 2b is built.
- **Item 4:** the drawer width and the Render limit are guesses until tried on the real project at 1400 px.
- **Item 10:** the 12 days.
