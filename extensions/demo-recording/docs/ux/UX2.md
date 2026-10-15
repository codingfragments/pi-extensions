# UX2 report: the frame

Slice UX2 of the [UX pass](../UX.md): hash routes, a frame that says where each stage stands and what
needs you, and the Activity strip and drawer in place of the always-on Live column. The stage screens
inside it are unchanged (they move in UX3 to UX8), except Recording, which adopts the shared stage title.

## What changed

- **The place is in the URL** (`route.js`, D111): `#/project`, `#/voice`, `#/render`, `#/config`, and the
  grammar `#/<screen>/v<N>/<item>?query` is parsed and formatted now (the screens use it from UX3).
  Back, forward and reload work. A bare URL restores the last place in that project; a new project
  starts at Project. An unknown or unavailable route (`#/nowhere`, `#/map`) says so in a notice and falls
  back to Project. Navigation never changes project state (a test compares `state.json` byte for byte).
- **The stepper has five states** (`frame-state.js`): complete, needs you, running, blocked, not started,
  each an icon and a word. *Complete* needs the working-line version to be accepted and usable, so an
  approval on an unrelated branch does not complete a stage. *Needs you* is a draft newer than the newest
  accepted version, or the engine's next step. *Blocked* is an orphaned working-line version or a failed job.
- **The next-action band** names what needs you (or what is blocked), links to it, and lists the other
  pending items. It is a link, never an action, and it does not move you. When everything is delivered
  but a newer draft waits, it says so instead of "done".
- **Results never move you.** The five auto-switch effects are gone. A new storyboard, take, voice-over,
  annotation or render puts a *new* badge on its step; visiting clears it. History is told from news by the
  bus sequence number that `/api/state` now reports (`busSeq`), not by a time guess.
- **Truthful job state.** `GET /api/jobs` serves the engine's own job table. Running, failed and
  progress come from it; "waiting for the Director" is never shown as running; no percentage is shown for a
  job without progress; several jobs are counted. The designer and render jobs, which had no activity rows
  at all, have them now.
- **The status strip** is one line: nothing running, what runs, a failure (red, with *Show error*), or the
  connection. Screen readers hear changes of meaning, not every progress tick.
- **The Activity drawer** opens only on request, overlays, takes the focus, gives it back, closes on Escape
  (a dialog or popup first) and is closed again after a reload. An error never opens it. It holds running
  jobs, *Needs attention* (a failed job with details and *Dismiss*), recent jobs, the preview, safety and
  the log with its popups.
- **Recording** uses the shared stage title and design-system controls (its version machinery follows in UX3).

## Measured

Audit (`scripts/panel-audit.ts`, 40 pages: 10 screens × 2 themes × 2 widths), from the UX1 baseline:

| | UX1 | UX2 |
|---|---:|---:|
| serious axe nodes | 524 | **484** |
| `color-contrast` nodes | 364 | 324 |
| controls smaller than 24 × 24 px | 1046 | **800** |
| tab stops without a focus indicator | 0 | 0 |

Ratchet (`scripts/ux-ratchet.ts`):

| | UX1 | UX2 |
|---|---:|---:|
| hard-coded colours | 17 | 16 |
| font sizes that are not a token | 56 | 51 |
| border radii that are not a token | 61 | 56 |
| spacing values that are not a token | 224 | 205 |
| uses of a legacy variable name | 282 | 248 |
| legacy button-like classes | 10 | 8 |
| inline style literals | 0 | 0 |

The audit also caught two of my own mistakes on the way, both fixed before the baseline moved: at 900 px the
collapsed stepper labels were removed from the accessibility tree (`display: none`), leaving the links with a
poor name, so they are now visually hidden but still read; and the same rule had hidden the Project link.

## Screenshots

[images/ux/frame/](../images/ux/frame/): before (UX1) and after for Voice over, Render and Project, and the
frame's states: the "other items" menu, running jobs in the strip and the drawer, a failure in the strip and
the drawer. Regenerate with `scripts/panel-shots.ts --frame`.

## Guarding it

- `test/ux2-frame-state.test.ts` (11): the routes, the stage states, the band, the strip and the news
  rules, including: an approval on an unrelated branch does not complete a stage; waiting is not running;
  no invented percentage.
- `test/ux2-frame.test.ts` (5, browser): the URL, Back and the remembered place; fallback notices; the
  stepper and the band on the seeded project; a result that arrives does not move you or the focus; the
  strip with real jobs (running, progress, two jobs, a failure that stays until dismissed and never opens
  the drawer); the drawer's focus, Escape, overlay and reload behaviour.
- The existing control-room, log-popup, project, config and dialog tests moved to the new structure with
  their intent kept; the audit and ratchet baselines moved only after checking nothing was worse.

## Left for later slices

- The version context and History (UX3), the map (UX4: `#/map` is parsed but not available), drafts and
  the review screens (UX5 to UX7), Project (UX8), Config search (UX9).
- At 900 px the stepper shows dots with labels only for the current stage (names are on hover and read by
  screen readers). If that proves too terse, UX3 can add a stage menu.
