# Built-in brands

| Brand | Look |
|---|---|
| `neutral` | Dark slate gradient backdrop, footage inset at 92 % with rounded corners and a soft shadow, a soft-blue accent, a title card with the app name, demo title and date, and no logo. |

User brands, such as a company brand with its logo, are created with
`/demo brand new` (skill `demo-brand`) and live in `<root>/brands/<name>/`,
outside this repo. Format: see `src/brand/brand.ts`.

## Package layout

```
<root>/brands/acme/
├── brand.json        # colors, font, frame, title, logoBug (validated; contrast warnings)
├── logo-light.svg    # mark for DARK backgrounds (title card, backdrop, logo bug)
├── logo-dark.svg     # mark for light backgrounds (optional)
├── font.woff2        # optional
└── backdrop.png      # optional 1920×1080 backdrop image
```

The title card's logo placement is `title.logoPosition`: `inline` (default,
above the app name), `top-left`, `top-right`, `bottom-left`, `bottom-right`
(pinned to a corner at the card's safe margin) or `none`.

In inset mode the logo bug sits in the backdrop margin, aligned with the
footage edge, and shrinks to fit (min 20 px). The light logo only has
guaranteed contrast there. Full-bleed brands put it inside the footage corner.

