---
name: poc-video
description: Produces a polished POC demo video of a target web app via a two-pass pipeline (agent exploration, then deterministic recording with human-like input), cloned-voice narration, and dense-but-breathing assembly. Use when asked to create a demo/POC video, record a product walkthrough, or produce a final.mp4 for a pocs/ target.
---

# POC Video — two-pass demo pipeline

> **Status: scaffold.** The contracts (storyboard.yaml / vo.yaml schemas +
> validator) are implemented; the recording runner, control bus, panel, VO
> generator, TTS, and assembler are being built (plan:
> `claude-chats/doc/plans/poc-video-plugin-plan.md`). Do not promise a full
> run yet — validate storyboards with the tool below and check with the
> user before starting any pass.

## The flow (once implemented)

1. **Pass 1 — explore & learn.** Open a headed browser and stop. The user
   logs in manually (any auth scheme — the human does it) and signals
   ready. The agent explores the target via Playwright MCP with reasoning
   visible in-session, captures one reference screenshot per scene, then
   drafts `storyboard.yaml` from what it learned.
   **CHECKPOINT:** the user reviews the storyboard (panel or yaml) and
   approves — or edits inline — or sends it back with a general note,
   which triggers targeted re-exploration and a new draft.
2. **Pass 2 — record.** Fresh browser; the user logs in again and signals
   ready. The runner replays the storyboard deterministically
   (ghost-cursor, jittered typing, settle beats) while recording, pausing
   at scene checkpoints for narration and steering via panel or chat.
   Outputs `raw.webm` + `scenes.json`.
3. **Post — narrate & assemble.** The VO script is generated per scene
   (`vo.yaml`), length-budgeted against the calibrated voice pace.
   **CHECKPOINT:** the user approves the VO text before batch TTS spend.
   Then per-scene TTS (cloned voice), timestamp cuts, VO-driven sync,
   title card → `final.mp4`.

## Hard rules

- **Credentials are never captured.** Auth is always manual and
  user-signaled: the skill opens the browser and stops; the user logs in
  (2FA/SSO/SAML — whatever the target needs) and says ready. No automatic
  polling, no credential storage.
- **The storyboard is the contract.** Recording is a dumb deterministic
  replay of `storyboard.yaml` — see
  `extensions/poc-video/references/storyboard-schema.md`.
- **The runner is the single writer** of storyboard.yaml/vo.yaml during a
  run; panel and agent edits both go through it as commands.
- **No silent spend:** TTS costs money (cents) — VO text is user-approved
  before batch synthesis.
- **No silent fallback:** a selector failure mid-take pauses the run for
  live fixing in chat; never auto-retry with alternative selectors.

## Available now

Validate a storyboard (and optionally its vo.yaml):

```bash
node extensions/poc-video/scripts/validate-storyboard.mjs <storyboard.yaml> [vo.yaml]
```
