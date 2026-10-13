---
name: demo-brand
description: Creates and refines brand packages for demo-recording videos (title card, backdrop, inset frame, callout pill, logo bug) from a zip or folder of brand material — logos, colors, fonts — and switches the brand used for rendering. Use for /demo brand new, when the user wants their company/customer branding on a demo, or asks to change the look of rendered videos.
---

# Demo brand

A brand package controls how rendered videos look:
- the title card (it dissolves into the app);
- the backdrop behind the inset footage (rounded corners, soft shadow);
- callout pills and highlight color;
- an optional logo bug in a corner of the full video.

It never changes the recording, script or voice. Switching brands is a cheap
re-render (`demo_rec_edit action: rerender`): no LLM, no voice generation.

- **Built-in:** `neutral` (dark slate, soft-blue accent, no logo).
- **User brands:** live in `<root>/brands/<name>/`, outside the extension
  repo, so company logos never end up in a public package.

## Creating a brand (`/demo brand new [zip|folder]`)

1. **Explain what helps.** Ask for a zip or folder with as much as they have:
   - **Logo** in SVG (best) or PNG with a transparent background. Ideally two
     versions:
     - **light** (white or light mark) for dark backgrounds — used on the
       title card and backdrop;
     - **dark** for light backgrounds.
   - **Colors:** primary/accent, background, text. A style guide, a CSS file,
     a design-token JSON, or just hex codes in a text file all work.
   - **Font** (optional): woff2/ttf/otf, plus the license is theirs to check.
   - **Backdrop image** (optional): a subtle texture or gradient, 1920×1080.

   If they only give a website or a name, ask for the files. Don't download
   logos from the web unless they explicitly ask you to, and then say where
   the file came from.
2. `demo_rec_brand inspect source=<path>` shows the inventory, the hex colors
   found (most used first), and the **logo candidates as images** on a
   checkerboard, with measured luminance (light mark → `logoLight`). Look at
   them and pick the right files.
3. **Propose the mapping** to the user in a short table: the logo files for
   light and dark, the colors (`backdrop`, `backdropTo` for the gradient,
   `accent`, `text`, `muted`, `pill`, `pillText`), the font, and the frame
   (inset 0.88–0.94, radius 12–24, shadow 0.3–0.6). Keep it **calm**:
   - a dark or muted backdrop, accent from the brand's primary color;
   - text ≥ 4.5:1 contrast on the backdrop;
   - pill ≈ backdrop at ~90 % opacity (8-digit hex, e.g. `#1D1C24E6`).
4. After their OK, `demo_rec_brand create name=<kebab-name> source=…
   logoLight=… logoDark=… font=… settings='{"colors":{…},"frame":{…},"logoBug":{"enabled":true}}'`.
   It validates (contrast warnings included) and returns the **preview**: the
   title card plus a framed sample frame (a real keyframe if the project has a
   take). Show it and iterate with `update`.
5. Offer `demo_rec_brand use name=…` to make it the default. It's two-phase:
   show the diff, ask, then call again with `confirm: true`; scope global or
   project. Then offer `demo_rec_edit action=rerender brand=…` for the latest
   edit.

## Adjusting

- `update name=… settings='{"colors":{"accent":"#…"}}'` merges a patch.
  Built-in brands can't be edited: `duplicate name=neutral to=neutral-custom`
  first.
- The panel's **Brand** tab previews and tweaks the same fields.
- Keep logo bugs subtle: `opacity` 0.5–0.8, `heightPx` 28–40, bottom-right.
