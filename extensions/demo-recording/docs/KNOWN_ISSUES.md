# demo-recording: known issues and things to fix later

Defects and unverified things that are known, not fixed, and not blocking. Each says what was seen, what is not known,
what would be the fix, and what would make it worth doing. Features that are only wanted live in
[FUTURE_IDEAS.md](FUTURE_IDEAS.md) and [VISION.md](VISION.md#later-wanted-not-scheduled).

| # | Issue | Seen | Not known | Fix when it matters | Where |
|---|---|---|---|---|---|
| 1 | **Typing into the Voice narration before its draft has loaded can lose the first character** | Once, in the UX9c review: with six test runs in parallel, a test typed the instant the textarea appeared and the narration lost its first typed character (`yping…` instead of `typing…`). | Whether it can happen outside heavy load: 48 sequential rounds of the same typing, in four parallel processes, lost nothing. | Make the field read-only, with a visible "loading draft" state, until the draft has loaded; or merge a late-arriving draft without overwriting what was typed. Add a test that delays the draft response and types immediately. | the Voice inspector (`voice.js`, `drafts.js`) |
| 2 | **Two tests fail now and then under full-suite load and pass alone** | "resume: an error in scene 3 restores state by replaying scenes 1–2 off-camera and stitches" and "recordTake: 3200x1800 frames, monotonic events on the take clock, exact CFR master". | The cause. It was not reproduced in four parallel runs. A timing or load dependence in the recorder (a fixed wait, a shared port, the screencast frame budget) is the likely family. | They now retry once and print every failed attempt (`test/helpers/retry.ts`), so a flake is loud instead of random red. **If `[flaky]` lines appear in CI logs, that is the evidence**: find the wait they have in common and make it deterministic, then remove the retry. | `test/s1-capture.test.ts`, `test/s3-recording.test.ts` |

## Unverified (works in tests, not tried on the real thing)

| What | Why unverified | How to check |
|---|---|---|
| **The map with a physical trackpad and in Safari** | The browser tests send the events a trackpad sends (small, fractional and sideways wheel deltas, Ctrl + wheel, Safari's gesture events); nobody has used a real one. The wheel / trackpad tell-apart is a heuristic. | Pinch, two-finger drag and the mouse wheel on the map. If it guesses wrong, set **Wheel: Zooms / Scrolls** and note what the device sent (see [UX19](ux/UX19.md#trackpad-pinch-and-two-finger-pan-independent-of-the-wheel)). |
| **Previews, the Render player and a real render, in the panel** | Every panel review used a synthetic seeded project. | Re-record keycraft on a real app and run the Annotation designer with a real model. |

## How to add to this list

One row per issue: what was seen (with the evidence), what is not known, the fix, and what would make it worth doing.
Move a row out when it is fixed (and say which PR fixed it in the commit), or into FUTURE_IDEAS when it turns out to be a
feature rather than a defect.
