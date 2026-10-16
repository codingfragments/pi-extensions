# UX9c report: final audit and scored usability review

Slice UX9c of the [UX pass](../UX.md) (§9, Acceptance and validation). No new feature. This slice runs the nine
task scenarios against the seeded project, measures what each screen shows, scores every screen on the ten
heuristics, runs the final axe and keyboard audit, and fixes what was cheap to fix.

**How to read this.** The evidence is a test file you can run, not a claim: `test/ux9c-scenarios.test.ts` (11
tests, one per scenario, scenario 9 split in three), `test/ux9c-measure.test.ts` (the control-count bar) and
`scripts/ux-measure.ts` / `scripts/panel-audit.ts` (the numbers). All of it ran on a **synthetic seeded
project** (`keycraft`), headless, with no real model, no real recording and no screen reader. It says the panel
does what the spec asks on that project; it does not say a stranger finds it easy. That still needs a person.

## 1. The nine scenarios

All nine pass, three runs in a row. Each is a Playwright test that drives the real panel.

| # | Scenario | Evidence (what the test asserts) | Result |
| --- | --- | --- | --- |
| 1 | Viewed version, production selection, pending review and active job are readable without History or Activity; a new result never moves you | on all six stages the summary names the viewed version and the version in the line; the band shows pending review; the strip shows a running job; a result published while the user types leaves the typed text and the route untouched | pass |
| 2 | Browse an older version through History and the map, close, return: nothing changes; Open in stage lands on the exact artifact | `state.json`, the draft files and the version files are byte-identical before and after; the route after Open in stage is `#/voice/v1` and the summary says *Viewing v1* | pass |
| 3 | Branching fixture: approved-path and line filters, honest withdrawn ancestors, missing media and unknown lineage; collapse, focus and search reversible by keyboard | the seeded project plus a second, unapproved annotation branch; *Approved paths* drops the unapproved branch (keeps vo:1 and render:2); *Production line* is exactly the six nodes of the line; a render without files stays in the graph; search and reset are reversible; arrow keys walk the graph and the outline lists the same nodes; withdrawing the recording's approval leaves its descendants shown as blocked, not hidden | pass |
| 4 | Approve an alternative without selecting it; then use another; approvals and files survive; a stale plan does not apply | *Approve only* on v2: both v1 and v2 approved, the line still v1, no file touched, no agent turn. *Use* on v2 moves the line, v1 stays approved and its files stay. A plan made earlier, applied after the project moved on, throws `StalePlanError` and writes nothing | pass |
| 5 | Drafts survive navigation and reload on the right base; failed writes and competing edits are shown; Save makes exactly one version | narration draft on v2, annotation draft on v1, across stages and a reload each comes back on its own base only; an aborted request shows *Save failed* with Retry and keeps the change; *Save new version* adds exactly one version file, approves nothing, starts no job and no agent turn, and does not touch the other draft | pass |
| 6 | The common inspector keeps confidence, batch-review safeguards, annotation controls, variants and QA overrides | confidence badges in the list and the inspector; *Mark high-confidence reviewed* shows its plan (*Marks reviewed … Skips …*) before anything is marked; the annotation inspector has Start, Length, Target, Why, the 0.5 s nudges, the preview and *play the scene*; the Render inspector has variants and the player, the blocking QA item and *Confirm & export anyway* asking for a reason | pass |
| 7 | Config: search by key, description and a safe value; effective source; edit only the named scope, shadowed too; no secret | found by `voiceName`, by "display name", by a file value and by the effective value; the row says *Environment (DEMO_REC_VOICE)* and still shows the shadowed global value; editing the project override says it has *no effect right now*, asks for confirmation, writes only the project file (the global file is unchanged); an API key set in the environment is not found by its value and appears nowhere on the page, raw files included | pass |
| 8 | Empty, partial and complete brief: next task and context without a wizard or a wall of fields | each opens on the short summary with its NEXT line (*describe the demo to the Director, or fill the brief in yourself* / *complete the missing brief details: Goal, Depth* / *The brief is complete*); no dialog; the field form is closed; no screen taller than 1150 px; the four groups are one click away; the empty project offers *Ask the Director* and *Fill it in myself* | pass |
| 9 | Keyboard, both themes, narrow layout, nested surfaces, failed saves, busy states, reduced motion, text zoom, disconnection | see below | pass |

Scenario 9 in detail:

- **Keyboard, both themes** (Macchiato and Latte): Tab through Voice, Render and Config, 70 stops each. Every
  stop shows a focus indicator, and the main actions (Approve & use, Save new version, History, Re-run QA,
  Reload files, Scopes …) are reached.
- **Dialogs:** focus moves into a dialog, Tab stays inside it for eight presses, Escape closes it, and focus is
  back on the button that opened it.
- **Narrow:** at 700 px none of nine routes scrolls sideways.
- **Text zoom:** at 200 % text, Voice, Render, Config and Project do not scroll sideways.
- **Reduced motion:** the motion duration token resolves to `0ms`.
- **Busy save:** with the save held for 700 ms the bar says *Saving…*, then *Draft saved*.
- **Disconnection:** with the live socket refused, the strip says *connecting/reconnecting*; when the network
  comes back the panel reconnects by itself and says *connected*.

Two things were found by writing these tests and fixed in this PR:

- **The Render stage never said which version you were viewing** unless the address named one. Every other stage
  shows *Viewing vN*. Render now uses the run it opened on (the approved one) like the others. This was a real
  gap in scenario 1.
- **A possible race when typing into Voice before the draft has loaded.** Under six parallel runs the test once
  lost the first typed character (`yping…` instead of `typing…`) because it typed the instant the textarea
  appeared. 48 sequential rounds of the same typing, in four parallel processes, lost nothing, so it is not
  reproduced outside heavy load. The test now waits for the action bar before typing, and the case is listed in
  the follow-ups rather than called fixed. The other intermittent failures were the test reading the summary
  before its data had arrived; it now waits.

## 2. What each screen shows when it opens

Measured by `scripts/ux-measure.ts` on the seeded project, macchiato theme: visible, enabled controls, tab
stops, the part of that count that is the shared frame (header, stepper, band, strip: 13 on every screen), and
the page height. The **before** column is the figure quoted in the spec's historical pre-pass measurement, at
the same 1500 px on the same fixture.

| Screen | Before | Now (own + frame) | Tab stops | Page height at 1500 px | at 900 px |
| --- | --- | --- | --- | --- | --- |
| Render | 196 | **36 + 13 = 49** | 36 | 1115 | 1164 |
| Annotations | 102 | **37 + 13 = 50** | 37 | 1254 | 1288 |
| Voice over | 46 | 34 + 13 = 47 | 34 | 1294 | 1323 |
| Storyboard | 22 | 18 + 13 = 31 | 18 | 1120 | 1120 |
| Project (summary) | 30 | 11 + 13 = 24 | 11 | 1000 | 1000 |
| Project, Brief open | n/a | 36 + 13 = 49 | 36 | 1471 | 1968 |
| Recording | 5 | 4 + 13 = 17 | 4 | 1000 | 1000 |
| Config | 58 | 66 + 13 = 79 | 66 | 4069 | 6161 |
| Config, Brands | n/a | 28 + 13 = 41 | 28 | 1486 | 2518 |
| Map | n/a | 33 (no frame) | 32 | 1000 | 1000 |

Against the spec's bar, *halve Render and Annotations without removing a capability*:

- **Render: 196 → 49, a 75 % cut.** Met. Every capability is still there (variants, downloads, QA, override,
  New render options); they sit inside the selected run's inspector, or behind *Change…*, instead of on every row.
- **Annotations: 102 → 50, a 51 % cut. Met, but only just** (the bar is 51), and the scenario test would catch
  it growing back. The list-and-inspector layout shows one item's controls at a time.
- **The frame is new and is counted.** It adds 13 controls to every screen, so the screens that did not need
  halving read higher than before if you add it: Voice 46 → 47 (flat), Storyboard 22 → 31, Recording 5 → 17.
  What the frame buys is the thing scenario 1 checks: you always know what you are looking at and what is running.
  The honest reading is that small screens got a little busier and big ones much calmer.
- **Config grew: 58 → 79**, and is the longest page (4,069 px; 6,161 px at 900 px). The cause is deliberate (D125:
  every setting has a Scopes disclosure, a search and quick filters) but the cost is real. Follow-up below.
- **Scroll:** every stage screen fits in about one screen and a quarter at 1500 px. The two exceptions are Config
  and Project with the Brief open at 900 px (1,968 px).

**Task steps** (counted in the scenario scripts, one click or key = one step):

| Task | Steps |
| --- | --- |
| See which version you are on, what the line uses, what is pending and what is running | 0 (always on screen) |
| Approve a version without using it | 1 (*Approve only*) |
| Approve and use a version | 1 click + 1 confirm in the dialog that says what changes |
| Open an older version from History | 2 (History, the row) |
| Find the setting behind a value and see where it comes from | 2 (`/`, type) |
| Save a narration or annotation edit as a new version | 1 (the draft saves itself) |
| Confirm a blocked QA item with a reason | 3 (item, *Confirm & export anyway*, reason + confirm) |

These are step counts on a script, not times, and not measured against the old panel (it can no longer be run
side by side), so there is no "slower or faster" claim here.

## 3. Scored review

0 = fails the heuristic, 1 = weak, 2 = good with gaps, 3 = good. Scored by the author from the seeded project,
the scenario runs and the screenshots, **not** by a user. The **before** total is a retrospective estimate from
the pre-pass findings recorded in the spec (not re-measured: the old build is gone), so read the direction, not
the digits. The ten heuristics: status visibility (Stat), real-world language (Lang), control and freedom
(Ctrl), consistency (Cons), error prevention (Prev), recognition (Recog), efficiency (Eff), minimalism (Min),
recovery (Rec), help (Help).

| Screen | Stat | Lang | Ctrl | Cons | Prev | Recog | Eff | Min | Rec | Help | Now | Before |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Project | 3 | 3 | 3 | 3 | 2 | 3 | 3 | 3 | 2 | 2 | **27** | ~15 |
| Storyboard | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 2 | 2 | 2 | **26** | ~17 |
| Recording | 3 | 3 | 2 | 3 | 2 | 3 | 2 | 3 | 2 | 1 | **24** | ~16 |
| Voice over | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 2 | 2 | 2 | **26** | ~17 |
| Annotations | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 2 | 2 | 2 | **26** | ~12 |
| Render | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 2 | 2 | **27** | ~10 |
| Config | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 1 | 3 | 2 | **27** | ~14 |
| Config · Brands | 2 | 3 | 2 | 1 | 2 | 2 | 2 | 2 | 2 | 1 | **19** | ~16 |
| Map | 3 | 2 | 3 | 3 | 3 | 2 | 2 | 2 | 3 | 2 | **25** | n/a (new) |

Every screen's total improved; none dropped. No safety or accessibility score is hidden by the average: the
two 1s that matter are called out below. Examples behind the scores:

- **Status visibility 3:** the summary, band and strip; scenario 1 asserts them on all six stages. Brands is a 2:
  it has no summary or version line like the stages.
- **Error prevention 3 (Voice, Annotations, Render, Storyboard):** every action that costs or changes the line
  asks first and says what changes (*Approve & use*, cost dialogs); privacy-off confirms once per redaction;
  a stale plan is refused (scenario 4). Project is a 2: the summary never gates, which is right, but nothing
  stops you from starting a recording on a brief with missing essentials.
- **Control and freedom:** Escape closes the topmost layer everywhere; the map is an overlay that never writes.
  Recording is a 2: you can cancel a job, but there is nothing to step back to after Approve.
- **Consistency 3, except Brands (1):** every stage uses one list-and-inspector shape, one set of actions and one
  vocabulary; the **Brand editor still has its old markup** and does not look like the rest.
- **Efficiency 2 on the stages:** no keyboard shortcuts beyond `/` in Config and Escape; moving between list
  items is by Tab, not arrow keys.
- **Minimalism 1 on Config:** 79 controls and a 4,000 px page. It is the one screen whose depth got worse.
- **Recovery 2:** drafts, conflicts and failed saves are all recoverable, but **there is no Undo after an action**
  (an approve, a use, a delete). The dialog before it is the only safeguard. This was planned in UX3 and never
  built; it is why no screen scores 3.
- **Help 1–2:** labels and notices explain themselves, but there is no help page or first-run tour. Part 14
  (GUIDE, CONTROL_ROOM, TUTORIAL) is the answer.

## 4. Final audit

`scripts/panel-audit.ts`, 14 screens × 2 themes × 2 widths = 56 pages, axe-core 4.10.2 with the WCAG 2.0/2.1/2.2
A and AA rules, plus a keyboard walk that checks every tab stop for a focus indicator.

| | start of this slice | now |
| --- | --- | --- |
| serious axe nodes | 24 | **0** |
| tab stops without a visible focus indicator | 0 | 0 |
| small targets (< 24 px, WCAG 2.2 target size) | 48 | 48 |

The 24 serious nodes were all colour contrast, in four places, all fixed with token changes (no new colours):

- the brief's length sliders: the *default* state was dimmed with `opacity` on the whole row, which dropped the
  labels to 2.7:1 in Latte. Now only the slider is dimmed;
- the annotation thumbnail's placeholder text on its black media background (Latte, 3.35:1);
- the *download* links in the selected row of the Render variants table (4.24:1);
- the term column of the cost dialog's facts in Latte (4.05:1).

The audit script now prints the failing elements with `AUDIT_WHERE=1`, so the next regression is one run away
from its cause. Baselines were updated and are committed.

## 5. What was fixed in this slice, and what was not

Fixed here: the Render stage now shows *Viewing vN*; the 24 contrast failures; the audit prints where it fails;
the scenario tests and the control-count test exist and run in `npm test` (they skip, loudly, without Chromium).

Not fixed, in order of how much I think it matters:

1. **No Undo after an action.** Approve, use and delete are guarded by a dialog but not reversible with one
   click. Needs a design decision about what "undo" means for a state change that already notified the Director.
2. **Config is the heaviest page** (79 controls, 4,069 px, 6,161 px at 900 px). Candidates: open only the first
   group; render rows lazily; fold the quick filters into the search.
3. ~~**The Brand editor** still has its old markup and scores 19.~~ Rebuilt on the Config row pattern in [UX18](UX18.md).
4. **48 small targets** (< 24 px), mostly range sliders, small icon buttons in dense rows and list-row checkboxes
   without a 24 px label. Needs a size pass on `ds-btn--sm`, not a per-page fix.
5. **Arrow-key movement in lists** and a short list of shortcuts, shown on `?`.
6. **Help:** GUIDE, CONTROL_ROOM and TUTORIAL (Part 14).
7. **Typing before the draft is loaded** (above): one lost character under load, not reproduced otherwise.
8. Generic helper classes still in use: `muted` 147, `small-text` 84, `row` 69, `card` 55, `grow` 50, `mono` 18
   places. They are token-styled and harmless; replace them with `ds-` equivalents when a screen is next touched.
9. Never built (earlier lists): a visible notice when a panel module fails to load, the Voice field as a picker of
   the account's voices, the keyframe at an anchor in the Voice inspector, map pan/zoom/minimap.

## 6. What this review cannot tell you

- Nobody who did not build the panel has used it. A first-time user on a real project is the missing evidence.
- The synthetic project has 3 scenes. A real demo has more scenes, longer narration and a messier QA report.
- Previews, the Render player and an actual render were exercised only against seeded files. The first real
  recording through the Annotation designer is where those show whether they hold.
- Screen-reader behaviour was checked by axe and by reading the markup, not by listening to one.
