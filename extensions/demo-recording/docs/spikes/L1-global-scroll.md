# Spike L1b: one scroll for the page, on Storyboard, Recording, Voice over and Annotations

**Question (R3-2, R3-5, and your note after R3-5).** The wheel works over the list at the side but not over the main area, on Voice over and
Annotations; the storyboard has nothing to keep in view; "let's go back to one global scroll on the page (and on Voice over, Recording and Storyboard),
have me review it and then find another solution".

**Answer: remove the pin and every scroll area of these four screens; the page is the only scroll. The wheel then behaves the same everywhere on them.**
What you wanted from the pin (the picture or the player stays in view while you read) is not there any more; the options for getting it back
without a second scroll area are listed at the end, to decide after you have tried this.

## What was measured (a real browser, 1400 x 900, a long list, the section pinned)

| # | Observation | Consequence |
|---|---|---|
| L1 | The wheel over the main area left the page where it was (scroll 900 before and after ten notches); with `overscroll-behavior: auto` it scrolled to 2900. | R3-5 is the bug it looked like: the pinned block is its own scroll area and `overscroll-behavior: contain` stops the wheel from reaching the page, whether or not the block has anything to scroll. |
| L2 | The pinned block is `position: sticky` with a `max-block-size` of one window and `overflow: auto` on the inspector (`.ds-detail-pin`, D-R2-6). Voice over, Annotations and Storyboard share it. | One rule change fixes the three. |
| L3 | The Recording review has its own: the player pane (`.ds-rv-pane`) and, at 72 rem and wider, the notes column are sticky with their own `overflow: auto`; the scene's goal and findings (`.ds-rv-context`) scroll inside 30vh. | Same wheel trap, three more scroll areas. |
| L4 | The action bar (Save new version, the save state) is `position: sticky` to the bottom of the window. It is not a scroll area and does not swallow the wheel. | It can stay; it only had to become a direct child of the detail cell so it sticks across the whole height of the list (the cell is as tall as the list), not only inside the old pinned block. |
| L5 | Render has a pinned player (two fifths wide) that is released at the end of the findings. It scrolls nothing inside itself and you said it works. | Left as it is (decided). |

## What changed

- `.ds-detail-pin` is `display: contents` (the markup still groups the inspector and the bar, the wrapper takes no box). No sticky block, no max height, no
  inner scroll, no overscroll rule. The action bar gets `margin-block-start: auto`, so in a tall cell it sits at the end and sticks to the window bottom.
- `.ds-rv-pane`, `.ds-rv-notes` and `.ds-rv-context` lose sticky, max height and overflow. The narrow layout (below about 52 rem: the list is a select,
  the review stacks with the player first) is unchanged.
- Tests: `list-screens` and `recording-review` now assert the opposite of the pin: nothing in the split or the review scrolls on its own, nothing but
  the action bar is sticky, the detail moves with the page, a wheel over the main area and over the player scrolls the page, the action bar is at the
  bottom of the window and ends with the list.
- Decision **D145** (supersedes D-R2-6 for these four screens).

## What you lose, and the options to get it back (for after your review)

| Option | What stays in view | Cost / risk |
|---|---|---|
| **A. Nothing (this PR)** | nothing; the page is one scroll | simplest; the Recording player and the storyboard picture scroll away while you read the notes or the steps |
| **B. Sticky small block only** (the player, or the scene's picture), no inner scroll, no `max-height` bigger than its content | the one thing that makes sense to keep | a sticky block taller than the window hides what is under it; it must be small (the player at 40vh is) and never contain a scroll area |
| **C. A compact sticky title row** (scene name, status, Previous / Next) above the page content | where you are and the two moves | the detail itself scrolls; no picture |
| **D. A "back to the player" control** (a small button that scrolls to it) | nothing, but one click returns | cheap; adds a control |
| **E. Keep the pin but let the wheel through** (`overscroll-behavior: auto`) | the whole block | still a scroll area inside the page; the wheel works at the ends only and moves the inner area first, which is what you called counter-intuitive |

My recommendation after you have tried A is **B for the Recording player only** (it is the one place where something you act on, the video, has to
stay visible while you write a note), and nothing elsewhere.

## Try it

- `node extensions/demo-recording/scripts/panel-seed.ts /tmp/demo-try --port 4748` and open Voice over, Annotations, Storyboard, Recording at 1400 and 900 px.
- With the wheel over the detail, over the list and over the player: the page scrolls in every case, nothing sticks except the action bar at the bottom.
