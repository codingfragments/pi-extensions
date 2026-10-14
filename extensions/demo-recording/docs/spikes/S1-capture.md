# Spike S1: capture resolution and screencast behaviour (Q1)

**Question:** Can a headless CDP screencast sustain 30 fps at 3200×1800 (D15) while we drive the page? If not, fall back to 2560×1440.

**Answer:** Yes. **3200×1800 stays the default.** It holds ~57 fps during continuous animation at ~1 CPU core. 2560×1440 is available through `capture.maxWidth/maxHeight` for weaker machines.

Machine: Apple M5 Pro (18 cores), Chromium 156 (Playwright 1.57 headless shell), ffmpeg 9.0.1.
Reproduce: `node extensions/demo-recording/cli.ts spike capture`.

## Finding 1: headless ignores deviceScaleFactor in screencast frames

With a context of `viewport 1600×900, deviceScaleFactor 2`, the headless screencast delivers **1600×900** frames. `maxWidth: 3200` and the `scale` option of `Emulation.setDeviceMetricsOverride` don't help, and neither does a `Page.captureScreenshot` loop. Headed Chromium delivers 3200×1800, but only at ~29 fps, and its window takes over the screen.

**Fix:** launch with `--force-device-scale-factor=<dpr>` *in addition to* the context DPR. The result is true **3200×1800** frames at ~60 fps, headless, with the page still laid out at 1600×900 CSS px (`innerWidth 1600`, `devicePixelRatio 2`). This is implemented in `src/browser/session.ts` (`launchArgs`).

| Probe (3 s, spinner animating) | Frame | fps |
|---|---|---|
| headless shell, context DPR 2 | 1600×900 | 60 |
| new headless (`channel: chromium`), DPR 2 | 1600×900 | 60 |
| headed, DPR 2 | 3200×1800 | 29 |
| headless + `--force-device-scale-factor=2`, DPR 2 | **3200×1800** | **60** |
| headless + `setDeviceMetricsOverride({scale: 2})` | 1600×900 | 60 |
| `Page.captureScreenshot` loop | 1600×900 | 60 |

## Finding 2: clock

`Page.screencastFrame.metadata.timestamp` is **wall-clock epoch seconds**, on the same time base as Node's `Date.now()`. In an idle probe, frames arrive 5–13 ms after their timestamp. Under load, delivery latency reaches ~70–90 ms (JPEG encoding plus ack round trip). Timing always uses the frame's *own* timestamp, so latency never shifts the timeline. Engine events (`Date.now()` at the action) and frames therefore share one clock: `t = epochMs − t0`.

## Finding 3: frames arrive only on damage

A static screen produces no frames, so the max gap equals the longest static stretch (1.5 s in the storyboard). The CFR master maps the variable-rate source exactly: **output frame k shows the latest source frame with ts ≤ t0 + k/fps** (`cfrSchedule`). Durations are exact multiples of 1/fps, and `-frames:v N` caps the length.

An earlier version used per-frame durations straight from the timestamps. The concat demuxer padded the repeated last image, adding +0.43 s (13 frames) of drift on an 11.8 s take. The exact schedule removed it: 11.816 s take → 354 frames = 11.800 s.

## Results: S1 storyboard on the fixture with `?slow=1` (4 s spinner), seed 42

"Anim" is the continuous-animation window (spinner, Enter press + 400 ms → results visible − 100 ms).

| Config | Frame | Anim fps | Anim max gap ms | Avg fps (incl. static) | KB/frame | Frames MB | Browser CPU % avg / max | Encode s | Take s |
|---|---|---|---|---|---|---|---|---|---|
| 3200×1800 (1600×900 @2x) | 3200×1800 | **57.2** | 50 | 25.5 | 106 | 41 | 96 / 247 | 0.9 | 15.6 |
| 2560×1440 (1600×900 @2x, downscaled) | 2560×1440 | 56.9 | 50 | 25.3 | 76 | 29 | 76 / 170 | 0.6 | 15.4 |
| 1920×1080 (1920×1080 @1x) | 1920×1080 | 56.6 | 50 | 25.5 | 44 | 17 | 29 / 61 | 0.4 | 15.5 |

CPU % is summed over all Playwright browser processes, so 100 % = one core. The CFR masters are tiny (0.1–0.3 MB) because UI footage is mostly static and repeated frames cost almost nothing in H.264.

## Decision

- **Default:** 1600×900 CSS @ DPR 2 → 3200×1800 capture → 1920×1080 @ 30 fps render (D15 unchanged).
- **Fallback:** `"capture": { "maxWidth": 2560, "maxHeight": 1440 }` in the config. It saves ~20 % browser CPU and ~30 % frame storage.
- **Disk:** ~2.6 MB/s of JPEG frames at 3200×1800, so a 5-minute take is ~800 MB of frames. Frames are kept for S3 resume/stitching. A cleanup policy is follow-up work (S3).
- **Watch:** a 4K-class app with heavy animation (video, WebGL) could saturate; re-run this spike on such a target in S7 (real-app acceptance).
