# UX5a report: working drafts (engine)

Engine half of slice UX5 of the [UX pass](../UX.md) (D115, D121). The panel half (list + inspector,
saving states, conflict choice) is UX5b. Nothing in the panel uses these routes yet; the old `vo-edit`
route (a new version per inline edit) stays until UX5b switches the UI over.

## The contract

A **working draft** is the user's own unsaved edit of an artifact. It is not a version.

| Rule | How it is kept |
| --- | --- |
| One draft per stage and base version | `drafts/vo/v<base>.json`, written atomically (write, then rename). Another base's draft is another file |
| Never a version | Not in `vo/`, so not in History, not in the map (the graph `rev` does not change), not in `voVersions` |
| Private until saved (D121) | No agent turn, no quiet note, and the events (`draft.changed`) carry stage, base, revision and a count, never the text. A test greps the whole project folder: the text is only in `drafts/vo/v<base>.json` |
| No silent last writer | Every write carries the revision it was based on. A stale one is **rejected** and answers `{ conflict: true, current }` (a 200 with data, so the panel can offer keep mine / take theirs / compare) |
| Revisions never repeat | `v<base>.last.json` remembers the last revision used, so a tab that missed a discard or a save is never mistaken for a current one |
| *Save new version* is exactly once | Idempotent on the revision: the same revision twice returns the same version (`repeated: true`). On any failure, validation included, the draft stays untouched and no version number is consumed |
| A draft stays on its base | When the base is approved or withdrawn, or a newer version exists, the draft is **flagged** ("built on v2, v3 exists", "v2 was approved since you started this draft") with the newest version's text next to each edited section for *Compare*. Never rebased, moved or dropped |
| Discard names what it drops | `draft-discard` returns the base, the revision and the sections that are gone; a stale discard is rejected |
| Only edited content | An edit equal to the base text is dropped, so `changes` is the number of sections that really differ. Review notes are **not** drafts: they stay in `state.json` with their own *Send to Director* step (D121) |

## Routes (all cost class `none`)

| Route | |
| --- | --- |
| `GET /api/drafts?stage=vo` | drafts with changes, each with what changed under it |
| `GET /api/draft?stage=vo&base=N` | one draft: its edits, flags, and each edited section next to the base and the newest version |
| `POST /api/draft-save` `{ stage, base, revision, edits, author }` | autosave; `edits` maps a section to its text, or `null` to drop that edit |
| `POST /api/draft-discard` `{ stage, base, revision }` | |
| `POST /api/draft-version` `{ stage, base, revision }` | Save new version: one version, one recorded input, one `vo.written` event |

Only the voice-over is edited inline today, so only `stage: "vo"` is accepted; the store is keyed by
stage for annotations and others later (annotations keep their own draft until then).

## Guards

`test/ux5-drafts.test.ts` (12): one file per base and atomic writes, revisions, edits equal to the base
dropped, scoping to the base, stale revisions for save/discard/Save new version, revisions never repeating,
exactly-one-version and idempotency, a failed save keeping the draft, the base-change flags (newer version,
approved, withdrawn), limits and validation, the routes, privacy (no turn, no note, no text in any event or
file outside `drafts/`, the map and `state.json` unchanged), cost class `none`, and the HTTP auth rules.

One known window: Save new version writes the version, then the `.last.json` record, then removes the
draft. A crash between the first two would let a retry write a second version; the window is a few
milliseconds in one process and the result is a visible extra version, never lost text.
