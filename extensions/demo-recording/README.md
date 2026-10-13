# demo-recording

> **Status: scaffold / planning.** Nothing records yet. See the plan.

Automated PoC and demo video recorder for web apps (SPAs, read-mostly):

1. **Brief → discover → storyboard.** The agent explores the app, finds the demo-worthy use cases, and writes a storyboard that reacts to real screen content. You review and approve it in a local side panel.
2. **Record.** One continuous, human-looking take: virtual cursor with realistic motion, realistic typing, and live `improvise` inputs for search and chat.
3. **Analyse → voice-over.** A dense, opinionated, anchored narration written from the actual run. Reviewed in the panel.
4. **Voice, edit, export.** ElevenLabs (custom voice) with OpenAI/Kokoro fallbacks, an audio-led edit, selective zoom, step callouts, and a title card. Per-scene videos plus one combined video.

All output goes to a working directory (default `~/DemoRecordings`).

- Decisions: [docs/VISION.md](docs/VISION.md)
- Implementation plan (vertical slices S0–S7): [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)

## Prerequisites (planned)

- Node 22+, `npx playwright install chromium`
- `ffmpeg` and `uv` on PATH (Homebrew)
- `ELEVENLABS_API_KEY` (primary TTS). Optional: `OPENAI_API_KEY` (fallback TTS / alignment)

## Security notes (planned capabilities)

- Drives a real browser against real apps, including clicks and typing. Discovery uses agent judgment backed by a denylist and an audit log. Lock down sensitive tenants with `policy.json`.
- Sends screenshots/DOM text to the session model and narration text to TTS providers.
- Stores browser session state (cookies) per app with `0600` permissions inside the working directory. It is never logged and never sent to models.
- Serves a local panel on `127.0.0.1` only, protected by a per-session token.
