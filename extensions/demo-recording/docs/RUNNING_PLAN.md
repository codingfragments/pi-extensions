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
`main`.** The next piece of work is item 2 (small fixes).

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
| 4 | **Docked Activity drawer** | 22rem, squeezes only the main content, remembered open, Render keeps two columns (absorbs L3) | R2-12, F7 | **next** | 2 | 8 |
| 5 | **Suggestions** | the band hides at its target; a header "Suggestions · N" | R2-11 | planned | 2 | 10 |
| 6 | **Config** | edit the project value on the row; staged edits, one combined review | R2-1, R2-2 | planned | 4 | 14 |
| 7 | **Recording review (R0 + R1)** | chapters with snapshots as navigation, a smaller pinned player, goal and findings above it, timestamped notes | R2-4, F10 | planned | 8 | 22 |
| 8 | **Voice-over filmstrip + step through annotations (R2, L2)** | all the scene's frames under the narration, used and "not mentioned"; Previous / Next on annotations | F16, F19 | planned | 4 | 26 |
| 9 | **Compare versions (narrowed L6)** | Advanced, compare two versions, an honest verdict naming its evidence; storyboard and voice-over first | R2-3, F14 | planned | 5 | 31 |
| 10 | **P3 Discovery you can steer and read** | start or enhance from the Project page, a discovery report, measured progress, an enlarged live preview | F1, F2, F3, F5, F6 | later | 12 | 43 |
| 11 | **P4 The Director in the open (rest)** | a pending question answered in chat or panel; role labels in the chat | F18, F23 | later | 7 | 50 |
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

**4. Docked drawer** (D-R2-7). The page below the header becomes a row of workspace and drawer; header, band and strip keep the full width, so
`--hwrap-h` and every pin keep working. The drawer is 22rem and the Render grid's two-column limit drops from about 72rem to 60rem; below about
1184 px the drawer stays an overlay. The user's open state is stored in the browser and restored after a reload (never opened by the system).
Escape, focus in and back, and the strip stay. Test: at 1400, 1100 and 900 px, open and closed, no element is covered. **Uncertain until tried
on the real project:** whether 22rem and 60rem are right.

**5. Suggestions** (D-R2-8). `nextBand` learns the current tab and hides when it equals the band's target (Blocked and Director working never
hide). The header gets "Suggestions · N": the current suggestion and what else waits, each a link, whether or not the band shows. No stored
history. The band collapses with a short transition; the test checks the pinned panels keep their offset.

**6. Config** (D-R2-9). With a project open a row edits that project's override, labelled "Editing for <project>"; the global value is under
Scopes. Edits are staged; a "N changes: Review and save" bar opens one combined diff; one write per file. The backend needs a batch endpoint that
composes several changes to one file in memory, validates all of them and applies none if one fails. Leaving with unsaved edits asks; an
environment variable that wins is still said per line. **Risk:** staged edits against the search and the quick filters.

**7. Recording review** (D-R2-10). **R0** the shared chapter and frame component (frames: the start, each mark, the end; a click seeks; "used /
not mentioned" for the voice-over later). **R1** three columns: the chapters and frames (about 25 %), the smaller pinned player (about 50 %) with
the Director's comment and the scene's goal and findings above it (the storyboard scene's findings and what the take found: toasts, resumes,
fallbacks, dead time) and chapter marks on a thin bar under the video (native controls cannot host marks), and timestamped notes (about 25 %):
`+` adds a note at the current time and chapter, notes are editable, stored per take, reach the Director as a review message and the input log, and
feed "Request a new take". **Risk:** notes are a new concept; the `+` key must not clash with typing.

**8. Filmstrip and step-through.** The voice-over inspector shows all the scene's frames, used anchors marked and unused ones "not mentioned", a
click inserts `[@mark]`; Annotations get Previous / Next flanking the preview with "4 of 21" and keys.

**9. Compare versions** (D-R2-11). Advanced, "Compare two versions…" on storyboard and voice-over. The engine supplies the facts from the existing
diffs; the Director answers through a validated tool that refuses an answer without a verdict, the evidence it names (a scene, a section, a
number) and a recommendation; the note is stored in the project, linked to both versions, a visible Director turn that costs tokens and needs no
Allow, and can feed the fix window.

## 5. The later phases in outline

Details and slice sizes are in [ROADMAP.md](ROADMAP.md#w3-discovery); only the shape is here.
- **P3 Discovery (10):** D1 start and enhance from the Project page with a budget chooser, D2 a discovery report with guidance for the storyboard,
  D3 measured progress per area, D4 an enlarged live preview. The estimate of 12 days is the original 15 without the discovery checks; it has not
  been re-checked slice by slice.
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
