# Render

The Render stage turns an edit (recording + voice-over, synced) and an
annotation version into the videos you hand over. It is the last stage of the
chain:

```
storyboard → recording → voice-over → annotations → render
```

Every render is a **render version** (`render/vN.json` plus `render/vN/<variant>/`),
never overwritten — like every other stage. Renders are mechanical: they need
no model and no voice generation, and cost nothing but time.

Decisions D59–D68 in [VISION.md](VISION.md).

---

## Contents

- [Draft and final](#draft-and-final)
- [Options](#options): [annotations](#annotation-selection) · [brands](#brands) · [subtitles](#subtitles) · [logo bug](#logo-bug)
- [What a render produces](#what-a-render-produces)
- [The Render tab](#the-render-tab)
- [Accepting the deliverable](#accepting-the-deliverable)
- [Keeping disk space in check](#keeping-disk-space-in-check)
- [Who renders](#who-renders)
- [CLI and tool](#cli-and-tool)
- [The record](#the-record)
- [Performance](#performance)
- [Legacy renders](#legacy-renders)

---

## Draft and final

| | Draft | Final |
|---|---|---|
| For | watching the whole thing quickly | the deliverable |
| Needs | any annotation version — also your unsaved changes, or none | an **accepted** annotation version (the whole line accepted) |
| Size | 960×540, fast encoder preset | the configured output size (1920×1080) |
| Files | the video, its transcript and poster | the video, per-scene clips, transcripts, callouts, poster |
| Marked | a small **DRAFT** tag in a corner (never across the picture) | — |
| QA | — | checked automatically; hard stops (broken files, a leaking redaction) gate Accept ([QA.md](QA.md)) |
| Accept | no | yes — the deliverable |

**Every sync edit renders a draft** (`demo_rec_edit`), so you can watch the
result right away. Finals only come from the Render stage.

A final needs accepted annotations. For a demo **without** annotations, use
**Use no annotations** in the Annotations tab (it writes an empty version
you accept like any other) — or accept a version and include no annotation
types in the render (below).

---

## Options

### Annotation selection

Which annotation types a render includes is a **render option** (D66): by
default all enabled items of the annotation version; you can tick any subset —
none, chapters only, everything but spotlights, … The annotation version stays
exactly as approved; several renders of one version can show different cuts.

Leaving out **enabled redactions** asks for a confirmation: that render shows
what was redacted.

### Brands

One render can produce **several brands** at once; each becomes a variant
folder (`render/vN/neutral/`, `render/vN/acme/`). A variant that already exists
with exactly the same inputs (edit, annotation items, brand, options, size,
render code revision) is **reused** — its files are hard-linked, not rendered
again ("reused from v5").

### Subtitles

- A **transcript** (WebVTT) is always written: `…_transcript.vtt`, and per
  scene for finals. It comes from the voice's word timings, mapped
  through the edit (cuts, holds, speed changes) and the intro/bridge/outro cards.
  The players in the Render tab show it as a subtitle track.
- **Burn in subtitles** is an option: it writes `…_subtitled.mp4` (full video and
  scenes) **in addition** to the clean files.
  - Cues: ≤ 2 lines of ≤ 42 characters, ≤ 6 s, split at sentence ends and
    pauses; held 0.3 s after the last word, never into the next cue.
  - Style: the brand's font and callout pill colours, bottom centre of the
    footage; lifted above a callout that is shown at the same time.
  - Burned onto copies of the rendered files — cheap compared to the render.

### Logo bug

On by default when the brand has one (`logoBug.enabled`); untick to leave it
out of this render.

---

## What a render produces

Every file is named **`<project>_<kind>-v<N>_<flavor>`** — the flavor is the
brand plus what differs from the default — so files from several renders can
sit in one folder without clashing:

```
render/
  v7.json                                         the record (below)
  v7/
    neutral/
      my-demo_final-v7_neutral.mp4                the video
      my-demo_final-v7_neutral_subtitled.mp4      with burned-in subtitles (option)
      my-demo_final-v7_neutral_transcript.vtt     transcript (WebVTT)
      my-demo_final-v7_neutral_callouts.srt       callout texts and times (when the render has callouts)
      my-demo_final-v7_neutral_poster.jpg         the title card frame (1 s in without one)
      scenes/
        my-demo_final-v7_neutral_01-dashboard.mp4             per-scene clips (finals) — no chapter titles
        my-demo_final-v7_neutral_01-dashboard_transcript.vtt
        my-demo_final-v7_neutral_01-dashboard_subtitled.mp4
    acme_callouts-only/                           a second brand, only callouts
      my-demo_final-v7_acme_callouts-only.mp4
    my-demo_final-v7_neutral.zip                  ⬇ zip (all) of a flavor, built on request
```

The zip (stored, not compressed — videos don't shrink) unpacks into a folder
of the same name. It sits next to the flavor folders, so **Delete files**
removes it too.

Flavors: `neutral` (all annotations), `acme_plain` (no annotations),
`acme_callouts-only`, `acme_callout-chapter-only`, `…_nobug` (no logo bug); the
subtitled file adds `_subtitled`. A reused variant gets its new version's
names (`…_final-v8_…`), never the old one's.

---

## The Render tab

- **New render** — three groups:
  - **Kind:** draft or final. When a final isn't possible, the reason is
    shown ("annotations v4 are not accepted — accept them in the Annotations
    tab first").
  - **Annotations:** the version (accepted ones marked ✔, the working line
    marked; for drafts also *unsaved changes* and *none*), and which types to
    include.
  - **Look:** brands (several at once), burn in subtitles, logo bug.

  **Render** starts a background job (progress below and in the Activity drawer;
  **Cancel** stops it). One render at a time.
- **Renders** — the history, newest first (accepted deliverables on top), one
  collapsible card per version: kind, status, QA, what it was made from
  (annotation version, types, subtitles, logo bug, edit, size, time, who
  started it), **Accept** (finals) and **Delete files**, and:
  - a **flavor table** — one row per flavor (each brand, and its subtitled
    version): length, size, **⬇ mp4** (the video itself, under its full name),
    **⬇ zip (all)** (everything of that brand in one archive — clean and
    subtitled videos, scenes, transcripts, callouts, poster; built on the
    first click, then cached) and the extras as downloads (**transcript**, **callouts**, **poster**) plus
    **folder** (opens it in Finder / the file manager); **▸ scenes** expands
    the per-scene clips with their own ⬇ mp4 and transcript;
  - a **player** for the selected row (click a row or ▶; scenes too), with the
    poster and the transcript as a subtitle track (CC). It sits to the left
    of the quality check (about two fifths of the width) and stays pinned
    below the header while the findings scroll; the variants table is below,
    full width. A draft, with no quality check, keeps one wide player.
- **Legacy renders** — collapsed at the bottom ([below](#legacy-renders)).

---

## Accepting the deliverable

Every final is QA-checked first; accepting needs QA run and no open hard stop
(a broken file: render again; a leaking redaction: fix it — [QA.md](QA.md)). Finals can be **accepted** — one or several, like every stage (D67). An
accepted final is the delivered version: shown first, never pruned, and on the
working line (`… → annotations v4 → render v7`); the stage header then says
"delivered — final render v7". Drafts can't be accepted.

---

## Keeping disk space in check

- **Finals are kept.**
- **Drafts:** the newest `render.keepDrafts` (default 3; Config → Settings →
  Output & look) keep their video files; older drafts keep their record in the
  history, marked "files pruned".
- **Delete files** in the Render tab removes a render's files after a
  confirmation that shows the space freed; the record stays, marked "deleted
  <date>", so version numbers and the lineage never break. Deleting the files
  of an accepted final asks a second time; afterwards it can't be accepted
  again (render it again).

---

## Who renders

- **You, in the Render tab** (or `/demo render final|draft [brand …]`): a
  background engine job — no agent turn, no cost. When it finishes, the agent
  gets a quiet note for its next turn, so it knows what exists.
- **The agent** (`demo_rec_render`): it gets the report as a message when the
  render is done. After you accept annotations, it offers a final and asks
  which brands and whether to burn in subtitles.
- **The sync edit** (`demo_rec_edit`): always a draft.

The agent can't accept or delete renders.

---

## CLI and tool

```bash
# a draft of the latest edit (newest annotations of its voice-over)
node extensions/demo-recording/cli.ts render --project P

# a final of the accepted annotations, two brands, with burned-in subtitles
node extensions/demo-recording/cli.ts render --project P --kind final --brand neutral,acme --subtitles

# chapters only, no logo bug
node extensions/demo-recording/cli.ts render --project P --kind final --types chapter --no-logo

# a draft of the panel's unsaved annotation changes / without annotations
node extensions/demo-recording/cli.ts render --project P --draft
node extensions/demo-recording/cli.ts render --project P --annotations none
```

`--annotations N` picks the version, `--edit N` the edit, `--types none`
includes no annotations, `--confirm-unredacted` confirms leaving enabled
redactions out.

`demo_rec_render` (agent): `start` (kind, annotations, brands,
annotationTypes, subtitles, logoBug), `status`, `cancel`, `list`.

---

## The record

`render/vN.json`:

```json
{
  "version": 7, "kind": "final", "status": "done",
  "basedOn": { "annotations": 4 }, "timeline": 1, "voVersion": 1, "take": "take-001",
  "by": "panel", "createdAt": "…", "finishedAt": "…",
  "options": { "annotationTypes": "all", "subtitles": true, "logoBug": true },
  "brands": ["neutral"], "size": { "width": 1920, "height": 1080 },
  "variants": [{
    "key": "neutral", "brand": "neutral", "dir": "render/v7/neutral",
    "files": { "full": "my-demo_final-v7_neutral.mp4", "fullSubtitled": "my-demo_final-v7_neutral_subtitled.mp4",
               "scenes": ["scenes/my-demo_final-v7_neutral_01-dashboard.mp4"],
               "vtt": "my-demo_final-v7_neutral_transcript.vtt", "callouts": "my-demo_final-v7_neutral_callouts.srt",
               "poster": "my-demo_final-v7_neutral_poster.jpg" },
    "bytes": 8234567, "durationSec": 39.7, "reuseKey": "…"
  }],
  "qa": { "status": "pass", "blocking": 0, "confirmed": 0, "warnings": 1, "info": 6, "ranAt": "…" }
}
```

The record is updated while the render runs and when its files are pruned or
deleted; the output files themselves are never overwritten.

---

## Performance

On the fixture (40 s video, M-series Mac): a draft ~8 s; a final ~20 s per
brand (full video + 3 scenes); burning in subtitles adds ~3 s; a reused
variant ~0.2 s.

---

## Try it

[`scripts/fixture-walkthrough.fish`](../scripts/fixture-walkthrough.fish) runs
the whole pipeline on the fixture: the edit's draft, a draft with annotations,
the final gate, accepting, a final with burned-in subtitles, a callouts-only
cut and a reused variant, then the tests and the panel.

---

## Legacy renders

Before the Render stage, every edit rendered straight to `out/edit-vN/<brand>/`.
Those folders stay readable: the Render tab lists them under **Legacy
renders** with a player and Open folder.
