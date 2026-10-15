# UX1 report: foundations in the real panel

Slice UX1 of the [UX pass](../UX.md): the design system from the style tile becomes the panel's own,
without a visible redesign. Measured on the seeded project (`test/helpers/panel-seed.ts`), both
themes, 1400 and 900 px.

## What changed

- **One source of tokens.** `src/panel/public/ds/{tokens,base,components}.css` is the design system.
  The panel loads it before `style.css`; the style tile pages link to the same files, so there is no
  second copy to drift.
- **Legacy names aliased.** `--bg`, `--card`, `--line`, `--muted`, `--ok`, `--warn`, `--err`, … now
  point at the tokens, so every existing rule keeps working while Latte's AA fixes apply everywhere.
  `--chip-strong` (defined, never used) is gone.
- **Safe global rules only.** One focus ring, `[hidden]`, reduced motion. The element defaults
  (headings, links, line height) are scoped to `.ds-root`, so the legacy screens do not shift; a
  screen opts in when it is migrated.
- **The part 13 dialogs, popups and toasts** use the `ds-` components (same hook class names, so the
  21 browser tests that use them pass unchanged): a diff with underline and strike-through instead of
  colour alone, a status icon on the danger dialog, a required-field message, `ds-btn` buttons.
- **The lightbox** sits below dialogs (`--layer-overlay`), as the layer order in the tokens says.
- **The log lines** show the focus ring (a legacy `outline: none` is gone).

## Measured

Accessibility audit (`scripts/panel-audit.ts`: axe-core 4.10.2 WCAG A/AA, tab stops, target sizes),
40 pages = 10 screens (7 tabs, 2 dialogs, a toast) × 2 themes × 2 widths:

| | before | after |
|---|---:|---:|
| serious axe nodes, all pages | 2019 | **524** |
| of which Latte | 1823 | **328** |
| of which Macchiato | 196 | 196 (unchanged on purpose) |
| `color-contrast` nodes | 1859 | 364 |
| tab stops without a visible focus indicator | 28 | **0** |
| `label` (critical), `select-name` (critical) | 148, 12 | 148, 12 |
| controls smaller than 24 × 24 px | 1058 | 1046 |

Legacy styling (`scripts/ux-ratchet.ts`, `style.css` and the panel scripts):

| | before | after |
|---|---:|---:|
| hard-coded colours | 51 | **17** |
| font sizes that are not a token | 60 | 56 |
| border radii that are not a token | 65 | 61 |
| spacing values that are not a token | 241 | 224 |
| uses of a legacy variable name | 305 | 282 |
| legacy button-like classes | 10 | 10 |
| inline style literals | 0 | 0 |

Dark theme is pixel-identical on every tab apart from the temp-folder path and timestamps in the Live
panel. Before/after screenshots (Latte, 1400 px) are in [../images/ux/panel/](../images/ux/panel/).

## What is left, and where it goes

| Left over | Fixed by |
|---|---|
| `color-contrast` (364 nodes: muted text and accents on the darkest and the tinted surfaces, legacy tints) | each screen when it moves to the components (UX2 to UX8) |
| `label` and `select-name` (160 critical: form controls without a name; Config, Project and the review notes) | UX5 to UX9, with each screen's controls |
| controls below 24 px (1046) | the `ds-btn` and form components are 32 px; each screen as it migrates |
| the legacy counts above | each slice lowers the baseline; UX9 deletes the rest |

## Guarding it

- `test/ux-ratchet.test.ts` fails when a legacy count grows, and also when one shrinks until the baseline
  is lowered (`node extensions/demo-recording/scripts/ux-ratchet.ts --update`), so an improvement is locked in.
- `test/panel-audit.test.ts` fails when the audit gets worse than `test/fixtures/panel-audit-baseline.json`.
  It is **skipped with a reason, never passed**, when Chromium or axe-core is unavailable.
- `test/ux-tile.test.ts` keeps the tokens AA in both themes and the tile pages linked to the panel's files.

## Run it (fish)

```fish
node extensions/demo-recording/scripts/panel-audit.ts
node extensions/demo-recording/scripts/panel-audit.ts --widths 1400 --themes latte --tabs voice,render
node extensions/demo-recording/scripts/ux-ratchet.ts
node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/panel-now
node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/panel-now --dialogs
```
