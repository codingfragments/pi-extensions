# demo-recording

> **Status: S3 done.** Human-like recording runs from pi: curved cursor paths, realistic typing, live improvised inputs, automatic resume, background recording with progress bars, and Catppuccin themes. Voice-over and editing come next (S4). Progress is tracked in the [implementation plan](docs/IMPLEMENTATION_PLAN.md#6-vertical-slices).

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
3. The agent writes a storyboard (`demo_rec_storyboard`). The panel **Review** tab shows scene cards. Mark each scene *Approve / Request changes / Re-run*, add notes, then **Send review to agent**. You get one consolidated `[demo-panel]` message, and the agent writes the next version, with a diff shown.
4. **Approve vN** in the panel. This is the only way to approve; the agent cannot.
5. Ask the agent to record: `demo_rec_record` starts a **background** take of the approved version. The panel shows a per-scene progress bar with ETA, and pi's footer shows the current step. The agent gets a `[demo-recording]` message with the result.

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

## What works today (S0–S3)

| In pi | Does |
|---|---|
| `/demo new [<project> <app-url> [app name…]]` | creates a project, opens the panel, starts the brief skill |
| `/demo open [<project>]` | sets the active project (persisted in the session) |
| `/demo status` | root, config sources, phase, approvals, panel URL |
| `/demo discover [notes]` | start discovery + storyboard (demo-recording skill) |
| `/demo panel` | starts the side panel and prints its URL (with token) |
| `/demo doctor` | prerequisite check |

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
- `ffmpeg` (with libx264) and `uv` on PATH (`brew install ffmpeg uv`)
- `ELEVENLABS_API_KEY` (primary TTS). Optional: `OPENAI_API_KEY` (fallback TTS / alignment)

`/demo doctor` checks all of these. It reports key *presence* only and never prints values.

## Security notes

- **Discovery:** drives a real browser against the target app (clicks, typing). The safety net above blocks destructive actions before they happen. Screenshots and aria text are sent to the session model.
- **Panel:** binds to `127.0.0.1` only. API and WebSocket require a random per-session token, and the Host header must be loopback (DNS-rebinding guard). State-changing requests (review, approve) accept only a Bearer header with a JSON body, so other local pages can't forge them. The token is removed from the URL bar once the page loads.
- **Planned (later slices):**
  - Sends narration text to TTS providers.
  - Stores browser session state (cookies) per app under `apps/<app>/auth/` (directory `0700`, files `0600`). It is never logged and never sent to models.

## Development

```bash
node --test extensions/demo-recording/test/*.test.ts   # browser/ffmpeg tests skip if missing
DEMO_REC_E2E=1 node --test extensions/demo-recording/test/s1-e2e.test.ts   # full pipeline (macOS)
npm run typecheck && npm run lint
```

The vendored panel dependency (`src/panel/public/vendor/`) is excluded from biome.
