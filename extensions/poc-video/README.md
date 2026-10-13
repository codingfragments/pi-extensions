# poc-video

Two-pass POC demo video pipeline: an agent explores a target web app,
records a deterministic human-like walkthrough, narrates it with a cloned
voice, and assembles a polished `final.mp4`.

**Status: scaffold — contracts only.** The storyboard/vo schemas and the
validator are implemented; the recording runner (`scripts/record.ts`), the
control bus + panel, VO generator (`scripts/vo.py`), TTS
(`scripts/tts.py`), and assembler (`scripts/assemble.py`) are being built.
Workflow instructions live in [`skills/poc-video/SKILL.md`](../../skills/poc-video/SKILL.md).

## Layout

```
extensions/poc-video/
├── index.ts                        # pi extension entry (loads, points at the skill)
├── references/storyboard-schema.md # the contract — scene format, vo.yaml, invariants
├── templates/                      # storyboard.template.yaml + vo.template.yaml
├── scripts/
│   ├── validate-storyboard.mjs     # schema validation (usable now)
│   ├── record.ts                   # runner (pending)
│   ├── vo.py / tts.py / assemble.py  # narration pipeline (pending)
│   └── panel/                      # localhost review/status/control surface (pending)
└── test/validate.test.ts
```

## Setup

```bash
cd extensions/poc-video && just install   # npm deps + Chromium binary (user cache)
```

Or manually: `npm install` + `npx playwright install chromium`.

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
