# UX3 report: versions, approval and one vocabulary

Slice UX3 of the [UX pass](../UX.md) (D99, D103, D118): what you are viewing and how it relates to the
production line, a History of every version, four actions with an explicit consequence, and one
vocabulary on every screen. Browsing never writes.

## What changed

- **Viewing is separate from using.** The old input picker silently changed the production line when you
  chose another version to look at. It is gone. A screen shows the version in its address (`#/voice/v1`;
  none means the latest on the production line's input), and a **View** link only changes the route. Every
  screen says what you are looking at: *Viewing v2 · Draft version · Based on recording take-001*, and,
  when it is not in the line, in plain words: *You are viewing a new draft. Voice over v1 is in the
  production line, so the next steps still use v1.* A version in the address that does not exist is said
  ("Voice over v9 does not exist. Show the latest"), on every screen.
- **History** (a popover on each screen): every version, newest first, where it came from, and where it
  stands: *Viewing*, *In production line*, *Approved*, *Draft version*, *Blocked by dependency*, final or
  draft render. Versions on another branch are marked. Reading it writes nothing
  (`GET /api/history`).
- **Four actions, each with a free plan first** (`POST /api/version-plan`, then `POST /api/version-act`):

  | Action | What it does | Who is told |
  |---|---|---|
  | **Approve & use vN** (*Approve final vN* for a render) | approve it and make it part of the production line | a turn: the Director continues |
  | **Approve only** | approve it and leave the line exactly as it is | a quiet note |
  | **Use for next steps** | put an already approved version in the line | a quiet note |
  | **Withdraw approval** | take the approval back; what was built on it becomes *blocked by dependency* | a quiet note |

  A dialog states the consequence only when something leaves or changes in the line, or becomes blocked
  (*Production line now / After*, and a list such as *Recording: take-001 → none (stays approved)*). The
  everyday approval, where nothing leaves, stays one click. Nothing is deleted, other approvals stay, and
  the approval can be given again.
- **Applied once, only if nothing moved.** The plan carries a token of the state it looked at. If the
  project changed while the dialog was open, the server answers with a fresh plan instead of applying the
  old one, and the panel asks again (*The project changed while you were looking; this is what happens now*).
- **Approve only never changes the line.** It is refused, with the reason, where it would: the engine picks a
  default for a stage with nothing in the line, so approving the first version of a stage would select it.
  There the panel offers **Approve & use** only.
- **A disabled action says why**: the reason sits next to the button (*QA found 1 blocking item…*,
  *annotations v1 have unsaved changes…*), and the control is `aria-disabled` and described by it.
- **One vocabulary**, on every screen, in the engine's reasons and in the messages the Director reads:

  | Before | Now |
  |---|---|
  | accepted / accept | **approved** / approve |
  | un-accept | **Withdraw approval** |
  | working line | **production line** |
  | orphaned | **blocked by dependency** (the version it depends on is named) |
  | Approve / Request changes (on one scene, section or annotation) | **Mark reviewed / Needs changes** (it never approves the version) |
  | Approve high-confidence… | **Mark high-confidence reviewed…** |
  | Work on this | **Use for next steps** |
  | flavor | **variant** |
  | unsaved changes in annotations | **Working draft** |

  Stored names and the tools keep their old words (`accepted`, `line`, `orphaned`, `demo_rec_take propose`, formerly `accept`).
- **The old routes stay** (`approve`, `select`, `unaccept`, `unaccept-preview`) for the tools and older callers.
  `approveVersion` is a new engine function; `acceptStage` is untouched. The checks that decide what may be
  approved (QA gate, unsaved annotation changes, voice-over errors, an incomplete take) are one function used
  by the old route and the new actions.

## Measured (UX2 → UX3, 40 audited pages)

| | UX2 | UX3 |
|---|---:|---:|
| serious axe nodes | 484 | **436** |
| `color-contrast` nodes | 324 | 276 |
| controls smaller than 24 × 24 px | 800 | **772** |
| tab stops without a focus indicator | 0 | 0 |

| Ratchet | UX2 | UX3 |
|---|---:|---:|
| font sizes that are not a token | 51 | 50 |
| border radii that are not a token | 56 | 54 |
| spacing values that are not a token | 205 | 201 |
| uses of a legacy variable name | 248 | 241 |

## Screenshots

[images/ux/versions/](../images/ux/versions/): before (UX2) and after for Voice over and Recording; the summary
at 900 px; History open; the consequence dialog (*Approve and use storyboard v2*: what leaves the line, what stays
approved); a disabled action with its reason. Regenerate with `scripts/panel-shots.ts --versions`.

## Guarding it

- `test/ux3-versions.test.ts` (10, engine and routes): history, the plan of every intent, Approve only
  refused where it would move the line, one state write per action, a stale token refused, Use only for an
  approved and usable version, Withdraw lists what is blocked and keeps every file and can be undone, the
  gates, and who is told (only Approve & use starts a turn; history and plans tell no one and write nothing).
- `test/ux3-panel.test.ts` (4, browser): the summary and notice, History with keyboard and Escape and focus
  return, View links and Back, a missing version on every screen, Approve only / Use / Withdraw / Approve & use
  with their dialogs and turn counts, a disabled action with its reason, a stale plan shown again and applied
  once, and a scan of every screen for the old words.
- The control-room, confidence, dialog and render tests moved to the new controls and wording, intent kept.

## Left for later slices

- The review screens themselves (storyboard scenes, voice-over sections, annotations, renders) keep their
  layout until UX5 to UX7; this slice changed their head, their actions and their words.
- `Render` has History and per-final actions; its runs table, and a quick link from a version to the map,
  come with UX7 and UX4.
- A cheap **Undo** after an action (the spec's "offered where cheap") is not built: Withdraw and
  Use for next steps are themselves the undo.
