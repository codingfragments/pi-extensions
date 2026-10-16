# UX9b report: the legacy CSS is gone

Slice UX9b of the [UX pass](../UX.md) (D114). No new feature: the old `style.css` (1,946 lines, 264 classes,
241 uses of the legacy variable names) is deleted, and the panel is styled by the design system alone.

## What changed

- **`style.css` is gone.** What the stage screens still need beyond the shared components lives in
  `src/panel/public/ds/screens.css`, written in the design tokens only. It was made from the old file by a
  script, then checked by eye: dead rules were dropped (a class no script uses, 23 of them), the legacy variable
  names (`--bg`, `--card`, `--line`, `--muted`, …) were replaced by their tokens, and every font size, radius and
  spacing literal became the nearest token. The three drop shadows became `--shadow-1…3`; the black behind video
  and stills, the lightbox backdrop and the title-card preview (which mimics the video, so it must not follow
  the theme) are new tokens in `tokens.css`. The legacy alias block (`:root { --bg: … }`) is deleted.
- **The last generic button classes were replaced** by the design system's: `ghost` → `ds-btn ds-btn--ghost`,
  `primary` → `ds-btn ds-btn--primary`, `tiny` → `ds-btn--sm`, `chip` → `ds-chip` with `aria-pressed`
  (filters, length presets, "need your eyes" jump chips), `segmented` → `ds-seg`, `pill` → `ds-badge` (an icon
  or a word, never colour alone), the render form's type and brand pickers → `ds-check`. The engine chips in
  Config are `cfg-engine`. The unused `st` review buttons are gone.
- **`app.js` is split.** It is six lines now and only starts the shell. `shell.js` is the frame (which screen
  the address names, the header, the band, the strip and drawer, the map overlay, the "new" badges); `brand.js`
  is the Brand editor; the Config wrapper (head, tabs, view) joined `config.js`. Every screen has its own module.
- **The ratchet is at zero** and stays there: `scripts/ux-ratchet.ts` now measures `ds/screens.css` and the
  scripts, and every count is **0** (colours, font sizes, radii, spacing literals, legacy variable names, legacy
  button classes, inline style literals). A line that holds a literal that is data, not styling (the colour
  input's hex default) says so with `ratchet-ok`.

## How it was checked

A before and after set of **163 screenshots** (every tab, both themes, 900 and 1400 px, plus the frame states,
dialogs, map, Voice, Annotations, Render, Project, Config and Storyboard modes) was compared. Every image
differs a little, because spacing now snaps to the 4 px grid (about 10 px of vertical drift in the worst places,
filters wrapping slightly differently); the worst ones were looked at side by side and the layouts match.
All 608 tests pass, including every browser test.

## Numbers

| | before | after |
| --- | --- | --- |
| `style.css` | 1,946 lines | deleted |
| colour literals / font sizes / radii / spacing literals | 16 / 50 / 54 / 201 | 0 / 0 / 0 / 0 |
| legacy variable uses / legacy button classes | 241 / 8 | 0 / 0 |
| `app.js` | 449 lines | 6 lines (+ `shell.js` 115, `brand.js` 285) |
| axe, serious / small targets (all pages, both themes) | 30 / 384 | 24 / 48 |

## Left for later

The Brand editor's markup is still the old one (its classes are styled by `screens.css`); UX9c's usability
review is where it would show up if it matters. Generic helper classes such as `card`, `row`, `muted`,
`small-text` and `grow` are still used by a few screens: they are styled with tokens now and can be replaced by
their `ds-` equivalents one screen at a time.
