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
| [config.html](config.html) | Mock **Config** screen and a working **settings search** (UX9): seven real groups, every setting with its effective value and source, global / project / environment / default together, explicit "Edit global" and "Override for this project", an environment-shadow warning, `/` and Cmd/Ctrl+K to search, Escape to clear. Query strings: `q=voice&open=voiceName`, `q=tts&edit=ttsChain`, `project=none`. |
| [map.html](map.html) | Working **Project map** prototype (the UX4 overlay): column layout, curved edges, All / Approved / Production line, search with dim context, focus, grouped drafts, outline, keyboard (arrows, `/`). Query strings: `view=approved`, `q=final&sel=r8`, `focus=1&sel=vo2&open=g1`. |

## Files

| File | Role |
|---|---|
| `../../src/panel/public/ds/tokens.css` | The **only** file with colour literals: both themes, type, space, radius, elevation, motion, layers, layout. **The panel loads it too** (UX1): one source, no copies. |
| `../../src/panel/public/ds/base.css` | Global safe rules (one focus ring, `[hidden]`, reduced motion) and the element defaults scoped to `.ds-root`. |
| `../../src/panel/public/ds/components.css` | The `ds-` components. Tokens only. |
| `config.css`, `config.js` | The Config page component and its search prototype (fixture data with the real keys and groups). Moves into the panel in UX9. |
| `map.css`, `map.js` | The map component and its prototype logic. Moves into the panel in UX4. |
| `shell.js` | Builds the frame (header, stepper, next action, strip, drawer) for the mock screens. Replaced by the real frame in UX2. |
| `tile.css`, `tile.js` | Showcase page chrome and behaviour. |

## The real panel

UX1 made `ds/` the panel's own design system, and UX2 the frame: see [UX1.md](UX1.md) and [UX2.md](UX2.md).
`scripts/panel-shots.ts` (`--frame` for the frame's states) and `scripts/panel-audit.ts` run against a seeded
project (`test/helpers/panel-seed.ts`).

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

Committed in [../images/ux/](../images/ux/): the four mock screens (Voice over, Render, Config, Map) at 1400 and 900 px in both
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
