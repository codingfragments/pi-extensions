# Spike Q3 — zoom rendering (S5)

**Question:** how should the zoom render: ffmpeg expressions, or Node frame compositing? It has to work together with the brand inset, the backdrop and the overlays.

**Answer:** use ffmpeg's `perspective` filter.
- Settings: cubic interpolation, `eval=frame`, `sense=source`.
- Apply it **at source resolution**, after the per-scene concat and before the single scale to the inset.
- Only during zoom windows (`enable=between(t,…)`).

Measured, it is about 60× smoother than `zoompan` or crop expressions, sharp up to 1.8×, and costs ~0.25 s of render time per second of zoom. There are no new dependencies.

Script: `src/spike/zoom.ts`.
- Run it as `node src/spike/zoom.ts [real-frame.png]`.
- `DEMO_ZOOM_DEBUG=<id>` prints the per-frame error for one dot.

## Setup

**Source.** 3200×1800, the size of a dpr-2 capture of the default 1600×900 viewport. It is a still with Gaussian dots at known positions, so any motion in the output comes from the zoom alone.

**Output.** 1766×994 gray frames, the neutral brand's inset size.

**Zoom curve.**
- Zoom-in: 1 → 1.5× over 0.6 s with a smoothstep ease.
- Hold until 3.4 s, then 0.5 s back out.
- The source rectangle is linearly interpolated from the full frame to the target rect (centered on the box, clamped to the frame).

**Metrics.**
- **jitter:** RMS of the measured second difference minus the ideal second difference of each dot's tracked centroid, in px. Integer snapping shows up here; smooth sub-pixel motion gives ≈ 0.
- **drift:** RMS position error after removing each dot's constant offset.
- **speed:** the same graph on a real keycraft frame, encoded with x264 `medium` and crf 20.
- **sharpness:** mean absolute Laplacian of a text crop at full zoom.

## Results

| candidate | jitter RMS | worst jitter | drift RMS | speed | sharpness @1.5× |
|---|---|---|---|---|---|
| `zoompan` at source res (the classic approach) | 0.328 px | **1.67 px** | 0.43 px | 186 fps | 1.6 |
| integer crop at source res + scale (what `crop` x/y expressions give) | 0.385 px | 1.55 px | 0.45 px | 187 fps | 1.6 |
| `perspective` linear at source res → scale | 0.005 px | 0.02 px | 0.09 px | 98 fps | 1.4 |
| **`perspective` cubic at source res → scale** | **0.006 px** | **0.04 px** | **0.09 px** | 80 fps | **1.7** |
| scale to inset first → `perspective` cubic | 0.009 px | 0.06 px | 0.16 px | 137 fps | 1.2 (visibly softer) |

**Reading the table:**
- `zoompan` and crop snap to whole source pixels, which shows up as up to 1.7 px of frame-to-frame stepping during the ease. That's visible as a shimmer on text and borders.
- `perspective` interpolates below the pixel, so the motion is smooth.
- Cubic interpolation keeps text slightly crisper than linear.
- Zooming *after* the downscale upscales the footage: the divider lines and small text smear. Checked visually on keycraft's "Showing 12 of 17 products" line.

**Why source resolution matters.** A dpr-2 capture is 3200 px wide and the inset is 1766 px wide. A zoom of up to 3200/1766 ≈ **1.8×** therefore still has at least one source pixel per output pixel. The D26 maximum of 1.8× is exactly where zooms stay native-sharp. A dpr-1 capture would blur at any zoom, so the storyboard/doctor should warn when `viewport.dpr` < 2 and zooms are used.

**Real-chain cost.** Measured on keycraft take-003, 20 s, x264 `medium`:

| chain | time |
|---|---|
| current: scale early, no zoom | 1.1 s |
| zoom at source, `perspective` on every frame | 5.8 s |
| zoom at source, `perspective` only in a 3.6 s window (`enable`) | **1.9 s** |

## Gotchas found

- **`perspective`'s frame counter `in` is 1-based.** The time expression must be `(in-1)/fps`. Using `in/fps` renders one frame ahead, which first looked like a 4–8 px error during the ease.
- **`crop` evaluates `w`/`h` only at init.** Only `x`/`y` change per frame, so crop alone cannot zoom.
- **Commas inside filter options must be escaped.** `enable=between(t\,a\,b)` belongs in the filter script file. The renderer already uses `-/filter_complex <file>`.
- **This ffmpeg build has no `drawtext`.** Not needed: every text overlay is a Playwright-rendered PNG (D25).

## Node frame compositing

**Rejected without building it.** It would mean piping raw 3200×1800 RGBA frames (23 MB each) out of ffmpeg, resampling them in JavaScript (or adding a native image dependency), and piping them back. That is slower and more fragile than a filter that already measures sub-pixel smooth and native-sharp, with no dependencies.

## Integration design (part 3)

Layer order per scene and for the full video:

```
raw.mp4 pieces (trim/speed/hold at SOURCE res)
  → concat (scene output time)
  → [page-space overlays: highlight outline, drawn at source coordinates]
  → perspective zoom windows (cubic, enable=between(t, start, end))   one filter per zoom (≤ 2 per demo)
  → scale to inset (lanczos) → alpha mask → overlay on backdrop
  → [screen-space overlays: callout pill, logo bug, title card]
  → subtitles (burned-in variant only)
```

- **Only scenes with a zoom or highlight keep source resolution until after concat.** All other scenes keep the current early scale, so they don't get slower.
- **Zoom timing lives in scene output time.** It starts 0.6 s before the step's anchor (`out` time), holds until the next page change, the next zoom, or the scene end, then zooms out over 0.5 s. The full video offsets the windows by the scene's start, so they line up with the timeline anchors the sync editor already produces.
- **Target rect:** the logged target box (viewport CSS px × dpr → source px), grown to the 16:9 crop for the zoom factor, clamped to the frame.
- **Highlight (D26) is drawn before the zoom, in source space.** The zoom transform then carries it, so it follows the zoom for free. The outline width is set in source px (~3.6 px ≈ 2 px at 1×). Scroll offsets come from the event log's box at that moment.
- **Callouts, the logo bug and the title card are drawn after the inset.** They stay fixed on screen whatever the zoom does.
- **The cursor is part of the captured page**, so it zooms correctly with no extra work.
