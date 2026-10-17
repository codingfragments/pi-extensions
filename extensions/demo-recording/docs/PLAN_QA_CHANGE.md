# Plan: changing the QA to follow the decisions (phase P1, the next one)

Status: **planned, nothing implemented.** Source: the real-app test run ([REAL_RUN_FINDINGS.md](REAL_RUN_FINDINGS.md), F24 to F32) and the QA grill
(D-QA-1 to D-QA-11 below). The order of all remaining work is in [ROADMAP.md](ROADMAP.md); this phase is its first.

**What the run showed.** QA found the same three or four drift items and one wrong number in every render from v2 to v8, whatever was
fixed; the "fixes" were shifts on a copy of the timeline that only the next "Apply fixes" render inherited; QA and the sync edit
disagreed about the same anchor by up to 1.4 s (with opposite signs); a render with no audio would have passed; eleven "picture stands
still" lines, nine of them "expected", drowned the report. And QA existed only for the final render, although most problems start in
earlier stages.

**What it becomes.** A report, not a gate (only a real defect stops anything). After every phase. With decisions that are remembered.
And fixes that are visible, created as new draft versions at the earliest stage they belong to, never hidden on a render.

## Decisions (D-QA-1 to D-QA-11)
| # | Decision |
|---|---|
| D-QA-1 | The only hard stops for approving a final: **integrity defects** (no or empty audio, truncated video, a listed variant file missing: new checks) and **a redaction that does not cover its element**. Everything else is a report item the user may flag for fixing or ignore. |
| D-QA-2 and 7 | The user flags findings and asks for a fix set. The Director generates **suggested fixes**; the user selects, rejects and adds **free text**, over as many rounds as needed. Once accepted, the Director decides the **earliest stage** the fixes belong to and applies them there as **one new draft**; the fixes for later stages are stored as **pending fixes**. **No render and no voice synthesis happens in this flow.** Each draft links back to the render and the findings it answers (a "fix set" in the tree). Fixes are not only patches on a render: they may recommend changes to the voice-over, annotations, recording, storyboard or discovery. |
| D-QA-3 | A finding's identity is **check + scene + anchor/value**, never its timing numbers, with reasonable flexibility on anchors. An ignore survives re-renders of the same voice-over and annotations and ends when that content changes. Later runs show "ignored in render vN: reason". |
| D-QA-4 | A missed redaction is **fix only**; a deliberately heavy last-resort override exists (typed acknowledgement; the reason is stored on the approval and shown in the render record). The fix step accepts **free-text guidance**, and an ignore may be a **rule with a scope** (this finding / this check in this scene / this check in the project), e.g. "all redactions can be ignored, this is test data, no PII". |
| D-QA-5 | A **timing hint is a relative offset on the anchor**, written in the script: `[@mark +300ms]` (the phrase after the anchor starts 300 ms after, or with a minus before, the anchor's event). Shown in the diff; nudge controls beside the anchor's picture in the Voice over inspector. No scene-wide bias for now. |
| D-QA-6 | For timing, the **measured** drift (Whisper on the rendered audio) is the headline and the sync edit's **planned** drift is shown beside it; a large gap is flagged. Fixes act on the measured number only after the calibration (Q0) proves it. |
| D-QA-8 | The new fix draft becomes the project's **working focus**; the **production line keeps meaning approved and usable**. The band says "Needs you: review <stage> vN (fixes from render vM)"; the later stages show as waiting for it; approving the draft moves the line and the later stages are re-made with the pending fixes. |
| D-QA-9 | **Pending fixes** are one project list with a lifecycle (open, applied, dropped, superseded, **stale**: the problem no longer exists after an earlier change). Plain-text sentences first, structured fields second: project memory the Director reads, not a deterministic to-do list. The Director reads it and the ignores before proposing, and says "already decided: …" instead of asking duplicates. Part of `demo_rec_project context`. |
| D-QA-10 | A fix that belongs to the **storyboard or discovery** is a **proposal that starts that step** with its normal asks (a visible storyboard-writing task then approval; a discovery enhancement with its budget choice). Never done inside the fix flow. |
| D-QA-11 | A **coherence review**: a separate, advisory, on-request Director-led review (narration claims the footage does not show, a scene contradicting the goal, a missing story step) that proposes fixes into the same loop. It never blocks and never runs on its own. Deterministic QA stays model-free. |
| F32 | QA runs **after every phase** and is attached to that stage version (a badge and a popup to show and act). Confidence signals of the storyboard and the voice-over are **folded into the stage findings** (one list, one popup). |
| defaults | Old `overrides.json` stay readable as "legacy timing fixes". The extra deterministic checks (loudness, length vs the brief, subtitles, scene order) come later. An error toast in the footage becomes a proposed storyboard step change when the cause is a step, otherwise a re-record. |

## The catalog of checks (with the new level and the owner of the fix)
| # | Finding | Level now to report | Owner | Fix recipe |
|---|---|---|---|---|
| 1 | number said, on screen nowhere in the scene | report (was blocking) | voice-over | change the sentence or bind it `{{dom:mark\|regex}}` |
| 2 | value said before it appears | report | voice-over | move the anchor / timing hint |
| 3 | name not on screen | report | voice-over | reword |
| 4 | error toast in used footage | report, high | recording | re-record the scene (or fix the storyboard step) |
| 5 | console / page error in used footage | report | recording | note; re-record or accept |
| 6 | other toasts | report | recording | note |
| 7 | narration off its anchor (150 / 300 ms) | report | voice-over | timing hint on that anchor |
| 8 | sync not checked (no Whisper) | report | setup | install |
| 9 | picture frozen 6+ s unexplained | report | recording / edit | wait step, trim, or re-record |
| 10 | frozen < 6 s or a held frame of the edit | summary line only | none | none |
| 11 | pause of 4+ s | report | voice-over / edit | add narration or shorten footage |
| 12 | black picture | report | recording / render | re-record |
| 13 | annotation cannot be placed | report | annotations | retarget / remove |
| 14 | redaction does not cover its element | **HARD STOP** | annotations | move the redaction |
| 15 | private-looking data on screen, not redacted | report | annotations | add a redaction |
| 16 | no or empty audio track | **HARD STOP** (new) | render | re-render; investigate |
| 17 | truncated video / shorter than the timeline | **HARD STOP** (new) | render | re-render |
| 18 | a listed variant file is missing | **HARD STOP** (new) | render | re-render |


## From today to the decisions
| Topic | Today | Target (decision) | Code touched |
|---|---|---|---|
| When QA runs | only on a final render (`src/qa/run.ts`, 732 lines) | after every phase, attached to the stage version (F32) | new stage adapters over existing detectors |
| Severity | `blocking` / `warning` / `info`; blocking stops approval | hard stop only for integrity and a missed redaction; the rest a report with levels high / normal / info (D-QA-1) | `qa/types.ts`, `qaBlocker`, `version-actions.ts`, `render-routes.ts`, `render.js` |
| Integrity checks | none (a render with no audio would pass) | audio present and not silent, duration vs timeline, files present (rows 16-18) | new `qa/integrity.ts` (ffprobe) |
| Noise | 11 "picture stands still" lines | one summary line | `checkMedia` |
| Drift | measured only, labelled as fact; the edit's plan not shown | measured headline + plan beside it; a big gap flagged; calibrated first (D-QA-6) | `checkDrift`, report schema |
| Finding identity | an index in the report | check + scene + anchor/value, fuzzy anchors (D-QA-3) | new `qa/identity.ts` |
| Ignore / confirm | "Confirm & export anyway" per blocking item, stored on that render | ignores with scopes + comment/rule, stored in project memory, shown as "ignored in render vN" (D-QA-3/4) | new decisions store; `confirmItem` retired |
| Fixes | "Apply fixes": shifts on a copy of the timeline (`*.overrides.json`) | propose -> select + free text -> earliest-stage draft + working focus + pending fixes (D-QA-7/8/9) | new fix-set + pending-fixes stores; `overrides.ts` retired |
| Timing | a render override | `[@mark +300ms]` in the script + nudge controls (D-QA-5) | script parser/validator/diff, sync edit, Voice inspector |
| Memory | QA is not in the project context | decisions + pending fixes in `demo_rec_project context` (D-QA-9) | `tools/project.ts`, skills |
| UI | a QA card in the Render inspector | one popup component per stage + a badge (F32); Render keeps the integrity/hard-stop banner | new component; `render.js`, stage screens |
| Coherence | none | separate advisory, on-request Director review (D-QA-11) | new skill + proposals |

Size of what exists: `src/qa/*` about 1,070 lines (run 732, numbers 193, overrides 98, types 50), confidence about 430 lines, 11 consumer files, 7 QA tests and 10 confidence tests. So this is a restructuring of known code, not a rewrite.

## Target shape
- **Finding** (stage-agnostic): identity key, stage + version, check, kind, level, scene, anchor or value, evidence, plain-language message, measured + planned numbers, owner stage, recipe key.
- **Detectors**: pure functions per stage returning findings; the five render checks are moved into detector modules unchanged first (Q0/Q1), then new ones are added.
- **Stores** (project memory): `qa/<stage>/vN.json` (findings of a version), `decisions.jsonl` (ignores with scope + comment), `fixes.jsonl` (pending fixes, plain text first), `fixsets/fsN.json` (rounds of a fix set). Old `render/vN.qa.json` stay readable as legacy.
- **Gate**: `qaBlocker` shrinks to the hard stops (+ the heavy redaction override).
- **Director**: a `demo_rec_qa` tool (read findings, propose fixes, write pending fixes) and a skill; reads the memory before asking (no duplicate questions).
- **UI**: a "Checks of <stage> vN" popup, the stage badge, Fix / Ignore / Leave + free text, the propose loop, "N pending fixes" on stage screens.

## Compatibility and migration
- Old `v*.qa.json` are read as legacy findings: blocking -> high, confirmed items -> ignores (scope: that finding, reason kept).
- Old finals keep their approval. For an old final the gate is recomputed with hard stops only; the integrity checks it never had show as "not checked", never as blocking.
- Old `*.overrides.json` are read-only "legacy timing fixes"; no new ones are written after Q7.
- A final that was approved while "blocked" stays approved.
- Rollback per slice: each slice is behind its own PR; Q1 keeps the old report fields until Q7, so a revert does not lose data.

## Milestones and acceptance (what you can do after each)
| Milestone | Slices | After it you can... | Acceptance (tests) |
|---|---|---|---|
| **M0 Plan** | this document, the run's summary | decide order and scope | sign-off |
| **M1 Trustworthy numbers** | Q0, A1, A6 | trust (or know you cannot trust) the drift numbers; the Director can no longer approve or spend by itself; doctor warns about env overrides | calibration within ~100 ms on a fixture; a test that no agent tool approves or spends without a token; doctor lists overrides |
| **M2 QA is a report** | Q1 (+ the stage-agnostic model, + the popup shell) | approve a final that has findings; get stopped only by a real defect; see one summary line instead of 11 | a final with removed audio, truncated video, a missing variant file and a missed redaction is stopped; a final with 3 old-style blockers can be approved; the noise rows collapse |
| **M3 Decisions are remembered** | Q2 | ignore a finding or a class of findings with a comment and not meet it again | identity survives re-render; fuzzy anchor cases (renamed mark, moved phrase); the ignore ends when the scene text changes; "all redactions ignorable (test data)" lifts the hard stop visibly |
| **M4 The fix loop** | A2, A3, Q3, Q4, Q5 | flag findings, get proposals, refine with free text, accept: one draft at the earliest stage, the working focus there, pending fixes for later stages that the later writers read | the loop end to end on the fixture; the working focus appears in band, stepper and map; no render or synthesis starts; pending fixes show up in `context` |
| **M5 Timing hints, overrides retired** | Q6, Q7 | tune sync with `[@mark +300ms]` and nudges without paying for new audio | hints parse, validate, diff; the sync edit honours them; a hint change reruns only edit and render; no new overrides files |
| **M6 QA everywhere** | QS adapters (vo, rec, an, sb first; disc after D2/D3), confidence folded | see checks after every phase, with the same popup | each adapter on its fixture; confidence badges replaced by findings without losing a signal (a test lists the old signals) |
| **M7 Deeper** | Q8, Q9 | ask the Director for a story-level review; more checks | the review's proposals enter the same loop |


## Slices (in order, each its own PR)
| Slice | What | Size | Depends on |
|---|---|---|---|
| **Q0 Diagnostics and calibration** | store the Whisper words and the matched word per anchor in the QA report; a calibration test (a fixture with a known planned drift: QA must reproduce it within ~100 ms); reconcile the two drift numbers; show measured + planned (D-QA-6). No behaviour change. | M | none |
| **Q1 Severity model + integrity checks** | `blocking` becomes `hard stop` for the two kinds only (integrity, a missed redaction, with the heavy override of D-QA-4); `qaBlocker` and the approve gate follow; new checks 16-18 (ffprobe: audio stream present and not silent, duration vs timeline, files present); noise rows 9-10 collapse into one summary; levels become high / normal / info | M | Q0 |
| **Q2 Finding identity + ignore scopes** | identity key per check (D-QA-3) with the fuzzy anchor rule; the ignore store in the project memory with SCOPES (this finding / this check in this scene / this check in the project) and a free-text comment (D-QA-4); "ignored in render vN: reason"; a project rule like "redactions ignorable (test data)" lifts that hard stop visibly; expiry when the scene's content changes | M | Q1 |
| **Q3 Flag + propose loop** | in the Render QA card each finding is **Fix / Ignore / Leave** (bulk: all, selected, by check) plus a free-text box; "Ask the Director for suggested fixes" is a visible Director task (W2/A2): it returns a LIST OF PROPOSALS (each: the finding(s), the stage it would change, the change, a rationale); the user selects, rejects, edits and adds free text; the round can repeat; a "fix set" record keeps the rounds | L | Q2, A2 |
| **Q4 Apply at the earliest stage + pending fixes** | on acceptance the Director decides the EARLIEST stage affected (discovery, storyboard, recording, voice-over, annotations) and applies those fixes there as ONE new draft (the working-draft and version rules unchanged; a recording or discovery change is a proposal to start that step, never an unasked take or a new discovery); the fixes for later stages are written to the project memory as PENDING FIXES (format: plain-text sentences + finding identity, target stage, proposed change, guidance text, status open / applied / dropped / superseded / stale; see D-QA-9); the tree shows the fix set linking the render, the findings, the new draft and the pending fixes; no render, no voice synthesis | L | Q3 |
| **Q5 Downstream consumes pending fixes** | the voice-over writer, the annotation designer and the storyboard writer read the pending fixes for their stage (in `demo_rec_project context` and in the input pack) and mark them applied or dropped with a reason; the panel shows "N pending fixes for this stage" on that stage's screen | M | Q4 |
| **Q6 Timing hints** | `[@mark +300ms]` (D-QA-5): parser, validation, diff, the sync edit uses it, nudge controls beside the anchor picture; changing a hint re-runs only the edit and render (audio cached): no credits | L | Q0 |
| **QS Stage QA (F32)** | QA after every phase, attached to the stage version (badge + popup, same Fix / Ignore / Leave flow). Built in three layers: (1) the findings model is made STAGE-AGNOSTIC from Q1/Q2 on (a finding names its stage and version, not only a render): do this inside Q1/Q2, it is nearly free now and expensive to retrofit; (2) ONE popup component ("Checks of <stage> vN": findings by level, the ignored, the pending fixes, actions) reused by every stage screen and by the Render inspector; (3) a small adapter per stage over detectors that already exist: QS-sb (storyboard: confidence signals, uncovered "use" findings, length vs target), QS-rec (take analysis findings, resumes, fallbacks, login screen visible), QS-vo (confidence signals + the render value check moved earlier, unused anchors, length vs target), QS-an (resolve warnings, redaction coverage, privacy scan, zoom cap), QS-disc (area coverage, blocked actions, evidence; needs D2/D3). Checks run automatically when a version is created (free and deterministic only: run-and-tell, A3), never block, never start a Director turn. | M (model + popup) + S per adapter (QS-disc M) | Q1, Q2, A3; popup with Q3 |
| **Q7 Retire overrides** | stop creating `*.overrides.json`; keep reading old ones (shown as "legacy timing fixes"); "Apply fixes" removed; QA.md and the guide rewritten; the render record names the fix set it came from | S | Q4, Q6 |
| **Q8 Coherence review (Director-led, optional)** | a separate, model-based review beyond the deterministic QA: does the narration claim what the footage shows, is the order coherent, does the goal in the brief come across; it produces proposals into the same fix-set flow, including "change the storyboard" and "more discovery here"; clearly labelled advisory | L | Q4 |
| **Q9 Catalog extras (optional)** | loudness vs −16 LUFS, length vs the brief, subtitle/transcript sanity, scene order vs storyboard | M | Q1 |


## Fuzzy anchor rule (D-QA-3's "reasonable flexibility")
Two findings are the same issue when: same check and same scene, and the anchor matches by (a) the same mark; or (b) the mark was renamed but the anchored phrase's first 3 words match; or (c) for a value, the normalized text matches (numbers compared by value, names case-insensitive). A finding with no anchor (a pause, a frozen picture) matches by scene and by being within 1.5 s of the previous position after the edit's timeline mapping, otherwise it is treated as new. An ignore is dropped when the scene's narration text hash changes by more than the anchored phrase.


Open design items inside the slices (not decisions): where the working focus lives in `state.json` and how it ends (approved, withdrawn,
abandoned); the exact format of a pending-fix entry; the exact wording of the proposal list; the popup's layout. Each is settled in the
slice that builds it, with a before/after screenshot where the panel changes.

## Risks
1. **Q6 timing hints** (script language + sync edit + inspector): the largest unknown; start with a spike on the sync edit.
2. **A2** depends on what pi's events allow; if turn end is not observable the fallback is the Director's own start/finish tool calls.
3. **Q0 may change everything**: if the measurement, not the fixes, was the main problem, Q4 and Q6 shrink and the drift numbers change meaning. That is why Q0 is first.
4. **Folding confidence into findings** touches screens from the UX pass (storyboard, voice-over); needs its own decision before M6.
5. A real-app run after M2 and again after M4 is the real test; budget a day for each.

