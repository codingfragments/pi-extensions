# Brands

A **brand package** decides how a rendered demo video *looks*:
- the backdrop and how the recorded footage sits on it;
- the title card at the start;
- the colors of callouts and highlights;
- an optional small logo in a corner.

It never changes *what* the video shows: the recording, the cuts, the narration and its timing stay the same. Switching brands is therefore a cheap re-render. It needs no LLM and no new voice generation; the result goes to `render/vN/<brand>/` ([RENDER.md](RENDER.md)); one render can produce several brands at once.

Decisions behind this: D24 (brand packages), D25 (frame and title), D27 (brand switch). See [VISION.md](VISION.md).

## Contents

- [What a brand controls](#what-a-brand-controls)
- [Where brands live](#where-brands-live)
- [Package layout](#package-layout)
- [`brand.json` reference](#brandjson-reference)
- [Automatic decisions](#automatic-decisions)
- [How a brand is rendered](#how-a-brand-is-rendered)
- [Working with brands](#working-with-brands)
- [Validation and warnings](#validation-and-warnings)
- [Caching](#caching)
- [Trademarks and privacy](#trademarks-and-privacy)

## What a brand controls

| Element | Where | Notes |
|---|---|---|
| **Backdrop** | behind the footage, whole frame | A gradient from `colors.backdrop` to `colors.backdropTo`, or an image |
| **Footage frame** | the recorded app | **Inset** (default 92 % of the width, rounded corners, soft shadow, optional rim) or **full-bleed** (edge to edge) |
| **Title card** | first seconds of the full video | Logo, app name, demo title, date. It dissolves into the opening frame, under the intro narration. Per-scene videos have no title card |
| **Logo bug** | a corner of the full video, after the title | Off by default; needs a logo |
| **Callouts and highlights** *(S5, Annotations stage)* | over the footage | Pill colors (`colors.pill`, `colors.pillText`) and the accent outline (`colors.accent`) |
| **Font** | title card, callouts | A family name, or a font file shipped in the package |

## Where brands live

| Kind | Location | Editable |
|---|---|---|
| **Built-in** | `extensions/demo-recording/brands/<name>/` (shipped; currently `neutral`) | No. Duplicate it first (`neutral` → `neutral-custom`) |
| **User** | `<root>/brands/<name>/` (default `~/DemoRecordings/brands/`) | Yes |

If a user brand has the same name as a built-in, the user brand wins.

**Choosing a brand:**
- The **default brand** is the config key `brand` (default `neutral`), set globally or per project. The env var `DEMO_REC_BRAND` overrides both.
- A single render can name another brand (`demo_rec_edit … brand=…`, `/demo brand rerender <name>`, or the panel). That doesn't change the default.

**Names:** lowercase letters, digits and dashes (`acme`, `acme-dark`), at most 41 characters.

## Package layout

```
<root>/brands/acme/
├── brand.json         # settings (below); the only required file
├── logo-light.svg     # logo for DARK backgrounds (a white/light mark): title card, logo bug
├── logo-dark.svg      # logo for LIGHT backgrounds (optional)
├── font.woff2         # optional: woff2 / woff / ttf / otf
└── backdrop.png       # optional: 1920×1080 (or larger) backdrop image
```

- **Logos:** SVG is best, since it stays sharp at any size; a PNG needs a transparent background. File names are free; `brand.json` references them.
- **`brand-preview` files** are never stored in the package; previews go to `<root>/.cache/brand-previews/`.

## `brand.json` reference

Every field is optional; a missing field takes the default shown. Unknown color keys produce a warning; invalid values are errors with the exact field name.

### Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `displayName` | string | the folder name | Shown in lists and the Brand tab |
| `logo.light` | file (`.svg`/`.png`) | none | Logo for dark backgrounds: the title card and logo bug. With no `logo.light`, `logo.dark` is used (with a warning) |
| `logo.dark` | file | none | Logo for light backgrounds |
| `backdropImage` | file (`.png`/`.jpg`/`.webp`) | none | Replaces the gradient; drawn `cover`, centered, over `colors.backdrop` |

### `colors`

All colors are hex: `#rgb`, `#rrggbb`, or `#rrggbbaa` with alpha.

| Field | Default (neutral) | Used for |
|---|---|---|
| `backdrop` | `#14161d` | Gradient start, title card background, the color behind the footage plate |
| `backdropTo` | `#262a36` | Gradient end (radial, from the top left) |
| `accent` | `#8aa4f8` | Title-card rule, highlight outline, callout accents |
| `text` | `#f2f4f8` | Title text |
| `muted` | `#a3a9b8` | App name and date on the title card |
| `pill` | `#14161dE6` | Callout pill background (alpha ≈ 90 %) |
| `pillText` | `#f2f4f8` | Callout text |

### `font`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `family` | CSS font-family | `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | Font stack. With `file` set, the file is loaded as `BrandFont` and put first |
| `weight` | 100–900 | `600` | Weight for the app name, title and callouts (the title uses at least 600) |
| `file` | file | none | Font shipped in the package. You're responsible for the font license |

### `frame`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"inset"` \| `"fullbleed"` | `"inset"` | `inset` places the footage on the backdrop; `fullbleed` fills the frame (no backdrop, rim or shadow visible) |
| `inset` | 0.7–1 | `0.92` | Footage width as a share of the frame width. The 16:9 aspect ratio is kept and the footage is centered |
| `radius` | 0–60 px | `18` | Corner radius of the footage, px at 1080p |
| `shadow` | 0–1 | `0.45` | Strength of the soft drop shadow under the footage. Only visible on backdrops lighter than the shadow |
| `border.width` | 0–6 px | `1.5` | Rim width at 1080p, scaled with the output size; `0` turns it off |
| `border.color` | `"auto"` \| hex | `"auto"` | Rim color. `auto` decides per render ([below](#footage-rim-frameborder)); a hex color always draws, e.g. `"#632CA6AA"` |

### `title` (title card)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | Show a title card at the start of the full video |
| `durationMs` | 1000–8000 | `2500` | How long the card is fully visible |
| `dissolveMs` | 0–3000 | `800` | Cross-dissolve from the card into the video |
| `logoPosition` | `"inline"` \| a corner \| `"none"` | `"inline"` | Logo above the app name, in a corner at the card's safe margin, or not on the card |

**Where the text comes from:**
- App name: the project's app.
- Date: month and year of the render.
- Title: see [Title text](#title-text).

### `logoBug` (small corner logo)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `false` | Show the logo during the full video (it fades in after the title card) |
| `position` | `top-left` \| `top-right` \| `bottom-left` \| `bottom-right` | `bottom-right` | Corner |
| `opacity` | 0.1–1 | `0.7` | Keep it subtle: 0.5–0.8 |
| `heightPx` | 12–120 | `34` | Wanted height at 1080p. It may shrink to fit (see [below](#logo-bug-placement)) |

### Example: a company brand

```json
{
  "displayName": "Acme",
  "logo": { "light": "logo-light.svg", "dark": "logo-dark.svg" },
  "colors": {
    "backdrop": "#1b1430", "backdropTo": "#2a2047",
    "accent": "#9a6fe0", "text": "#f5f3fa", "muted": "#b9b1cc",
    "pill": "#1b1430E6", "pillText": "#f5f3fa"
  },
  "font": { "family": "\"Acme Sans\", system-ui, sans-serif", "weight": 600, "file": "font.woff2" },
  "frame": { "mode": "inset", "inset": 0.9, "radius": 20, "shadow": 0.4, "border": { "width": 1.5, "color": "auto" } },
  "title": { "enabled": true, "durationMs": 2500, "dissolveMs": 800, "logoPosition": "inline" },
  "logoBug": { "enabled": true, "position": "bottom-right", "opacity": 0.7, "heightPx": 30 }
}
```

## Automatic decisions

A few things are decided at render time from the project itself, so one brand works across very different apps.

### Footage rim (`frame.border`)

**The problem:** when the footage edge and the backdrop have similar brightness, the footage dissolves into the background. Examples are a dark app on a dark backdrop, or a light app on a light one. The shadow can't help on dark backdrops.

**`"auto"` checks each render:**
1. Reads the outer edge ring of up to 6 keyframes spread over the take, and averages its brightness.
2. Compares it with both backdrop colors, taking the worse (lower-contrast) of the two.
3. If the contrast is **≥ 1.8**, the footage already stands out and **no rim** is drawn.
4. If it's lower, a faint rim is drawn:
   - **light** (`#ffffff1f`, ~12 % white) on dark backdrops;
   - **dark** (`#00000026`, ~15 % black) on light backdrops.
5. When no keyframes exist (e.g. a preview without a take), the faint rim is drawn, which is harmless on any footage.

**How the rim is drawn:** it sits **outside** the footage, so it never covers app pixels. It follows the corner radius exactly (outer radius = radius + width), and its inner half-pixel tucks under the footage so the rounded corners blend with no gap. Zooms happen inside the footage, so the rim stays still.

The edit summary reports the decision, e.g. `footage rim #ffffff1f (auto: footage edge vs backdrop contrast 1.45 < 1.8)`. A hex `border.color` always draws; `border.width: 0` never does.

### Logo bug placement

The light logo is only guaranteed to have contrast on the backdrop, not on the app. So in **inset** mode the bug sits **in the backdrop margin**, centered vertically in it and aligned with the footage's left or right edge. It **shrinks to fit** the margin: at most margin − 12 px, at least 20 px. Only when the margin is thinner than that, or in **full-bleed** mode, does it go **inside the footage corner**, with padding.

### Title text

The title is the first match in this chain:
1. The brief's `**Title:**` (placeholders like `_TODO_` are ignored).
2. The approved storyboard's `title:` (≤ 60 characters).
3. The brief's goal, if it is ≤ 60 characters and not a placeholder.
4. The project name.

**When the title would just repeat the app name**, the card shows a single line, so there's no "KEYCRAFT / Keycraft".

### Title-card hold

The card covers the start of the full video. If the intro narration card is shorter than the card (`durationMs + dissolveMs`), the opening frame is held longer, so the dissolve never runs into moving footage. All later timings shift with it, and sync is unaffected. With a long enough intro, the video length is unchanged.

## How a brand is rendered

```
raw.mp4 pieces (trim / speed / held frames)
  → concat (scene time)
  → [S5 Annotations: page-space highlight, zoom — at source resolution]
  → scale to the inset box (lanczos) → rounded alpha mask
  → overlay on the backdrop (gradient/image + shadow + rim, one PNG)
  → [S5 Annotations: callout pill]
  → title card (full video only, dissolves out)
  → logo bug (full video only, fades in after the title)
audio: placed voice clips → mix → −16 LUFS
```

- **Overlays are PNGs:** all of them (backdrop, mask, title card, logo bug) are HTML templates rendered to PNG through Playwright, so fonts, SVG logos and CSS gradients look exactly like the preview.
- **Single scale-down:** the footage is scaled once, from the 3200×1800 capture to the inset size.
- **Brand assets are the same for every scene;** only the title card and logo bug are full-video only.

## Working with brands

| Task | How |
|---|---|
| List brands | `/demo brand list`, `demo_rec_brand list`, the Brand tab |
| Inspect brand material | `demo_rec_brand inspect source=<zip or folder>`: file inventory, logo candidates rendered on a checkerboard with measured brightness ("light mark → logo.light"), hex colors found in CSS/SVG/JSON/text, most used first |
| Create a brand | `/demo brand new [zip or folder]` starts the [`demo-brand`](../skills/demo-brand/SKILL.md) skill: it asks for material, inspects it, proposes the mapping and colors, creates the package and shows a preview. Directly: `demo_rec_brand create name=… source=… logoLight=… settings='{…}'` |
| Tweak | The panel **Brand** tab: color pickers, sliders for frame/title/logo bug/rim, **preview tweaks** on a real keyframe of the project before saving, then **Save** (shows the `brand.json` diff first) or **Save as copy**. Or `demo_rec_brand update name=… settings='{"colors":{"accent":"#…"}}'` (deep-merged, validated) |
| Duplicate | `demo_rec_brand duplicate name=neutral to=neutral-custom` or "Save as copy" |
| Set the default | `/demo brand use <name> [--project]`, `demo_rec_brand use …`, or "Set as default" in the tab. Always shows the config diff and writes only after you confirm |
| Render with a brand | the Render tab (tick one or several brands), `/demo render final|draft <name>`, `demo_rec_render brands=[…]`, or `/demo brand rerender [name]` (a draft). Same timeline, same voice; output in `render/vN/<brand>/` |

**Brand creation from material:**
- **Accepted input:** a `.zip` or a folder. Nested folders are fine, and macOS `__MACOSX` entries are ignored.
- **Copying files:** only the files you map (`logoLight`, `logoDark`, `font`, `backdropImage`) are copied into the package, under fixed names (`logo-light.svg`, …).
- **Safety:** paths outside the source are rejected, and the package is validated *before* anything is written.

## Validation and warnings

**Errors** reject the brand with the exact field: a bad hex color, an out-of-range number, a missing file, an unknown enum value. A broken user brand shows up in lists as `✖ <reason>` and can't be selected.

**Warnings** keep the brand usable:

| Warning | When |
|---|---|
| low text contrast | `text` on `backdrop` below 4.5:1 |
| low callout contrast | `pillText` on `pill` below 4.5:1 |
| accent barely differs | `accent` vs `backdrop` below 2:1 (highlights hard to see) |
| no `logo.light` | only a dark logo, which may vanish on dark backdrops |
| logo bug without logo | `logoBug.enabled` but no logo files |
| unused color key | a `colors.*` key the renderer doesn't know |

## Caching

**Brand assets** are cached in `<root>/.cache/brand-assets/<hash>/`. The hash covers:
- the brand settings and every file in the package;
- the output size;
- the title text;
- the rim decision;
- the HTML templates themselves.

Any change, including an extension update that changes a template, renders fresh assets. Deleting the cache folder is always safe.

## Trademarks and privacy

- **User brands stay outside the extension:** company logos and fonts live in `<root>/brands/`, never in the public extension repo or package. Built-in brands contain no third-party marks.
- **No downloading of brand assets:** the `demo-brand` skill doesn't fetch logos from the web unless you explicitly ask, and then it says where each file came from.
- **Fonts:** licensing is your responsibility; a font file in a brand package is only used for local rendering.
