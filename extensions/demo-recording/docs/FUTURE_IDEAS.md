# demo-recording — future ideas

Ideas that came up while designing and are explicitly **not** in scope yet.
Each one names where it came from, so it can be picked up with its context.

| Idea | Origin | Notes |
|---|---|---|
| **Full annotation editor** | Annotation grill (D37) | Draw or move regions, add your own annotations from scratch, change the zoom factor, free timing on a timeline track. v1 keeps to toggles, text edits, ±0.5 s nudges and choosing between suggested zoom targets. |
| **Flexible stage lineage** | Annotation grill (D30) | Beyond the strict chain: render any combination of versions side by side (e.g. two narration styles with the same annotations), or a full version tree in the panel. |
| **Cursor frame-locking** | S5 grill (D28) | Only if cursor unevenness is still noticed in real takes. |
| **Background music** | S5 grill (D28) | Out of v1. |
| **Parallel discovery lanes** (long-run experiment) | User request, after S5 part 3 | **Flow:** after the serial identification phase (sitemap + candidate use cases), fan out N explorer lanes (Researcher instances as subagents).<br>**Per lane:** one candidate flow, its own browser context sharing the app login, its own budget slice, its own folder `discovery/<session>/lanes/<k>/` (screens, audit). Each returns a structured finding (verified targets, values, demo-worthiness, friction). The Director merges them and writes the storyboard.<br>**Progress:** one row per lane under the shared identification segment; per-lane frame preview in the Live control room. Part 4's progress component should support multiple rows.<br>**Needs:** lane-scoped `demo_rec_browser` sessions, per-lane budgets, subagents with the extension and an image-capable model.<br>**Safety:** read-only lanes by default; state-changing flows stay serial or get per-lane test accounts.<br>**Cost:** scales with lanes; opt-in via `discovery.lanes`.<br>**Expected gain:** about 2× wall-clock with 3 lanes on long discoveries (keycraft's took ~6 min, mostly model turns at ~5–15 s per action). Measure on a larger app first. |
