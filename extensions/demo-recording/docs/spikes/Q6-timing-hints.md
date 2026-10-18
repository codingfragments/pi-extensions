# Spike Q6: can the sync edit take a per-anchor timing hint?

**Question.** `[@mark +300ms]` should make the narration after a mark start 300 ms after the mark's event (negative: before) without new
audio. Can the sync solver do that without breaking its guarantees (no cuts through speech, protected typing at 1.0×, no freezing of
in-app motion, anchors on their events)?

**Answer: yes, with a one-line change to the solver.** Run on the real keycraft data (take-001, voice-over v3, seven scenes), a hint on the
first aligned anchor of every scene at +300, −300, +1500 and −1500 ms was met **exactly** in all seven scenes (deviation 0). The video
does the work: it is stretched or shortened before the event, the narration pieces do not change.

## What changes in the solver

The solver pairs each take event with a narration time. With a hint `h` on anchor `m` the narration after `m` is placed at `event + h`, so
the video span before the event is paired with the audio time `A_m − h` (instead of `A_m`), the audio piece is placed at `out_m + h`
(never before the end of the previous piece, never before 0), and the end of the scene follows the last hint. That is all.

- `drift` is redefined as **`audioAt − out − hint`**, the deviation from where the narration was *meant* to start, so everything that reads it
  (the off-sync warning in the edit report, the fit check, the QA drift check, `worstDriftMs`) keeps its meaning without change. `hint` is a new
  field on every anchor.
- The QA drift check measures the narration against the event **plus the hint** and says "after where you set it (its moment +300 ms)".

## Findings worth knowing

- **The cache key is the text only** (`cacheKey(identity, text)` over the section's *spoken* text, anchors removed). A hint lives inside the
  anchor token and is parsed out, so it is never spoken, never synthesised and never part of the key: a hint-only change is a 100 % cache hit,
  0 characters billed. No change to the synthesiser was needed.
- **A hint moves the picture's event against the narration, not the narration.** The narration pieces are identical with and without a hint
  (same audio, same cut points); only where the event falls in the output changes. The scene duration usually does not change.
- **Downstream anchors inherit what the video cannot absorb.** That is the existing physics (the baseline already has 375 ms on several
  anchors in keycraft), not something hints add; a hint just moves it.
- **The solver's last-resort hold applies even in a fully protected scene** (a frame is held at the event); typing and clicks are still never
  sped up or cut. A hint therefore almost always lands exactly; what it cannot meet shows as a deviation, never silently.
- **A malformed token used to be spoken as words.** `[@mark 300ms]` or `[@Mark]` did not match the anchor pattern and went to the voice. The
  validator now reports any `[@…]` that is not an anchor as an error.
- **Size.** ±1500 ms is realisable in all seven scenes and makes scenes up to 1.5 s longer; the limit is ±3000 ms (an error beyond it,
  a warning above ±1500 ms).

## Open

- Whether a +/−100 ms nudge is the right step and ±3 s the right limit is a judgement call until a real run.
- A hint on a recording whose take has no marks near the anchor is untested on real footage beyond keycraft.
