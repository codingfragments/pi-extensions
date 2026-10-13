# poc-video

Two-pass POC demo video pipeline: an agent explores a target web app,
records a deterministic human-like walkthrough, narrates it with a cloned
voice, and assembles a polished `final.mp4`.

**Status: pass 1 implemented** — exploration tools (persistent-profile
Chromium, per-scene reference screenshots), run-dir scaffolding, and the
storyboard/vo contracts + validator are live. The recording runner
(`scripts/record.ts`), the control bus + panel, VO generator (`scripts/vo.py`),
TTS (`scripts/tts.py`), and assembler (`scripts/assemble.py`) are pending.
Workflow instructions live in [`skills/poc-video/SKILL.md`](../../skills/poc-video/SKILL.md).

## Layout

```
extensions/poc-video/
├── index.ts                        # pi extension entry — wires tools + command + cleanup
├── browser.ts                      # single Chromium owner (persistent profile; MCP-replaceable boundary)
├── exploration.ts                  # poc_video_* pass-1 exploration tools
├── references/storyboard-schema.md # the contract — scene format, vo.yaml, invariants
├── templates/                      # storyboard.template.yaml + vo.template.yaml
├── scripts/
│   ├── validate-storyboard.mjs     # schema validation (usable now)
│   ├── pass1-init.ts               # scaffold a run dir for a target
│   ├── pass1-smoke.ts              # headless browser smoke test (just smoke-browser)
│   ├── record.ts                   # runner (pending)
│   ├── vo.py / tts.py / assemble.py  # narration pipeline (pending)
│   └── panel/                      # localhost review/status/control surface (pending)
└── test/                           # validator + pass1-init tests + broken fixtures
```

## Setup

```bash
cd extensions/poc-video && just install   # npm deps + Chromium binary (user cache)
```

Or manually: `npm install` + `node node_modules/playwright/cli.js install chromium`.

## Pass-1 exploration tools

Registered in any pi session with this repo loaded (auto via `.pi/settings.json`):

`poc_video_open` · `poc_video_navigate` · `poc_video_click` · `poc_video_type` ·
`poc_video_press` · `poc_video_screenshot` · `poc_video_state` · `poc_video_close`

Every exploration action is a first-class tool call — reasoning streams
in-session, the session log doubles as the exploration record. The browser
lives in `browser.ts`, the only code that would change if exploration ever
moves to Playwright MCP (driver-agnostic elsewhere).

## Manual tests

From `extensions/poc-video/` (see `justfile`):

```bash
just validate      # happy path: the template pair must validate ✔
just demo-errors   # error-class demos: every fixture in test/fixtures/ must be REJECTED,
                  #   with readable output per class — exits non-zero if one passes
just check f.yaml [vo.yaml]  # validate any storyboard / vo pair
just test         # validator + contract unit tests
just gates        # typecheck + lint + full test suite (what CI enforces)
```

Each fixture in `test/fixtures/` carries a header comment naming the error
class it demonstrates and what the validator is expected to say.

All environment-specific values (target URL, voice name, pacing,
output dir) live in a run-level `run.yaml` next to the storyboard — the
extension never hardcodes them.

## Security

This extension deliberately has real capabilities — called out plainly:

- **Runs a local browser and executes shell commands** (playwright, ffmpeg,
  ffmpeg-adjacent tooling) to record and assemble video of the target app.
- **Never captures credentials.** Authentication is manual and
  user-signaled in both passes; nothing about the target's auth is stored
  by this extension.
- **Spends money by design (cents):** ElevenLabs TTS per scene + a ~1¢
  voice-pace calibration probe. VO text is user-approved before batch
  synthesis; per-scene retakes keep costs minimal.
- **Records the target application's UI.** The user is responsible for
  ensuring the recorded content is shareable.
