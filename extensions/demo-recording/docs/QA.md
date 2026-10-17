# QA

Every **final render** is checked automatically before it can become the
deliverable (D69–D75). QA is deterministic: no model judges the video; it
compares what was **said** with what was **shown**, listens to the rendered
audio, and looks at the picture. It runs right after the render, in the same
background job (a 40 s fixture final: ~4 s, Whisper included).

Drafts get no QA.

---

## What is checked

| Check | What | Level |
|---|---|---|
| **Values** | every number and name the narration says, against the page text at the moment it is said (the DOM snapshot at the segment's mark and the layout snapshot at that time). Spoken numbers are normalised: "fourteen point two percent" = 14.2 %, "three hundred forty one" = 341, "four point eight two million" = 4.82. Small prose numbers ("two questions") are not values. | a **number** nowhere in the scene → **blocking**; on screen at another moment of the scene → warning, with a re-time fix; a **name** not on screen → warning (names are guessed from capitals, so they never block) |
| **Footage** | error toasts (role=alert, `[class*=toast]`, … with an error level) and console / uncaught page errors — only inside the footage the edit **uses** (cut-away moments don't count) | error toast or console error → **blocking**; other toasts → warning |
| **Sync drift** | Whisper (config `align.model`) on the rendered audio; word starts refined on the audio envelope like the voice pipeline does; each anchor's narration start vs. its event in the full video | > 300 ms → **blocking**, 150–300 ms → warning, each with a re-time fix; Whisper not installed → one warning, sync not checked |
| **Picture & sound** | ffmpeg `freezedetect`, `blackdetect`, `silencedetect` on the full video | a still picture inside a hold of the edit → info; unexplained still ≥ 6 s → warning; black frames → warning; pauses ≥ 4 s → warning, shorter → info |
| **Annotations** | items of this render that can't be placed (warnings); a **redaction that doesn't cover its element** in later snapshots of its window (the element moved) → **blocking**; privacy-scan hits this render shows unredacted → warning | |

Only **blocking** items block accepting the final (D70). Warnings and info
are listed, never block.

---

## In the Render tab

Each final card shows its QA status next to the kind: **QA ✓**, **QA ✓
(confirmed)**, **QA: N blocking**, **QA not run** or **QA error**, and a QA
section with:

- the items, blocking first, then warnings and info (collapsed), each with a
  **▶ time link** that plays the video from just before that moment;
- for fixable items a **fix** checkbox (on by default) and **Apply N fixes**;
- for blocking items **Confirm & export anyway…** with a required reason;
- **Re-run QA** (after installing Whisper, for older finals, …).

**Accept** stays disabled while a blocking item is open; the reason is shown
next to it.

## Confirm & export anyway

A blocking item can be confirmed when it is intended ("the 14.3 % is the
forecast, not on screen"). The reason is required, stored with the item in
the QA report, and logged in the project's inputs (D73). When every blocking
item is fixed or confirmed, the final can be accepted. Re-running QA keeps
confirmations of issues that are found again.

## Fixes

Fixes are **mechanical** (D74): today, moving one narration segment so it
lands on its moment (from a drift or a value shown later than said).

**Apply fixes** makes a **new final render** — a new version on the same
annotations, brands and options — with the fixes as **overrides** on a copy of
the timeline (`render/vN.overrides.json`):

- the segment's audio moves by Δ; later segments are pushed when they'd
  overlap; the scene holds its last frame when the narration would run past it;
- the new render carries its source's overrides plus the new ones (shifts of
  the same segment are added up), and gets its own QA;
- the approved voice-over script, the audio and the annotations stay untouched.

Content problems — a wrong number, an error toast in the footage — are never
fixed automatically: change the voice-over, re-record the scene, or confirm.

## Sync diagnostics (measured beside planned)

The drift check does not only say "late by N ms". For every anchor it records, in `vN.qa.json` under `diagnostics` and as a table in
`qa-report.md`:

| | |
|---|---|
| **event** | where the picture's event is in the full video (scene start + the anchor's output time) |
| **measured** | where the transcript of the *rendered audio* puts the narration, raw and snapped to the audio onset; the drift the check reports is measured − event |
| **planned** | where the edit put the narration (scene start + the plan's audio time) and the drift that makes (audio − event) |
| **edit** | the same, from the edit's own timeline before any render override moved the narration |
| **gap** | measured audio start − planned audio start. It should be near zero: the render's audio should be where the plan put it |
| **matches, heard** | how often the anchor's first words were found within 3 s, and the words the transcript has around the match, with times |

A gap over 300 ms (`DRIFT_DISAGREE_MS`) is said in the item itself ("the edit planned +0 ms: the two disagree by 1,400 ms, so the
measurement or the render is off"), and when the narration lands on its moment but the gap is still big, an info item says so. **What
blocks does not change** (P1a Q0 only adds information); nothing acts on the measured number until the calibration shows it can be trusted
(PLAN_QA_CHANGE.md, D-QA-6).

## Files

```
render/
  v7.json             the record; "qa": { status, blocking, confirmed, warnings, info, ranAt }
  v7.qa.json          the report: every item (check, level, scene, time, message, fix, confirmed)
  v7/qa-report.md     the same as Markdown, for sharing
  v8.overrides.json   fixes applied by render v8 (on top of render v7)
```

## CLI and tool

```bash
node extensions/demo-recording/cli.ts qa --project P [--version N]           # show (runs QA if it hasn't)
node extensions/demo-recording/cli.ts qa --project P --version N --run       # re-run
node extensions/demo-recording/cli.ts qa --project P --version N --confirm drift-3 --reason "intended"
node extensions/demo-recording/cli.ts qa --project P --version N --fix all   # a new final with the fixes
```

`accept --stage render` respects the QA gate like the panel. The agent sees the
QA summary in every final's report and can show it (`demo_rec_render
action=qa`); it can't confirm items.
