# Storyboard Schema — v0.1

`storyboard.yaml` is the contract between every stage of the poc-video
pipeline: the agent drafts it from pass-1 exploration, the runner replays it
deterministically in pass 2, the VO generator budgets narration against it,
and the assembler cuts to it. **The scene is the atomic unit** — scenes map
1:1 to recorded segments, VO chunks, and cut points.

Two rules from the plan that this schema exists to enforce:

1. **Storyboard-driven, not agent-driven at record time.** Recording is a
   dumb deterministic replay of this file. Anyone can hand-edit it and
   re-record without an LLM.
2. **The runner is the single writer at runtime.** Panel and agent edits
   both arrive as commands; only the runner mutates this file once a run
   has started.

## Header (`meta`)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `target` | string | ✓ | | short target name, e.g. `turso` |
| `title` | string | ✓ | | video title |
| `one_liner` | string | | | subtitle for the auto title card |
| `language` | string | | `en` | honored by the VO generator (multilingual TTS) |
| `voice.name` | string | ✓ | | ElevenLabs voice name; resolved to `voice_id` at runtime by name-match — fail loudly if missing |
| `target_duration_s` | int | ✓ | | whole-video budget in seconds; drives per-scene narration length — "length is part of the prompt" |
| `width` / `height` / `fps` | int | | 1920 / 1080 / 30 | recording geometry |
| `settle_default_ms` | int | | 800 | default settle beat around every action |

## Scenes

Each entry under `scenes:`:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | ✓ | | unique, kebab-case; stable key across storyboard, `vo.yaml`, `scenes.json`, and the panel |
| `title` | string | ✓ | | short human label for review cards |
| `intent` | string | ✓ | | **why** this scene exists — drives pass-2 live narration ("agent narrates intent + next step") and the VO generator |
| `narration_gist` | string | | | one-line hint of what the VO should convey in this scene |
| `budget_s` | int | | derived | per-scene time budget; when present on **every** scene, Σ must be ≤ `target_duration_s` |
| `settle_ms` / `hold_ms` | int | | header / 0 | per-scene overrides. `hold` = extra end-of-scene dwell so narration fits |
| `reference_screenshot` | string | | | path (relative to the run dir) of the pass-1 exploration shot; shown on the checkpoint-1 review card |
| `steps` | list | ✓ | | see below; a scene with zero steps is invalid |

### Step types

| type | fields | notes |
|---|---|---|
| `navigate` | `url` | |
| `click` | `selector` | human-cursor path, overshoot, jitter (ghost-cursor) |
| `type` | `selector`, `text` | per-char 45–140 ms jitter |
| `press` | `key` | |
| `scroll` | `dy`, `selector?` | |
| `hover` | `selector` | |
| `assert` | `selector` | cheap pre-guard: element must exist before continuing; failure = pause + fix in chat, never silent fallback |
| `wait` | `ms` | use sparingly — dead time is what timestamp cuts remove |

Selector guidance: prefer accessible anchors (`role=…`, text) over CSS
paths; assert-critical selectors should be the most stable anchor on the
page. When a selector fails mid-take the runner pauses, the agent diagnoses
in chat, and the fix lands here as a storyboard edit.

## Runner-managed flags (not authored)

`retake`, `skip`, `status` on scenes are set by the runner during pass 2
(live steering via panel/chat). Authored values are ignored and overwritten
at run start.

## `vo.yaml` (sibling contract)

Narration lives in a separate file keyed by the same scene ids — drafted,
edited, approved, and regenerated independently of the recording contract:

```yaml
meta:
  voice: { name: Stefan, id: null }   # id resolved + cached at runtime
  model: eleven_v4
  pace_words_per_sec: 2.45           # calibration-probe result, cached in run state
  calibrated_at: null
scenes:
  - id: intro-dashboard
    text: "…"                        # the narration for this scene
    status: draft                    # draft | approved | synthesized | retake
    fit:                             # computed by vo/tts tooling, not authored
      spoken_s: 18.0
      budget_s: 22
      verdict: fits                  # fits | tight | over
```

## Invariants (what `validate-storyboard.mjs` enforces)

- scene ids unique + kebab-case; `steps` non-empty; step types known and their required fields present
- Σ `budget_s` ≤ `target_duration_s` when budgets are explicit on all scenes
- `vo.yaml` scene ids ⊆ storyboard scene ids; statuses valid; `pace_words_per_sec` ∈ (0, 10]
- `settle_ms` / `hold_ms` / `budget_s` positive integers
- authored runner-managed flags (`retake`, `skip`, `status`) produce warnings, not errors — they get overwritten
