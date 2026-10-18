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
| **Values** | every number and name the narration says, against the page text at the moment it is said (the DOM snapshot at the segment's mark and the layout snapshot at that time). Spoken numbers are normalised: "fourteen point two percent" = 14.2 %, "three hundred forty one" = 341, "four point eight two million" = 4.82. Small prose numbers ("two questions") are not values. | a **number** nowhere in the scene → warning that **needs your eyes**; on screen at another moment of the scene → warning, with a re-time fix; a **name** not on screen → warning (names are guessed from capitals) |
| **Footage** | error toasts (role=alert, `[class*=toast]`, … with an error level) and console / uncaught page errors — only inside the footage the edit **uses** (cut-away moments don't count) | error toast or console error → warning that **needs your eyes**; other toasts → warning |
| **Sync drift** | Whisper (config `align.model`) on the rendered audio; word starts refined on the audio envelope like the voice pipeline does; each anchor's narration start vs. its event in the full video | > 300 ms → warning that **needs your eyes**, 150–300 ms → warning, each with a re-time fix; Whisper not installed → one warning, sync not checked |
| **Picture & sound** | ffmpeg `freezedetect`, `blackdetect`, `silencedetect` on the full video | the still pictures the edit holds on purpose (and short ones) → **one info line** with where each is; an unexplained still ≥ 6 s → warning; black frames → warning; a pause ≥ 4 s → warning; the shorter pauses → **one info line** |
| **Integrity** | the files themselves: every file the render lists exists and is not empty; the video has a picture and is not more than 3 s shorter than the edit; when the edit has narration, the video has an audio track that is not silent (mean level above −55 dB) | any of these → **hard stop** |
| **Annotations** | items of this render that can't be placed (warnings); a **redaction that doesn't cover its element** in later snapshots of its window (the element moved) → **hard stop**; privacy-scan hits this render shows unredacted → warning | |

**Only two things stop a final** (P1a Q1a, D-QA-1): an **integrity defect** (the files are broken: render again) and a **redaction that
leaks** (a privacy matter). Everything else is a report: warnings that **need your eyes** first (a wrong number, a toast or console error
in the footage, a narration far off its moment), the other warnings, and info. You can approve a final that has findings; QA tells you
what to look at, it does not decide for you. Reports and records made before this change read with the new levels (a wrong number
that was "blocking" is now "needs your eyes"; "Re-run QA" refreshes the rest).

---

## In the Render tab

Each final card shows its QA status next to the kind: **QA ✓**, **QA ✓
(confirmed)**, **QA stopped it: N hard stop(s)**, **QA not run** or **QA error**, and a QA
section with:

- the items: **Hard stops**, **Needs your eyes**, **Worth a look**, then info (collapsed), each with a
  **▶ time link** that plays the video from just before that moment;
- for fixable items a **fix** checkbox (on by default) and **Apply N fixes**;
- for a leaking redaction **Export anyway…**, which asks for a reason; a broken file has no such button;
- **Re-run QA** (after installing Whisper, for older finals, …).

**Accept** stays disabled only while a hard stop is open; the reason is shown next to it.

## Export anyway (a leaking redaction only)

A **broken file cannot be confirmed**: render again. A **redaction that leaks** should be fixed (move or add it in Annotations, render
again). Only as a last resort can you export anyway: it needs a **reason** (on the command line `--confirm ID --reason R`). The reason is stored with the item in the QA report and logged in the project's inputs (D73, D-QA-4).
When every hard stop is fixed or confirmed, the final can be accepted. Re-running QA keeps confirmations of issues that are found again.

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

## Calibration verdict (P1a Q0, from the first real run)

The drift numbers of the first real run contradicted the edit's plan by up to 1.4 s (scene `06-faq-qa`: measured −1419 / +1004 / +946 ms,
planned 0 / +375 / +375 ms), and the same three or four items came back after every "Apply fixes". Re-running the check on that final
(render v8, 16 anchors) with the diagnostics above, and comparing with the speech onsets in the audio itself, gives:

| What | Anchors | Verdict |
|---|---:|---|
| measured within ±130 ms of the plan | 11 | the measurement and the edit agree: both fine |
| the **transcript** was wrong | 2 (`mirror-reply`, `faq-loaded`) | Whisper stretched the first word back over the pause before it, and the onset refinement then handed the onset to the *next* word. Reported −280 ms and −1419 ms; the audible narration is +45 ms and +41 ms from the plan. The old "move it later by 1.4 s" fix would have broken a correct anchor |
| the **plan** was wrong | 2 (`faq-expanded`, `recommended-products`) | the voice's own timestamps (ElevenLabs, model `eleven_v4`) put the segment starts about 0.6 s before the audible words (section audio: speech onsets at 2.74 s and 4.69 s, the provider said 2.11 s and 4.12 s). The edit trusted them, so the viewer hears +1004 / +946 ms where the edit planned +375. The QA was right here |
| not found in the transcript | 1 (`order-summary`) | coverage: the words of the anchor were not recognised |

So **neither side was simply right**, and a fix that acts on one number was the reason QA never converged: it moved correct anchors the
wrong way. What changed in the check (the same PR): a word start that is not on a speech onset is not believed; the anchor's start is the
first speech onset around its first two words (falls back to the old snap); both the transcript's and the plan's relation to the audio
onsets is recorded and said in the item ("the transcript's word start is on a speech onset, so the measurement is probably right and the
plan is off", or the reverse). On this final the two transcript errors are now measured at +45 and +41 ms.

The calibration harness (`test/p1a-qa-calibration.test.ts`, needs ffmpeg, uv and macOS `say`) builds a mix of real speech at known
times, one phrase planned 400 ms late, and runs the real check on it:
- **Accuracy:** every anchor that was found was measured within 100 ms of the planned drift, in every run.
- **Coverage:** Whisper is not deterministic on this audio; the same mix finds 0 to 3 of the 3 anchors from run to run (it can drop
  words, or the start of the audio, when the prompt is shaped a certain way). QA must say "not measured" for those and never guess.

What this means for the plan (see PLAN_QA_CHANGE.md): fixes may act on a measurement only when it was found *and* its word start is on an
onset; the plan side got its own fix (below); and coverage
is a known limit to design around, not to hide.

### The plan side: anchors go where the narration is heard (Q0c)

A provider's word timestamps are not always where the words are audible (ElevenLabs `eleven_v4` was about 0.6 s early after a pause, and
sometimes 100 to 130 ms late). The voice step now moves each anchor of a provider alignment to the nearest **speech onset** (a rise out
of at least 150 ms of quiet): up to 250 ms earlier, or later as long as the onset is still inside the first word's own span (the provider
says that word occupies that time; an onset after the word is another word, so the anchor stays). No onset nearby: the provider's time
stays. The alignment is marked `snapped`; **older cache entries are upgraded once** when they are next read (no new synthesis, nothing
billed), but a voice-over that was already synthesized needs "Generate voice & render" (cached: free) to write the new anchors into its
manifest and a new edit. On the first run's voice-over 12 of the 16 anchors moved (most by 10 to 130 ms) to the onsets the QA had measured
(`faq-expanded` 2.11 → 2.74 s, `recommended-products` 4.12 → 4.69 s).

## Findings of any stage, coverage, and the checks popup (Q1b)

- **A finding names its stage and version** (`stage`, `version` on every item and on the report), so QA is not tied to a render. One view,
  `GET /api/checks?stage=<stage>&version=<n>`, returns the findings, the summary, the coverage and why there is nothing when there is
  nothing. Only the render has checks today; the other stages answer "no automatic checks yet" (their adapters come with "QA after every phase").
- **Coverage is said.** The report records how many anchors were measured: "sync measured at 11 of 16 anchors". The ones the transcript did
  not contain become one info line naming them and where they are; sync is not checked there, and nothing guesses.
- **A fix acts on a measurement only when it sits on a speech onset** (`supported`). A narration that is off by a lot but measured mid-flow
  is still reported, with "not offered as a fix", never as a number to act on.
- **All checks…** on a final's Quality check opens **Checks of render vN**, the one popup every stage will use: the findings in the same
  groups with the coverage line. It is read-only for now; Fix / Ignore / Leave, the ignored list and the pending fixes arrive with the
  flag-and-propose loop.

## Decisions are remembered: ignores (Q2)

QA used to raise the same items after every render, however often you had looked at them. Now you can **leave a finding alone**, and the
project remembers (the panel's **Ignore…** on a finding, `qa --ignore ID --scope … --reason …` on the command line):

- **A finding is the same finding by what it is, not by its numbers**: its check, its scene and what it is about (the anchor mark, the
  value said, the toast's text, the redaction's id), never its timings. A renamed mark is found again by the first three words of its
  phrase; a value matches by its normalised form; a pause or a still picture matches by kind and by staying within 1.5 s of where it was
  in its scene.
- **A scope you choose, and a reason you write.** *Only this finding*; *this kind of finding in this scene* (for example the pause warnings
  in `02-search`); or *this kind of finding in the whole project*, a rule ("leaking redactions: this is test data, no PII").
- **It covers the finding in every later render of the same content** and shows as "ignored (scope, since render vN): reason". It stays in
  the report and in the checks popup, out of every count.
- **It ends when its content changes**: the scene's narration for findings about the story, the take for a toast in the footage. The ignore
  is kept as "ended: the narration of 01-dash changed (render v9)" and the finding is raised again. A project rule never ends by itself.
- **A broken file can never be ignored**: render again. A leaking redaction can be (with a reason); under an ignore it counts as a
  *confirmed* hard stop, so the lift is visible in the summary, and a project rule makes that the same for every render.
- **The Director reads the decisions** in the project context ("QA decisions"), is told when you ignore something, and does not raise it
  again or ask about it. **Stop ignoring** removes the decision and brings the finding back.

## Suggested fixes: flag, propose, rethink, decide (Q3)

You do not have to hunt for the cause of every finding. In the Quality check of a final:

1. **Flag.** Every finding that is a judgement call has **Fix** and **Leave** (Leave is not Ignore: it only keeps the Director away from it
   this time). The toolbar flags many at once ("all that need your eyes", "all", "none"). A broken file and info cannot be flagged.
2. **Add context** (optional): what matters, what to keep. It is saved as you write.
3. **Ask the Director for suggested fixes.** This starts a Director turn (the band says what it is doing). It reads what you flagged in
   full, your context and what you already decided to leave alone (`demo_rec_qa context`), thinks about the **cause**, and answers with
   `demo_rec_qa propose`.
4. **Read the proposals.** The goal is **one run at the earliest stage that needs a fix, fixing as many problems as possible**, so an
   answer has **at most one proposal per stage** (the tool refuses two for the same stage: it must merge them), the earliest stage is shown
   ("the earliest stage that needs a fix: Voice over; one run there fixes 2 findings"), every finding you flagged is answered or named
   under "the Director could not fix" with a reason, and every proposal says concretely what would change, why, and what applying it costs.
5. **Decide**, per proposal: **Accept**, **Reject**, **Edit the wording** (your own text replaces the Director's), and a **note**.
6. **Rethink.** Write more context ("only fix the numbers, keep the intro") and **Ask the Director to rethink**: it sees the earlier
   rounds with your decisions, edits and notes, and proposes again. As many rounds as you like; a note on a stage carries over.

**Nothing is applied by deciding**: no voice-over, annotations or render version is made, nothing is synthesized, the script is untouched.
The rounds are kept in the project
(`fixes/fs-N.json`), the Director sees fix sets in progress in the project context ("QA fixes in progress"), and the Director has no tool to
accept or apply anything (a test enforces it).

## Apply: one new draft at the earliest stage (Q4)

When you have accepted what you want, **Apply N accepted proposals** does this, and only this:

- The earliest stage that has an accepted proposal gets **ONE new draft**: the Director (a visible turn, "Writing the voice-over draft from the
  fixes you accepted") reads the accepted proposals with `demo_rec_qa context`, in **your own wording** where you edited, and writes the new
  version with the stage's tool (a voice-over based on the current one, a storyboard, annotations). It is an ordinary draft: you read it, verify
  it and approve it. **Nothing is rendered and nothing is synthesized**; voice costs credits only after you approved the script, and then only behind
  your Allow. The Director adds nothing beyond what was accepted.
- The accepted proposals for **later stages** become **pending fixes** in the project (a sentence, your note, the findings it answers and what
  they are, so they can be recognised again). The stage's writer takes them into account when its turn comes, and the Director reads them in the
  project context. A pending fix is memory, not a to-do list the engine runs.
- A **recording or discovery** fix is never done inside this flow (a new take is something you start, with its own Allow): the button says "Keep
  the accepted fixes for when I start the recording", and they are kept as pending fixes.
- The draft is **linked to the fix set**: the band says "Needs you: review voice-over v3 (fixes from render v8)", the panel says "Applied.
  Voice over v3 is a new draft written from your accepted fixes", and the production line still means approved and usable.
- You can apply a fix set once. Rejected proposals are neither applied nor kept.

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
