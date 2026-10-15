# UX0: style tile and component showcase

The visual proof for the control room redesign ([UX.md](../UX.md), D104, D110). Static
pages, no build step, no dependency, no panel code. **UX1 implements exactly what these
pages show, once you approve them.**

## Open it

```fish
open extensions/demo-recording/docs/ux/tile.html
```

Use the **Switch theme** button (Macchiato / Latte) and resize the window. `?theme=latte` also
works in the address bar. Press `/` on the showcase to focus the search field.

| Page | What it is |
|---|---|
| [tile.html](tile.html) | Tokens with **live measured contrast**, and every shared component and layout principle in all its states (14 sections). Live native dialogs and toasts. |
| [voice.html](voice.html) | Mock **Voice over** screen: frame, next action, version context, list + inspector, working draft, "Approve & use" disabled with its reason, Activity strip and drawer. |
| [render.html](render.html) | Mock **Render** screen: runs table, selected run with player, variants and QA, destructive and primary actions. |
| [map.html](map.html) | Working **Project map** prototype (the UX4 overlay): column layout, curved edges, All / Approved / Production line, search with dim context, focus, grouped drafts, outline, keyboard (arrows, `/`). Query strings: `view=approved`, `q=final&sel=r8`, `focus=1&sel=vo2&open=g1`. |

## Files

| File | Role |
|---|---|
| `tokens.css` | The **only** file with colour literals: both themes, type, space, radius, elevation, motion, layers, layout. |
| `base.css` | Element defaults, one focus ring, helpers. |
| `components.css` | The `ds-` components. Tokens only. |
| `map.css`, `map.js` | The map component and its prototype logic. |
| `shell.js` | Builds the frame (header, stepper, next action, strip, drawer) for the mock screens. |
| `tile.css`, `tile.js` | Showcase page chrome and behaviour. |

## What is enforced

`test/ux-tile.test.ts` (no browser needed for the first four):

- every text, non-text and focus pair in `tokens.css` meets **WCAG 2.2 AA in both themes**;
- both themes declare the same colour names;
- the scales stay inside the spec's limits (≤ 8 font sizes, ≤ 8 spacing steps, ≤ 6 radii, targets ≥ 24 px);
- no colour literal outside `tokens.css`, and no undeclared token;
- with Chromium: every page loads without console errors and without page-level horizontal
  overflow at 1400 and 900 px in both themes, the review layout collapses by **container**
  width, the map's filters, dim context, groups, focus and keyboard work, and the showcase
  dialogs are native (Escape, focus return, danger starts on Cancel).

## Screenshots

Committed in [../images/ux/](../images/ux/): the three mock screens at 1400 and 900 px in both
themes, and the map's states. Regenerate with:

```fish
node extensions/demo-recording/scripts/ux-tile-shots.ts
node extensions/demo-recording/scripts/ux-tile-shots.ts voice map      # only these
node extensions/demo-recording/scripts/ux-tile-shots.ts --sections --out /tmp/ux   # every showcase section
node extensions/demo-recording/scripts/ux-tile-shots.ts tile --out /tmp/ux         # the whole showcase page
```

## Responsive policy shown here

Four container thresholds, not window breakpoints: the list and inspector collapse below 52 rem;
two-column details and secondary table columns fold below 60 rem; the map hides its side panel
below 60 rem; the header drops stepper labels below 64 rem.

## Throw-away vs. kept

`shell.js` and the mock screens are prototypes: UX2 and later build the real frame. `tokens.css`,
`base.css`, `components.css` and the map's layout rules are the specification UX1 and UX4 adopt,
and a test will keep the panel's tokens in sync with them.
