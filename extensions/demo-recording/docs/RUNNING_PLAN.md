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
`main`.** The next piece of work is item 15, S7 (login and sessions), which needs the real app that asks for a login. Items 13 and 14 (the run-3 findings worth fixing before a real test, and a Projects page with archive) are done. Run 3 is item 16, behind S7.

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
| **P5 Small options** | the Logo bug option of a render says what it does (and is disabled when no look shows one); the zoom limit is two settings, zooms per minute and per scene | 12a, 12b |
| **P4 The Director in the open** | the Director asks a question and stops; you answer it once in the panel or by typing its number or word in the chat; the Allow for a spend is such a question; every message carries its role | #130, #131, #132, 11c |

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
| 11 | **P4 The Director in the open (rest)** | a pending question answered in chat or panel; role labels in the chat | F18, F23 | done | 7 | 50 |
| 12 | **P5 Small options (rest)** | the logo bug option explained; zoom limits as settings | F28, F21 | done | 4 | 54 |
| 13 | **Run-3 prep (A to D)** | Voice over buttons say what happens (A); the Recording request box at the bottom (B); Recording keys on the whole tab (C); the storyboard picture beside the text (D). Four small PRs | R3-6, R3-4, R3-3, R3-1 | done | 4 | 58 |
| 14 | **Projects page and archive (E)** | list, switch, archive and delete projects in the panel (a delete is a verified zip first); `/demo archive` | R3-7 | done | 3 | 61 |
| 15 | **S7 Login and sessions** | required for v1, with the session checks (needs the real app that asks for a login) | F4 | **next** | 8 | 69 |
| 16 | **Run 3** | a full run on a more complicated app (the one S7 is for), every screen at 1400 and 900 px (your time) | | you | 2 | 71 |
| 17 | **S6 Parallel discovery lanes** | opt-in, built on item 10's measured progress | F6 | later | 6 | 77 |
| 18 | **S8 Native capture** | optional | | later | | |

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

**11. P4, the Director in the open** (D140 to D144, grilled with you after the spike [spikes/P4-message-hooks.md](spikes/P4-message-hooks.md)). Three PRs:
- **11a, the question (done).** The engine's **pending question** (`questions.json` in the project: id, the role that asks, what, the options with their words and
  numbers, the cost, status, who answered and where). A Director tool `demo_rec_ask` creates one and **returns at once** ("asked q-3: stop; the answer
  arrives as a message"). A panel route resolves it; the answer is sent to the Director as a new message whichever place it came from (D143). The panel
  shows it in the band ("Needs you") and as a dialog, and it is an Activity entry. One resolution only; a second answer is told "already answered by
  <place>". **Built:** `src/questions.ts` (2 to 4 options, a number and the first word of the label each, the words must differ and may not be numbers, at
  most 3 waiting, no duplicate waiting, `wordOf`, `pickOption`, `answerQuestion` once with the first answer standing, `cancelQuestion`), the tool
  `demo_rec_ask` (ask, pending; classified "proposal" and "free" in the ratchet; it returns at once and tells the Director to stop), `GET /api/questions`,
  `POST /api/question-answer` (wakes the Director with a message that carries the question, the option and the place; a wrong option, an unknown id and a
  second answer are refused with the reason, the second one naming who answered first) and `question-cancel` (a quiet note); the project context lists what waits
  and the last answers, so a fresh Director after a restart knows. In the panel: the question sits in the "The Director asks" bar (the role, the question,
  why, a button per option with its number, Dismiss, and the line that says what to type in the chat), in the band ("The Director asks": it outranks what else
  needs you and the Director working, not a block; it is never hidden) and in the header's Suggestions. The events are class "ask". **Not yet:** the chat
  (11b) and the roles (11c); the answer is the panel's only until 11b.
- **11b, the chat (done).** The question is a labelled chat message (a custom message with its own renderer: the role, the question, the options with numbers). An
  `input` handler resolves a pending question from your reply **only** when the source is `"interactive"` and the reply is exactly an option's number or
  word, and then swallows it (D141); anything else is normal chat. The Allow for a take or a voice (today a panel click or `/demo allow`) becomes a pending
  question too, so "1" or "allow" in the chat allows it and a click answers it in the chat; the one-use, 15-minute grant is unchanged. No timeout (D142); aborting
  the run cancels what is pending. **Built:** `src/question-chat.ts` (the `input` hook: your own typing only, exactly one option of exactly one waiting question, then
  swallowed and answered; a fit with several is ambiguous and stays chat; a message renderer for the question), `src/question-flow.ts` (`answerFor`: one resolution for the
  panel and the chat, the grant issued or refused for a spend question, the Director woken; `settleGrantQuestion`: the old Allow / `/demo allow` answer the question too),
  `Runtime.publishQuestion` (the labelled chat message, no turn), the Allow for a take or voice filed by `askFirst` as a question (Allow / Deny, one per request, not counted
  against the 3-question limit, still answerable after a restart because the question carries the kind and target), the old request block hidden while its question shows,
  and an aborted run cancelling the questions it asked (`cancelRunQuestions`; the Allow stays). **Tests:** `test/question-chat.test.ts`, 7 tests, including a real pi session
  with a scripted model for the reply rule. **Not verified:** how the question message looks in a real TUI (the renderer is only registered, not seen); a real model's
  behaviour after the answer.
- **11c, the roles (done).** Every message the extension sends gets its role as a prefix (the `[demo-*]` messages, job results, QA, the questions); the same role
  names in Activity and in the Director-working state; a rule in each skill for the model's own text ("start a block with your role once"). Nothing is
  written into the model's history (D144). **Built:** `src/roles.ts` (the cast, `reportAs(role)` → `[demo-recording · Cutter]`, `PANEL_PREFIX` = `[demo-panel · You]`, `roleOfTool`,
  `PREFIX_SOURCE` that reads both the old and the new form); every report now names who speaks (record → Operator, voice synthesis → Voice writer, edit and render → Cutter, QA →
  QA reviewer, the designer → Annotation designer, what you did in the panel or the chat → You); the Director's steps carry the role (`director.step`, the band "… · Voice writer:
  Writing the voice-over", "The Director as Voice writer is …", Activity); each of the six skills has the rule "start a block with your role once"; nothing hooks the model's
  messages. **Tests:** `test/roles.test.ts` (7, including a scan that no source line still starts a message with a bare tag). **Not verified:** whether a real model obeys the skill
  rule (it is a request, not enforced); the project context message stays unlabelled (it is hidden).
- **Not changed:** approvals, Use, "replace a verdict", discovery start and the other gates stay panel actions (D140). **Risks:** the exact-option rule is
  strict on purpose and may feel stiff; the model's own labels depend on it obeying; a question asked in one session and answered after a restart reaches a
  fresh Director that must be told what it was about (the message carries it).

**Item 15, S7 login and sessions (D147; four small PRs; spike [S7-login.md](spikes/S7-login.md)).**

- **7a, spike and decision (this PR).** What a saved state keeps and what an expired session looks like (real Chromium, a fixture with a cookie, localStorage, sessionStorage and IndexedDB login).
- **7b, the engine and `/demo login`.** `src/auth/`: the saved state (`apps/<app>/auth/state.json`, `0600`) and its meta (when, the probe's result), `loginSession` (a headed window, you log
  in, "I'm logged in", save with `indexedDB: true`, a fresh headless check), `probeSession` (the plain rule plus the optional per-app rule in `app.json`), `/demo login`, `/demo logout`,
  `/demo session` (state), a check before discovery opens and before a recording starts (refused with "log in: /demo login").
- **7c, expiry inside a take.** The recorder checks after every navigation; a session that expired stops the take at that scene as "session expired" (not failed), a pending question asks you
  to log in, and the recording resumes from that scene after the login.
- **7d, the Login card.** On the Project page: the state (none, valid since, expired, unknown), Log in, Check now, Forget, and the optional rule; the answer to the question.
- **Real-app acceptance** is yours, on the app that needs the login: log in once, run discovery and a take. Not testable here; the fixture covers the engine.

**Items 13 and 14 (run-3 prep, D146; separate small PRs, in this order).**

- **13a, Voice over buttons (R3-6; done).** "Approve script vN" and "Make the voice (uses credits)" instead of "Approve & use" and "Generate voice, edit and a draft to watch"; a
  "what happens next" line under them (approve, the voice with its cost, the sync edit and a draft, the annotations start by themselves); the approval toast says the same.
  The credit gate stays a separate click. **Built:** the two buttons and the dialog titles renamed (Voice over only; the other stages keep "Approve & use"), an ordered list
  under them (`voiceSteps`: approve the script, make the voice, the sync edit and a draft, the annotations; the first not done is marked, state in words for a screen reader;
  the last step says if `annotations.autoSuggest` is off), the toast and the guide use the same words. **Tests:** `test/voice-steps.test.ts` (3, one in the browser); older strings
  moved. **Not verified:** the list at 900 px and in Latte; "voiced" is read from the fit or the audio files of the version.
- **13b, Recording: the request box at the bottom (R3-4; done).** The card of the storyboard's review (a bigger notes box, "N open notes will go with it", the button, the cost
  hint); the paragraph about approving and "Use for next steps" moves to the take rows. **Built:** the card (`section.review-foot[data-request-take]`) is the last thing on the
  Recording tab, a multi-line notes box, "N open notes will go with it" (or "No open notes on the takes"), the primary button and the cost hint; the guidance paragraph sits above the
  take rows (`.ds-take-guide`); the primary colour of a review card's one action is kept. **Tests:** `test/recording-request-card.test.ts` (browser: order on the page, the card, the
  note is sent once); `recording-notes` and `recording-review` find the box as a textarea. **Not verified:** 900 px and Latte.
- **13c, Recording keys (R3-3; done).** `<` and `>` = previous / next finding of the take (what the scene is meant to cover and what the take found; the ones with a time jump to
  it, the others to their scene); `[` `]` stay chapters; Left / Right = minus / plus 10 s, Shift = 1 s; every key works on the whole Recording tab (never while typing or in a dialog).
  **Built:** `recording-keys-core.js` (`keyAction`, `findingStops`, `stopFrom`, `clampSeek`) and one document-level key listener while a take's workspace is shown (it also takes the
  arrows from a focused video, which would seek 5 s by itself); a line under the video says where a key took you ("Finding 2 of 2 · 0:03.0 · 02-search: …", "No further finding");
  the hint under the player, the "?" sheet (13 rows) and CONTROL_ROOM say the same. A finding is what the storyboard meant the scene to show (at its scene's start) and what the
  take found (at its time); one named by both is one stop; a second `<` right after arriving goes to the one before. **Tests:** `test/recording-keys.test.ts` (4 pure, 1 browser with
  the focus on the page, in a text box and under a dialog). **Not verified:** a real take with many findings; Annotations keeps `[` `]` only, as decided.
- **13d, Storyboard: the picture beside the text (R3-1; done).** Inside the detail column the scene picture is the left half and all text the right half; stacked below about 64rem of
  workspace; nothing sticky. **Built:** the scene is a two-column grid (`.ds-sb-scene`: the picture 2fr, the text 3fr) while the workspace is at least 64rem wide (its own width decides,
  like the list screens), stacked with the picture first below that; the title, badges, confidence, takeaway, emphasis, outline, steps, review buttons and notes are all in the right
  part; a scene without a screenshot is one column and says so. **Tests:** `test/storyboard-scene-layout.test.ts` (browser, 1400 and 1000 px, with and without a picture). **Not
  verified:** Latte; a very tall picture next to a short text (the picture is not capped in height).
- **14, Projects page and archive (E, R3-7; done).** `#/projects`, opened from the project name in the header: a row per project (name, app, phase, size, last change, active) with
  Switch, Archive and Delete. Archive writes `<root>/archive/<project>-<date>.zip` (everything of the project and its app record, minus caches; over 4 GiB it refuses and says why).
  Delete = zip, read the zip back, then remove the folder, only after you typed the project's name. `/demo archive <project> [--delete]` does the same from the chat. Switching
  is refused while a job of the active project runs. No restore command (the zip unpacks into `<root>/projects`). **Built:** `src/projects/manage.ts` (`listProjectRows`, `planArchive`,
  `archiveProject`, `verifyArchive`, `deleteProject`), a zip reader (`readZipIndex`, `crcOfEntry`), `Runtime.switchProject` / `clearActiveProject` (the choice is remembered with `appendEntry`, the
  Director is primed and told), the routes `projects`, `project-switch`, `project-archive`, `project-delete`, the Projects page (`#/projects`; the header's project name and the Project page link
  to it), a dialog that waits for the typed name (`input.equals`), and `/demo archive`. The zip holds `projects/<slug>/…` and `apps/<app>/…` minus caches and **minus the app's `auth/`** (a saved login
  never goes into a backup); two archives in the same second get a number. **Tests:** `test/projects-manage.test.ts` (7: the zip reader, what goes in, verify catches a flipped byte, too big is refused
  and leaves nothing, delete keeps the project when anything fails, the routes, `/demo archive`) and `test/projects-page.test.ts` (the words, and the page in a browser). **Not verified:** a project near
  4 GiB; restoring from a zip by hand; the header link when the window is narrow (the project name is hidden below 80rem: the Project page has the link then).

**Item 12, P5 small options (two PRs).**

- **12a, the logo bug (F28, done).** `logoBugStatus(brand)` says if a brand shows the logo bug (turned on AND a logo file), has it off, or turned it on without a
  logo; `GET /api/render` carries it per brand; New render explains it under the checkbox for the chosen looks (what it does and in which corner, or "Nothing to show:
  neutral has it turned off", with a link to Config › Brands), and the checkbox is disabled and unchecked when no chosen look shows one. When disabled the render still
  sends the default (`true`), so the variant names never say "no logo" for something that was never there. **Tests:** `test/logo-bug.test.ts` (3, one in the browser).
- **12c, one scroll (R3-2, R3-5; added after run 3 prep, not in the day estimate; spike [L1-global-scroll.md](spikes/L1-global-scroll.md), D145).** The pinned detail
  of Storyboard, Voice over and Annotations and the pinned player and notes of Recording are gone: the page is the only scroll, the wheel works over the main area,
  the action bar sticks to the bottom of the window, Render is untouched. Built as the plain version first and reviewed by you; the second part (decided: "agree" with the recommendation) keeps ONE small sticky block, the
  Recording player, and nothing else. `test/list-screens.test.ts` and `test/recording-review.test.ts` assert it.
- **12b, zoom limits (F21, done).** The fixed "at most 2 zooms per demo" is two settings, `annotations.zoomsPerMinute` (default 1.5, 0 to 20) and `annotations.zoomsPerScene`
  (default 1, whole, 0 to 5), global with a project override like every setting; 0 = no zooms. `src/annotations/zoom-limits.ts` is the one place that decides (total = per minute × the
  demo's length, rounded up, at least 1; an 80 s demo still gets 2, a 6 minute demo 9), used by the designer's selection and import, the panel's toggle and reset rules
  (refused with the limit that stops it and the setting to raise), the input pack's "Caps" line and the budget meter ("zooms 1 of 2", with the limit as the tooltip). A stored version
  keeps only a sanity cap of 12, so lowering a setting never makes an old version unreadable. **Tests:** `test/zoom-limits.test.ts` (8); two old tests moved to the new rules.
  **Not verified:** the per-scene default of 1 against a real designer run; no panel control for the setting (it is in Config).

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
  **The spike is done** ([spikes/P4-message-hooks.md](spikes/P4-message-hooks.md), `test/p4-spike-hooks.test.ts`, a real pi session with a scripted model): a typed reply is an `input` with `source: "interactive"` (our own bridge is `"extension"`, the model's text is never an `input`); an `input` handler can resolve a tool that waits and swallow the reply (also while the run streams); aborting aborts the waiting tool; `message_end` can store a role prefix (the model then sees it); a custom message can show a question in the chat. So A4 needs no pi change; the open points are the rule for what counts as an answer in the chat, a time limit, and whether the model's own text gets a stored label. The design grill is next.
- **P5 (12):** L4 the logo bug option explained (S), L5 zoom limits as settings (M). Compare (L6) moved to item 9.
- **Run-3 prep (13) and E (14), decided with you (D146):** see section 4.
- **S7 (15):** `/demo login`, a login probe, re-login on expiry, session checks before discovery and recording; needs the real app. **Run 3 (16):** a full run on that
  more complicated app, every screen at 1400 and 900 px; its findings feed S6 and S8. **S6 (17):** parallel discovery lanes, opt-in, one bar per lane. **S8 (18):**
  native capture, optional.

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
