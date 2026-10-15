---
name: demo-config
description: Shows, explains and changes demo-recording settings — voice (ElevenLabs voice by name), TTS engine order, improvise models, capture size, Whisper model, discovery budgets, retries — globally or per project, always with a diff the user confirms. Use when the user asks to pick or change a voice, model, engine, budget or any demo-recording setting, or asks what a setting does or why a value is in effect.
---

# Demo config

Settings come in layers, lowest to highest:

1. built-in defaults
2. global `~/.config/demo-recording/config.json` (documented in its `_comment` block)
3. project `projects/<p>/config.json` (only the keys you want to differ)
4. environment `DEMO_REC_ROOT`, `DEMO_REC_PANEL_PORT`, `DEMO_REC_TTS_CHAIN`, `DEMO_REC_VOICE`, `DEMO_REC_IMPROVISE_MODELS`

The voice also has its own layer: a project's brief **Voice:** field wins over
`voiceName`.

## Tools

- `demo_rec_config show [key prefix]` shows the effective value, **where it
  comes from**, and a one-line explanation. Use it first to answer "what is
  X" or "why is X like that".
- `demo_rec_config set key value [scope]` and `unset key [scope]` work in two
  phases:
  1. Call **without** `confirm`. You get the planned change and a diff; nothing
     is written yet.
  2. **Show the diff to the user and ask.** Only after a yes, call again with
     `confirm: true`.

  The tool validates the value with the real resolver, so a bad value is
  rejected with the exact reason. Relay that and suggest a valid value.
- `demo_rec_tts voices` lists every ElevenLabs voice (yours first) with name,
  id and category, and marks the current one. `demo_rec_tts check` is free:
  it shows which engine and voice would really be used.
- For interactive use, the user can run `/demo voices` (pick from a list) or
  `/demo config …` themselves.

## In the panel

The user can do the same in the side panel under **⚙ Config → Settings**:
- every setting with its source and the value in each layer;
- a Global / This project switch;
- diff-confirmed Save and reset;
- the raw files read-only.

When they ask "where do I change X", point them there or offer to do it here
with `demo_rec_config`. Facts about the demo itself (title, persona, depth,
length, URLs) are not settings: they live in the panel's **Project** tab (the
brief).

## Scope

- **Global** is the default for personal preferences (your voice, engine
  order, budgets).
- **Project** is for one demo that differs (a different voice or engine, a
  bigger discovery budget). `root` is global-only.
- If a write is **shadowed** by a higher layer (a project file or an env
  var), the tool says so. Tell the user what to remove for the change to take
  effect.

## Common requests

| User says | Do |
|---|---|
| "Use my voice X" | `demo_rec_tts voices` → confirm the exact name → `set voiceName "<name>"` (ask global or project) → `demo_rec_tts check` |
| "Don't use ElevenLabs for this demo" | `set ttsChain ["openai","kokoro"]` with scope project |
| "Improvise is too slow / not working" | `show improvise` → suggest `improvise.models` from available fast models (Haiku-class first) → maybe `improvise.hesitateMs` |
| "My machine struggles while recording" | `set capture.maxWidth 2560` + `capture.maxHeight 1440` |
| "Discovery stopped too early" | raise `budgets.discoveryScreens` / `discoveryMinutes` for this project |
| "Run the annotations on a cheaper model" | `set roles.annotationDesigner.model "provider/id"` (or a list, tried in order) → `/demo doctor` shows whether it is found and big enough. The engine then makes ONE call on it after each edit and for Re-suggest; if it fails, the agent turn does the job. `unset` goes back to the agent turn. Only this role can run separately: the Operator's model is `improvise.models`; the Cutter and the QA reviewer are engine roles with no model |
| "Better word timing" | `set align.model "small.en"` (slower, bigger download) |
| "The cost estimate is wrong for my plan" | `set tts.pricePer1kChars.elevenlabs 0.18` (money per 1,000 credits; `.openai` per 1,000 characters) and `tts.currency "€"` |
| "Which model should run discovery?" | It isn't a config setting: the session model directs. Recommend a vision model with ≥ 200k context (`/demo doctor` shows a warning otherwise) |

## Never

- Never read, store, print or ask the user to paste API keys.
  `ELEVENLABS_API_KEY` and `OPENAI_API_KEY` live in the environment: tell
  the user to `export` them and **restart pi** (a running pi doesn't see new
  variables).
- Never write without the user's explicit yes to the shown diff.
