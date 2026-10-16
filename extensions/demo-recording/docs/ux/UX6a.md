# UX6a report: annotation drafts on the draft contract (engine)

Engine half of slice UX6 of the [UX pass](../UX.md) (D115, D121, D122), on the pattern of
[UX5a](UX5a.md). The annotations screen itself (list grouped by scene + inspector) is UX6b; the existing
screen keeps working with small changes (it sends the revision and shows a conflict).

## What was wrong

The annotation draft was **one file for the whole project** (`annotations/draft.json`): editing another
version silently replaced it (the screen only hinted "unsaved changes on v2"), two tabs overwrote each other
(last writer wins), and Save was not idempotent.

## What it is now

| Rule | How it is kept |
| --- | --- |
| One draft per base version | `drafts/annotations/v<base>.json` (atomic writes); a draft on v2 survives editing v3. The old `draft.json` is read once as the draft of its base (revision 1, author "migrated") and removed |
| No silent last writer | Every edit, discard and save carries the revision last seen (`revision` is **required**; `null` = "I have no draft"). A stale one is rejected and answered as data: `{ saved: false, conflict: true, message, …view }`, the view being the server's draft |
| Revisions never repeat | `v<base>.last.json`, as for the voice-over |
| *Save new version* once | Idempotent on the revision (a double click or retry returns the same version, `repeated: true`); a failure leaves the draft untouched |
| A draft stays on its base | `draft.flags`: "built on v1, v2 exists", "v1 was approved / its approval was withdrawn since you started this draft". Never moved or rebased |
| Edits keep their validation | At most 2 zooms, text ≤ 60 characters, no duration for a redaction, valid files only; a refused edit changes nothing, and an edit that changes nothing writes nothing |
| **Reset to suggested** | New op `reset`: every recorded change of an annotation (enabled, text, start, length, target with its alternatives) is undone from the first `from` each change recorded; the item is "suggested" again. Works after a reload and after Save (the edits travel with the item). Not for items added by hand, nor unchanged ones; `resettable` in the view lists the ones that can |
| Private until saved (D121) | Events carry the revision, the change and counts, **never the edited text** (a callout edit logs "text co-kpi edited"); no Director turn or note; and the **`demo_rec_annotations get draft=true` tool no longer returns the draft**: it says it is private until saved |

## Routes

`annotations-edit` `{ version, revision, author?, op, id, … }` · `annotations-save` `{ version, revision }` ·
`annotations-discard` `{ version, revision }` (names what is lost) · `GET annotations` now also returns
`draft.revision`, `draft.author`, `draft.flags`, `otherDrafts` (drafts on other versions) and `resettable`.
All stay cost class `none`.

Other users of the draft follow: *Approve* refuses a version with unsaved changes, a draft render (`fromDraft`)
renders the draft of the version asked for, else the one on the line's version, else the latest edited
(`render` data lists `drafts`).

## Guards

`test/ux6-annotation-drafts.test.ts` (10): one file per base and no replacement, stale revisions for edit,
discard and save, revisions never repeating and exactly-once save, refused and no-op edits, base-change flags
(newer version, withdrawn approval), the legacy file, Reset to suggested for every field (and after Save, and
the zoom cap), the routes (revision required, conflict as data, repeated save), and privacy. The older tests
use `test/helpers/annotation-drafts.ts`, which wraps the new API the way they used the old one.
