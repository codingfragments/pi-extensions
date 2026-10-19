# Roadmap: the phases after the first real-app run

Status: **P1 is done and accepted; the order of what is left is the first table below.** Source: the 32 findings of the first real-app run ([REAL_RUN_FINDINGS.md](REAL_RUN_FINDINGS.md)),
grouped into phases with the user (meaningful groups, not a list of tweaks). The plan for the first and largest phase is
[PLAN_QA_CHANGE.md](PLAN_QA_CHANGE.md). The phase table is also in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md#6a-phases-left).

Rules that held through the UX pass and still hold: every slice is its own branch and PR, with tests, a docs update, before/after
screenshots at 900 and 1400 px where the panel changes, and CI green before merge; no push or merge without consent; the user
approves, the agent proposes. Sizes: S about a day, M 2 to 4 days, L about 5 to 6. Estimates are rough and sequential for one person;
they give the order of magnitude, not dates.

## Current order after the run 2 grill

Status (2026-10-19): **P1 is done and accepted** (P1a safety and truth, P1b QA as a report, P1c the fix loop, Q7 the overrides retired, Run 2
complete). What is left, in the order to do it, decided with the user ([the decisions](REAL_RUN2_FINDINGS.md#the-run-2-grill-decisions-d-r2-1-to-d-r2-12)).
Days are sequential for one person (S about 1, M 2 to 4, L about 5 to 6); Σ is the running total, an order of magnitude and not a date.

| # | Work package | What changes for you | From | Days | Σ |
|---|---|---|---|---:|---:|
| 1 | **Docs: decisions and roadmap** | the decisions recorded (D101 and D125 amended), this roadmap, the early checks described and moved to the long tail | the grill | 1 | 1 |
| 2 | **Small fixes** | review buttons show their state with Revoke; a missing brand falls back to neutral and a failing draft only warns; the voice button says it makes a draft; title bleeding fixed | R2-6, R2-7, R2-8, R2-9 | 2 | 3 |
| 3 | **List screens** | Voice over, Annotations, Storyboard: list 22rem, wrapping titles, the detail column pinned until the list ends (absorbs L1) | R2-5, R2-9, F19, F20 | 3 | 6 |
| 4 | **Docked Activity drawer** | 22rem, squeezes only the main content, remembered open, Render stays two columns (absorbs L3, moved up from P4) | R2-12, F7 | 2 | 8 |
| 5 | **Suggestions** | the band hides at its target; a header "Suggestions · N" | R2-11 | 2 | 10 |
| 6 | **Config** | edit the project value on the row; staged edits with one combined review | R2-1, R2-2 | 4 | 14 |
| 7 | **Recording review (R0 + R1)** | chapters with snapshots as navigation, a smaller pinned player, goal and findings above it, timestamped notes | R2-4, F10 | 8 | 22 |
| 8 | **Voice-over filmstrip + step through annotations (R2, L2)** | all the scene's frames under the narration, used and "not mentioned"; Previous / Next on annotations | F16, F19 | 4 | 26 |
| 9 | **Compare versions (narrowed L6)** | Advanced, compare two versions, an honest verdict naming its evidence; storyboard and voice-over first | R2-3, F14 | 5 | 31 |
| 10 | **P3 Discovery you can steer and read** | start or enhance from the Project page, a discovery report, measured progress, an enlarged live preview (the discovery checks, QS-disc, are in the long tail) | F1, F2, F3, F5, F6 | 12 | 43 |
| 11 | **P4 The Director in the open (rest)** | a pending question answered in chat or panel; role labels in the chat | F18, F23 | 7 | 50 |
| 12 | **P5 Small options (rest)** | the logo bug option explained; zoom limits as settings | F28, F21 | 4 | 54 |
| 13 | **Run 3** (the user) | a full run on a different app, every screen at 1400 and 900 px | | 2 | 56 |
| 14 | **S7 Login and sessions** | required for v1, with the session checks | F4 | 8 | 64 |
| 15 | **S6 Parallel discovery lanes** | opt-in, built on item 10's measured progress | F6 | 6 | 70 |
| 16 | **S8 Native capture** | optional | | later | |
| 17 | **Long tail, not scheduled** | the thin early checks (P1d, [described](FUTURE_IDEAS.md#early-checks-thin-config-gated-informational)), the coherence review (Q8), extra QA checks (Q9), discovery checks (QS-disc), compare for recording, annotations and render, a stored suggestion history, `superseded` / `stale` pending fixes, a map node for fix sets, the two flaky tests ([KNOWN_ISSUES.md](KNOWN_ISSUES.md)) | | | |

What moved: **L1, L3 and L6 are absorbed** into items 3, 4 and 9 (so they are not done twice, and 3 and 4 come earlier than in the original
grouping); the early checks and the discovery checks left the plan because run 2 showed no need; the filmstrip and step-through (8) follow the
recording review (7) because they reuse its chapter and frame component.

## The original grouping (after run 1, before the run 2 grill)

Kept for the record: the phases as first grouped. Items marked done are done; the order that applies now is the table above.

### The phases (original table)

| Phase | Theme: what changes for you | Findings | Days |
|---|---|---|---|
| **P1** | **QA change: a report, after every phase, with visible fixes, and the Director under control** | F9 F11 F12 F13 F15 F17 F21 F22 F24 F25 F26 F27 F29 F30 F31 F32 | about 46 |
| P1a | Safety and truth: the agent can no longer approve or spend without a confirmation (A1); QA diagnostics and a calibration test of the drift measurement (Q0); doctor warns about environment overrides (A6) | F15 F17 F25 F12 | about 7 |
| P1b | QA becomes a report: severity model with hard stops only, integrity checks, noise collapsed, stage-agnostic findings model, popup shell (Q1); identity and ignore scopes with memory (Q2); run-and-tell notifications (A3) | F22 F27 F30 F31 | about 9 |
| P1c | The fix loop: the Director's working state from pi events (A2); flag and propose loop with free text (Q3); earliest-stage draft, working focus and pending fixes (Q4); later stages read the pending fixes (Q5); timing hints (Q6); retire the overrides (Q7) | F9 F11 F13 F24 F26 F29 | about 19 |
| P1d | **Early checks (re-scoped, after Run 2):** thin, informational and config-gated, not "QA after every phase" (see [D-QA-12](PLAN_QA_CHANGE.md)): three checks that are free and deterministic (voice-over: numbers and names not on the page, before synthesis; recording: error toast, console error, resumed scenes; annotations: a redaction that does not cover its element), a quiet note on the stage head, one popup, "send to the Director as a direction"; per-phase switches in Config, all **off** by default; render is always on. **Built only if Run 2 shows they would have saved work** | F32 F21 | about 3 to 4 (was about 11) |
| **Run 2** | the S5 real-app run repeated on the same app, to prove P1a to P1c ([guide: RUN2-101.md](RUN2-101.md); [acceptance criteria](PLAN_QA_CHANGE.md#run-2-acceptance-the-repeated-s5-run)) | | about 2 |
| **P2** | **Review workspaces: review the recording, the script and the annotations without fighting the screen** (a chapter-and-frame component; the recording review with timestamped notes; the voice-over filmstrip with the frames the script does not mention; the list and inspector layout: sticky detail, wider list, no overflow, step-through) | F10 F16 F19 F20 | about 16 |
| **P3** | **Discovery you can steer and read** (start or enhance from the Project page with a budget choice; a discovery report with guidance for the storyboard; measured progress and coverage; an enlarged live preview; discovery checks) | F1 F2 F3 F5 F6 (F8 is the model for the bar) | about 15 |
| **P4** | **The Director in the open** (a pending question answered in chat or in the panel, both in sync; role labels in the chat; Activity as a docked panel) | F7 F18 F23 | about 11 |
| **P5** | **Compare and small options** (ask the Director to compare versions; the logo bug option explained) | F14 F28 | about 7 |
| **Run 3** | **A full run after P5, before S7**, ideally on a different app (no login yet), to find what P2 to P5 did not (including layout on real data: every screen at 1400 and 900 px); its findings go into S7, S6 and S8 | | about 2 |
| **S7** | **Login and sessions, real-app acceptance** (required for v1; with the session checks of F4) | F4 | about 8 |
| **S6** | Parallel discovery lanes (opt-in; builds on P3's measured progress) | F6 | about 6 |
| **S8** | Native capture (optional) | | later |

Total about 113 days. The QA change itself (P1) is about 46; its first user-visible result (milestone M2, "QA is a report") comes after
about 16 days.

### Findings by phase (all 32)
| Phase | Findings |
|---|---|
| P1 | F9 F11 F12 F13 F15 F17 F21 F22 F24 F25 F26 F27 (moot after Q1: flag-and-fix replaces "accept all") F29 F30 F31 F32 |
| P2 | F10 F16 F19 F20 |
| P3 | F1 F2 F3 F5 F6 |
| P4 | F7 F18 F23 |
| P5 | F14 F28 |
| S7 | F4 |
| keep | F8 (praise: the segmented progress bar of the recording; the model for the discovery bar and S6's per-lane bars) |

Slice IDs used below and in the QA plan (A1, Q0, D1, R0, L1 and so on) map to phases as: A1 A2 A3 A6 Q0 to Q7 QS and L5 in P1;
R0 R1 R2 L1 L2 in P2; D1 to D4 and QS-disc in P3; A4 A5 L3 in P4; L4 L6 and Q8 (the coherence review) in P5; Q9 (extra checks) in
P5 or later.

## Order and why
1. **P1a first**: the cost gate stops credits being spent by the Director on its own, and the calibration decides whether the QA
   measurement or the fixes were the real problem (if the measurement, P1c shrinks).
2. **P1b** before any new UI for fixes: the report and the memory of decisions are what the fix loop stands on.
3. **P1c** is the largest and riskiest (timing hints change the script language and the sync edit); start it with a spike on the sync edit.
4. **Run 2 comes before P1d.** P1a to P1c have never run end to end with a real Director on a real app, and the honest value of early checks is unproven (in run 1 the findings that came back every render were timing, which cannot be checked before the voice exists; the early-checkable ones were the wrong numbers, which you ended up confirming as meant). P1d is re-scoped to a thin, config-gated version and decided from Run 2's evidence.
5. **Run 2** right after P1c: the same app and brief, to compare the QA reports of run 1 (renders v2 to v8) with the new ones and to try the
   fix loop on real findings.
6. After run 2 the order of **P2 to P5** is a default and can change: P2 first (where the time is spent while reviewing), P3 before S6
   (measured progress and the discovery report are what parallel lanes need), then P4, then P5. **W7 (docs made true) must follow A1
   immediately**, not wait.
7. **Run 3** after P5 and before S7: a full run on a different app (no login yet), so S7, S6 and S8 start from fresh findings. S7's own real-app
   acceptance closes v1.

## Timeline
```
RUN 1   done: the findings and the grouping (this record)
P1a     Safety and truth ............... about 7 days    M1
P1b     QA becomes a report ............ about 9          M2, M3      (first user-visible result at about day 16)
P1c     The fix loop ................... about 19         M4, M5
RUN 2   the S5 run repeated, same app .. about 2          (next: docs/RUN2-101.md)
P1d     early checks (thin, config-gated) about 3-4       (was 11; built only if Run 2 asks for it)
P2      Review workspaces .............. about 16
P3      Discovery ...................... about 15
P4      The Director in the open ....... about 11
P5      Compare and small options ...... about 7
RUN 3   the full run, a different app .. about 2          (no login yet)
S7      Login and sessions ............. about 8          (as soon as the real app is chosen)
S6      Parallel discovery lanes ....... about 6          (needs P3's measured progress)
S8      Native capture ................. optional, later
```
The milestones M1 to M7 and their acceptance tests are in [PLAN_QA_CHANGE.md](PLAN_QA_CHANGE.md#milestones-and-acceptance-what-you-can-do-after-each).

## P1a in detail: Safety and truth

Goal (milestone M1): the Director cannot approve anything or spend money on its own, and we know whether the drift numbers can be trusted.

**Decisions (grilled with the user):**
- **Grant path:** the Director's requests to spend reach the user through the **panel dialog and a typed `/demo allow`** (both work from day one; live sync between them is P4).
- **Grants, not tokens:** an engine-held, in-memory **grant** (kind `tts` or `take`, project, target, TTL about 15 minutes, used once). The model never handles a token. A grant is issued only by the panel's Allow button or by the user typing `/demo allow`; panel starts the user already confirmed write the grant as part of the click.
- **Auto designer:** the annotation designer that starts after the voice step stays automatic but is **run-and-tell** (it announces start and estimated cost in the panel, Activity and log); it needs no grant. A test keeps the list of such announced automatic starts short and checks each announces itself.
- **Order:** the gates first, then the doctor, then the calibration.

| # | PR title | Size | Depends on |
|---|---|---|---|
| 0 | `docs: P1a decisions (grant path, auto designer, order)` | XS | none |
| 1 | `fix: only the user can approve a take` (`demo_rec_take accept` becomes a proposal; the skill stops after approval) | S | none |
| 2 | `feat: spending grants, issued by the panel dialog or /demo allow` | M | none |
| 3 | `feat: the Director asks before spending (voice, recording)` | M | 2 |
| 4 | `feat: automatic starts announce themselves; ratchet test` (no tool approves or starts tts/take/design without a grant or an announcement) | S-M | 3 |
| 5 | `docs: the guide tells the truth about approvals and costs` | S | 3 |
| 6 | `feat: doctor and Config show environment overrides` | S | none |
| 7 | `feat(qa): anchor diagnostics, measured beside planned drift` (no change in what blocks) | M | none |
| 8 | `test(qa): drift calibration and the verdict` (a known planned delay reproduced within about 100 ms; the verdict in QA.md) | M | 7 |

Checkpoints: after PR 4 ask the Director in pi to continue after "Approve & use" (the voice synthesis must wait for the user's Allow);
after PR 8 the calibration passes and the verdict says whether the measurement or the fixes were the problem (it can reshape P1b and P1c).

## The other workstreams in detail
Each slice has an ID used in the tables above and in [REAL_RUN_FINDINGS.md](REAL_RUN_FINDINGS.md). The QA workstream (W1) is in
[PLAN_QA_CHANGE.md](PLAN_QA_CHANGE.md).

## W2. Director control and visibility

Principles: **no Director turn without a visible state** (F13); **ask first / run-and-tell / never silent** (F22); **the user decides approvals; the agent proposes** (F15, F18).

| Slice | What | Findings | Size |
|---|---|---|---|
| **A1 Hard gates (do first)** | the agent can no longer approve (`demo_rec_take accept` removed or turned into a proposal); a cost gate: TTS billed, a new take and a separate designer run refuse unless the engine holds a confirmation token issued by the panel dialog or by an answered pending question; the skills tell the Director to stop after an approval and say what is next and what it costs; a test that no agent tool can approve or spend without a token | F15 F17 | M |
| **A2 Director state from pi events** (**done**: spike and build, see [DIRECTOR_STATE.md](DIRECTOR_STATE.md)) | a spike first: which pi events say a turn started/ended and which tool is running (`before_agent_start`, `tool_call`, `tool_result`, turn end) and whether they are enough; then a "Director working: <task>" state in the band, strip and stepper, plus a log line, a progress entry and an Activity entry for each task | F9 F11 F13 | M-L |
| **A3 Run-and-tell notifications** (**done**, P1a PR 13) | the step classes written down in the code (ask / run-and-tell / never silent); one notification (toast + Activity + log + "new" badge) for cheap automatic steps; "Draft (no annotations)" label for the draft the voice step makes; after Approve & use a "what happens next" notice | F11 F22 F30 | M |
| **A4 Pending question** | an engine-owned question (id, what, options, cost, who asks); shown in the band, in a panel dialog and in the chat; answered by a click or a chat reply; the other place updates; the Director's tool waits for it | F18 | L |
| **A5 Role labels** | the extension's messages get the role prefix; a skill rule for the model's text; panel entries use the same names; verify whether pi can label assistant text | F23 | S-M |
| **A6 Environment overrides** | `/demo doctor` lists every DEMO_REC_* override in effect (setting, value, the file value it hides), a notice at project start and a Config badge; the test switches (NO_OPEN, NO_VOICE_LIST) as a stronger warning | F12 | S |

Order: A1 → A6 (small, immediate value) → A2 → A3 → A4 → A5.

## W3. Discovery

| Slice | What | Findings | Size |
|---|---|---|---|
| **D1 Discovery on the Project page** | a "Discovery" group: state (never run / running / done / budget used), **Start** and **Enhance** (add notes, areas or sources; a new session that builds on the earlier report), the budget chooser (quick / standard / deep + the three numbers, defaults from Config) and **Extend budget** when it ran out; why it stopped | F1 F5 | M |
| **D2 Discovery report** | at the end the Director writes a report (what it found about the app, what the extra research added, the guidance for the storyboard: use cases, risks, must-show, things to avoid); stored as a project artifact with versions, readable on the Project page and linked from the storyboard; the storyboard skill reads it | F2 | M-L |
| **D3 Measured progress** | the engine counts looks/actions per area (by route/section) instead of trusting `done` flags; a stall indicator; the Director must cover every declared area before writing the storyboard (a check that names the missed ones); the segmented bar like the recording's | F6 F8 | M |
| **D4 Enlarged live preview** | the preview opens in a larger popup that keeps updating | F3 | S |
| **S6 Parallel lanes** | as planned, built on D3: one bar per lane + an overall bar | F6 | L |

## W4. Recording review and frames

| Slice | What | Findings | Size |
|---|---|---|---|
| **R0 Shared chapter/frame component** | chapters and their frames (start, marks, end), click to jump, with the "used / not mentioned" mark; used by the next two slices | F10 F16 | M |
| **R1 Recording review workspace** | three columns (chapters and frames 25 %, a smaller player 50 % with the Director's comment and the chapter's goals above it and chapter marks on the progress bar, notes 25 %); `+` adds a note at the current time and chapter; notes are editable; notes reach the Director as a review message and the input log, and feed "Request a new take" | F10 | L |
| **R2 Voice-over filmstrip** | all the scene's frames in the Voice over inspector, used anchors marked, unused "not mentioned", click inserts `[@mark]` | F16 | M |

## W5. Layout and polish

| Slice | What | Findings | Size |
|---|---|---|---|
| **L1 List + inspector layout** | independent scroll areas or a sticky inspector, a wider list, titles that wrap or clip (min-width 0), checked on Annotations, Voice over, Storyboard, Render | F19 F20 | M |
| **L2 Step through annotations** | big Previous / Next flanking the preview, "4 of 21", keyboard | F19 | S |
| **L3 Activity as a docked side panel** | docked and resizable, an overlay below the narrow threshold; the strip stays | F7 | M |
| **L4 New render form** | the Logo bug option explained and disabled with the reason when the brand has none | F28 | S |
| **L5 Zoom limits as settings** | zooms per minute / per scene / absolute cap in Config → Annotations; one function feeding the five places; a per-demo override | F21 | M |
| **L6 Compare versions** | select two versions → engine facts + the Director's judgement as a readable note linked to both | F14 | L |

## W6. Login (S7, F4)
As planned (`/demo login`, a login probe, re-login on expiry) plus: check the session before discovery, before recording and during a take; prompt and carry on. Needs the real app.

## W7. Docs that became untrue
After A1: GUIDE, README, TUTORIAL, CONTROL_ROOM say "the agent cannot approve", "you are asked before anything costs money": make them true by A1, then re-check the wording.

---

## Risks
- Timing hints change the voice-over script language: they touch the parser, validation, the diff, the sync edit and the Voice inspector (Q5 is the riskiest slice).
- The pi event spike (A2) may show that turn end is not observable; then the "working" state needs a fallback (a timeout, or the Director's own start/finish tool calls).
- Q0 may show that the QA measurement, not the fixes, was the main problem; then Q1-Q4 get smaller and the drift numbers change meaning.
