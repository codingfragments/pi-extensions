# demo-recording

> **Status: S4 done.** It produces a narrated, in-sync video from pi: take analysis, a voice-over written from the actual run, panel approval, ElevenLabs (your voice) / OpenAI / local Kokoro, and an audio-led edit with per-scene MP4s plus the full video. Polish and automatic quality checks come next (S5). Progress is tracked in the [implementation plan](docs/IMPLEMENTATION_PLAN.md#6-vertical-slices).

Automated PoC and demo video recorder for web apps (SPAs, read-mostly):

1. **Brief → discover → storyboard.** The agent explores the app, finds the demo-worthy use cases, and writes a storyboard that reacts to real screen content. You review and approve it in a local side panel.
2. **Record.** One continuous, human-looking take: virtual cursor with realistic motion, realistic typing, and live `improvise` inputs for search and chat.
3. **Analyse → voice-over.** A dense, opinionated, anchored narration written from the actual run. Reviewed in the panel.
4. **Voice, edit, export.** ElevenLabs (custom voice) with OpenAI/Kokoro fallbacks, an audio-led edit, selective zoom, step callouts, and a title card. Per-scene videos plus one combined video.

- Decisions: [docs/VISION.md](docs/VISION.md)
- Implementation plan (vertical slices S0–S7): [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)

## Workflow in pi (S2)

1. `/demo new <project> <app-url> [app name]`: creates the project, opens the panel, and starts the **demo-brief** skill (it drafts `brief.md` with you).
2. `/demo discover [notes]`: the **demo-recording** skill explores the app with `demo_rec_browser`. You can watch it live in the panel: current screen, budget, and a safety feed.
3. The agent writes a storyboard (`demo_rec_storyboard`). The panel **Storyboard** tab shows scene cards. Mark each scene *Approve / Request changes / Re-run*, add notes, then **Send review to agent**. You get one consolidated `[demo-panel]` message, and the agent writes the next version, with a diff shown.
4. **Approve vN** in the panel. This is the only way to approve; the agent cannot.
5. Ask the agent to record: `demo_rec_record` starts a **background** take of the approved version. The panel shows a per-scene progress bar with ETA, and pi's footer shows the current step. The agent gets a `[demo-recording]` message with the result.

6. After the take, the agent analyzes it (`demo_rec_take`) and writes the voice-over (`demo_rec_vo`, **demo-voiceover** skill). It's written from the actual run and quotes real on-screen values.
7. The panel **Voice over** tab shows each section with a speech-vs-footage timing bar. You can edit inline (each save is a new version), mark sections, send the review, and **Approve**. Approval unlocks the paid voice synthesis.
8. `demo_rec_tts` generates the voice and `demo_rec_edit` renders it: `projects/<p>/out/edit-vN/scenes/NN-<scene>.mp4`, `full.mp4` and `timeline.json`.

### Voice-over and edit (S4)

- **Script:** markdown sections per scene, plus `_intro`, `_bridge:<scene>` and `_outro` for the full video only.
  - `[@mark]` pins the following phrase to that event.
  - `{{dom:mark|regex}}` fills in a value from the page text captured at that mark.
- **Voices** (`ttsChain`, keys **from the environment only**):

  | Engine | Needs | Timings |
  |---|---|---|
  | `elevenlabs` | `ELEVENLABS_API_KEY`; voice **by name** from the brief's *Voice* field or `voiceName` | provider character timings (`eleven_v4`, falls back to `eleven_multilingual_v2`) |
  | `openai` | `OPENAI_API_KEY`; `gpt-4o-mini-tts`, voice `ash`, tone instructions | Whisper |
  | `kokoro` | `uv` (local, offline; ~124 MB of models on first use) | Whisper |
  | `say` | macOS (dev/tests only) | Whisper |

  One engine is used for the whole video; if it fails mid-way, the voice-over restarts with the next engine. Audio is cached by content, so re-renders only pay for changed sections. `demo_rec_tts check` shows which engine and voice will be used, for free.
- **Word timings for the non-ElevenLabs engines:** faster-whisper `base.en` via `uv` (~145 MB of models on first use) plus energy-onset refinement.
- **Sync editor:**
  - **Cuts first:** dead time (spinners) goes, keeping a 0.4 s beat.
  - **Then speed:** static stretches up to 1.6×, streamed answers up to 1.3×, in-app video and animation up to 1.15×.
  - **Then trim:** static stretches are trimmed.
  - **If the narration is longer:** static stretches are slowed (≥ 0.85×), then a settled frame is held.
  - **Never touched:** typing and clicks.
  - **If the video can't shrink:** the narrator pauses instead of drifting.

  The result message lists per-scene cuts, holds, pauses and any off-sync anchors.
- **Output:** 1920×1080, 30 fps H.264, AAC, loudness-normalized to −16 LUFS.

### Stages and project memory (S5)

- **Stage chain:** storyboard → recording (take) → voice-over → annotations → render.
  - Every version is based on exactly one parent version, read from the files themselves.
  - An approval only goes through when the version chains up to the approved parent.
  - A new upstream approval resets everything below it; nothing is deleted.
  - `demo_rec_project status` shows the lineage and flags stale drafts.
- **Project memory:** `inputs.jsonl` records every directional input:
  - `/demo discover` and `/demo voiceover` notes, submitted panel reviews, inline edits;
  - brief versions;
  - chat directions, sources and assets the agent notes with `demo_rec_project note`.

  Withdrawn directions are marked outdated (never deleted). `demo_rec_project context` returns the brief, the lineage and the active inputs; `/demo open` and a session restore put that context into the agent's next turn.

### Panel: the control room (S5)

- **Tabs follow the stages:** Storyboard · Recording · Voice over · Annotations · Render · Config.
  - **Shared header:** each stage tab shows the lineage (latest version, what it's based on), the approval, a stale flag, what approving another version would reset, and "→ you: …" when the project is waiting for you. A dot on the tab marks the stage that needs you.
  - **Cascade confirmation:** every approval does a dry run first, and the confirmation lists what the stage chain would reset.
- **Recording tab:** takes newest first, grouped by storyboard version, with status, duration, analysis state, a keyframe per scene and the raw take as video. *Accept take* is chain-checked. *Request a new take* asks the agent, with optional notes, and the request goes into the input log.
- **Live panel:** a collapsible right-hand panel; below 1100 px wide it becomes a bottom drawer.
  - **Contents:** one progress row per running activity (discovery, recording, analysis, voice, render), a frame preview (the live frame of a running take, or the current discovery screen), safety, the project chain and the log.
  - **Collapsed:** a one-line strip with the stage, the activity or "waiting for you", and a mini progress bar.
  - **Per tab:** sections can be toggled and are remembered.

### Brands (S5)

Every render uses a **brand package**, which sets:
- the footage inset on a backdrop (rounded corners, soft shadow, an automatic rim when the app blends into the backdrop);
- a title card (app, demo title, date) that dissolves into the first frame;
- the callout colors;
- an optional logo bug in the backdrop margin.

| | |
|---|---|
| built-in | `neutral` (dark slate, soft-blue accent, no logo) |
| user brands | `<root>/brands/<name>/`, outside this repo, so company logos never end up in a public package |
| create | `/demo brand new path/to/brand.zip`: the `demo-brand` skill inspects logos (rendered, luminance-checked) and colors, proposes a mapping, creates the brand, and shows a preview |
| default | config `brand` (`/demo brand use <name> [--project]`, diff-confirmed) |
| switch | `/demo brand rerender <name>`, or the panel **Render** tab (brand dropdown): re-renders the latest edit from timeline + `raw.mp4` + voice. No LLM, no TTS. Output in `out/edit-vN/<brand>/` |

The panel **Config → Brands** section previews tweaks (colors, inset, corners, shadow, title timing, logo bug) on a real keyframe before saving. Built-in brands are read-only, so use "Save as copy".

Full reference, with every option, the automatic decisions and the render chain: [docs/BRANDS.md](docs/BRANDS.md).

### Recording (S3)

- **Motion:** curved paths with a natural speed profile (slow start, fast middle, slow landing), occasional overshoot-and-correct, and a small hand drift while dwelling. Seeded per take, so it can be reproduced.
- **Typing:** variable per-key rhythm with pauses between words. Typos are optional: `"recording": { "typoRate": 0.02 }`.
- **`improvise` steps:** a fast model invents the input (search/chat) from the live screen while the cursor travels. Default chain: `anthropic/claude-haiku-4-5` → `openai/gpt-5.4-mini`, using pi's configured auth (`"improvise": { "models": [...] }` or `DEMO_REC_IMPROVISE_MODELS`). If the model is late, the cursor hesitates for up to `hesitateMs` (3 s), then the step's `fallback` text is typed.
- **Page watchers:** route changes, toasts and alerts (with text), and loading spinners are logged. Spinner time is recorded as dead time for the editor to cut.
- **Resume:** a failing scene is retried (`"recording": { "maxRetriesPerScene": 2 }`). The take is cut at that scene's start, the app is restored off-camera (via `deep_link`, or by replaying the earlier scenes fast; a crashed browser is reopened), and the good footage before it is kept. Failed attempts are kept in `attempts.jsonl`.
- **Panel:** progress bars for discovery (the agent's declared areas plus budget) and recording, in Catppuccin **Macchiato** (default) or **Latte**. Toggle in the header.

**Tools:** `demo_rec_project`, `demo_rec_browser`, `demo_rec_storyboard`, `demo_rec_record`. **Skills:** `demo-brief`, `demo-recording`.

### Discovery safety net (D6)

- **Blocked before the click:** destructive, financial, sharing and session-ending actions (delete, pay, share, invite, publish, sign out, …), plus navigation off the app's origin.
- **Allowed but audited:** state changes (send, save, submit, chat messages). They are flagged in the panel and written to `apps/<app>/discovery/<session>/audit.jsonl`.
- **Overrides:** `apps/<app>/policy.json`, for example `{"allow": ["Send"], "deny": ["Export"], "allowOrigins": ["https://sso.example.com"]}`. `allow` beats the built-in denylist.

## What works today (S0–S4)

| In pi | Does |
|---|---|
| `/demo new [<project> <app-url> [app name…]]` | creates a project, opens the panel, starts the brief skill |
| `/demo open [<project>]` | sets the active project (persisted in the session) |
| `/demo status` | root, config sources, phase, approvals, panel URL |
| `/demo discover [notes]` | start discovery + storyboard (demo-recording skill) |
| `/demo panel` | starts the side panel and prints its URL (with token) |
| `/demo doctor` | prerequisite check |
| `/demo brand [list \| use <name> \| new [zip] \| rerender [name]]` | brand packages (S5) |
| `/demo config`, `/demo voices`, `/demo voiceover`, `/demo render` | settings, voice picker, voice-over, render (S5) |

Engine CLI (no model needed):

```bash
node extensions/demo-recording/cli.ts doctor
node extensions/demo-recording/cli.ts fixture serve            # Acme Pulse test app (?slow=1, ?flaky=1)
node extensions/demo-recording/cli.ts project new --name "Churn PoC" --url https://app.example.com --app "Example"
node extensions/demo-recording/cli.ts panel --ticker           # standalone panel with test events

# S1 walking skeleton: fixture + fixtures/storyboards/s1-search.yaml → out/take-NNN-naive.mp4
node extensions/demo-recording/cli.ts run-s1 --fixture [--seed 7] [--headed]
node extensions/demo-recording/cli.ts run-s1 --url https://app.example.com --app Example --storyboard my.yaml
node extensions/demo-recording/cli.ts spike capture            # capture resolution comparison
node extensions/demo-recording/cli.ts record --fixture          # S3 take with live progress (uses pi's model auth; --no-model to skip)
node extensions/demo-recording/cli.ts fixture-demo             # S4: full narrated demo of the fixture with your voice chain
DEMO_REC_ELEVENLABS_E2E=1 DEMO_REC_VOICE="<your voice>" node --test extensions/demo-recording/test/s4-elevenlabs.test.ts   # live voice check (~200 chars)
```

A take lands in `projects/<p>/takes/take-NNN/` and contains:
- `frames/`: 3200×1800 JPEGs
- `frames.jsonl`
- `events.jsonl`: every step on the screencast clock, with element boxes and `mark` anchors
- `take.json`: seed, stats, status
- `scenes.json`
- `raw.mp4`: CFR master at capture resolution

The S1 storyboard format (a subset; the full schema arrives in S2) is documented in `src/storyboard/types.ts`. See `fixtures/storyboards/s1-search.yaml` for an example.

## Configuration

Optional JSON file at `~/.config/demo-recording/config.json` (or `$DEMO_REC_CONFIG`). Every field is optional:

```json
{
  "root": "~/DemoRecordings",
  "viewport": { "width": 1600, "height": 900, "dpr": 2 },
  "output": { "width": 1920, "height": 1080 },
  "fps": 30,
  "capture": { "quality": 92 },
  "panelPort": 3777,
  "ttsChain": ["elevenlabs", "openai", "kokoro"],
  "voiceName": "My Voice",
  "tts": {
    "elevenlabs": { "model": "eleven_v4", "fallbackModel": "eleven_multilingual_v2" },
    "openai": { "model": "gpt-4o-mini-tts", "voice": "ash" },
    "kokoro": { "voice": "am_michael" }
  },
  "align": { "model": "base.en" },
  "budgets": { "discoveryScreens": 40, "discoveryActions": 150, "discoveryMinutes": 20 }
}
```

To downscale capture on weaker machines, set `"capture": { "maxWidth": 2560, "maxHeight": 1440 }` (see [docs/spikes/S1-capture.md](docs/spikes/S1-capture.md)).

Environment variables override the file: `DEMO_REC_ROOT`, `DEMO_REC_PANEL_PORT`, `DEMO_REC_TTS_CHAIN` (comma-separated), `DEMO_REC_VOICE`. A malformed config file is a hard error.

## Working directory

```
~/DemoRecordings/
  apps/<app>/        app.json, auth/ (0700), policy.json, discovery/   (shared across demos)
  projects/<demo>/   brief.md, context/, state.json, storyboard/, takes/, vo/, edit/, out/, jobs/
```

Artifacts are versioned and never overwritten (`storyboard/v3.yaml`, `takes/take-002/`).

## Prerequisites

- Node 22+, `npx playwright install chromium`
- `ffmpeg` ≥ 7 (with libx264) and `uv` on PATH (`brew install ffmpeg uv`). `uv` runs the bundled Python helpers (`py/`: Whisper word timings, Kokoro) with inline dependencies, so there is no virtualenv to manage.
- `ELEVENLABS_API_KEY` (primary TTS) and optionally `OPENAI_API_KEY`, **exported before starting pi**, since a running pi does not see new variables.

`/demo doctor` checks all of these. It reports key *presence* only and never prints values.

## Security notes

- **Discovery:** drives a real browser against the target app (clicks, typing). The safety net above blocks destructive actions before they happen. Screenshots and aria text are sent to the session model.
- **Panel:** binds to `127.0.0.1` only. API and WebSocket require a random per-session token, and the Host header must be loopback (DNS-rebinding guard). State-changing requests (review, approve) accept only a Bearer header with a JSON body, so other local pages can't forge them. The token is removed from the URL bar once the page loads.
- **Planned (later slices):**
  - Sends narration text to TTS providers (ElevenLabs/OpenAI). Kokoro, Whisper and `say` run locally.
  - Stores browser session state (cookies) per app under `apps/<app>/auth/` (directory `0700`, files `0600`). It is never logged and never sent to models.

## Development

```bash
node --test extensions/demo-recording/test/*.test.ts   # browser/ffmpeg tests skip if missing
DEMO_REC_E2E=1 node --test extensions/demo-recording/test/s1-e2e.test.ts   # full pipeline (macOS)
npm run typecheck && npm run lint
```

The vendored panel dependency (`src/panel/public/vendor/`) is excluded from biome.
