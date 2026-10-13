---
name: poc-video
description: Produces a polished POC demo video of a target web app via a two-pass pipeline (agent exploration, then deterministic recording with human-like input), cloned-voice narration, and dense-but-breathing assembly. Use when asked to create a demo/POC video, record a product walkthrough, or produce a final.mp4 for a pocs/ target.
---

# POC Video — two-pass demo pipeline

> **Status:** pass 1 is implemented (exploration tools + run-dir scaffolding +
> storyboard contracts/validator). Pass 2 (recording runner), the panel, VO/TTS,
> and assembly are pending (plan: `claude-chats/doc/plans/poc-video-plugin-plan.md`).
> Never promise a full video yet — pass 1 through an approved storyboard is the
> current end state.

## Stage map

| Stage | State | Entry point |
|---|---|---|
| Pass 1 — explore & learn | **implemented** | this skill + `poc_video_*` tools |
| Checkpoint 1 — storyboard approval | **manual** (yaml review; panel pending) | validator + user |
| Pass 2 — record | **in progress** — replay engine done (`scripts/record.ts`: watch/step/dry-run, deterministic steps, settle/hold, scenes.json, recordVideo → webm); human-like input + control bus/steering next | `scripts/record.ts` |
| Post — VO, TTS, assembly | pending | `scripts/vo.py` / `tts.py` / `assemble.py` |

## Pass 1 protocol (implemented)

1. **Scaffold the run.** `node extensions/poc-video/scripts/pass1-init.ts <target> --pocs-root <pocs>` —
   creates the run dir (`run.yaml`, storyboard/vo template copies, `findings/`, `scenes/`).
   Set `start_url` in `run.yaml`.
2. **Open the browser and STOP.** Tool: `poc_video_open` (run_dir + start URL).
   A headed Chromium opens. The user logs in manually — any auth scheme, the
   human does it. **Never continue until the user confirms they are logged in
   and on the start page.** No credential capture, no automatic polling.
3. **Explore with visible reasoning.** Drive the browser ONLY via the
   `poc_video_*` tools — every click, navigation, and screenshot is a tool
   call in the session, so the user sees the exploration happen. Take a
   `poc_video_screenshot` (kebab-case name) for every moment that could
   become a scene — these become the `reference_screenshot` entries. Note
   findings into `<run_dir>/findings/` (structure in its README): what the
   product does, candidate flows, payoff moments.
4. **Settle with the user.** Discuss what the walkthrough should show. The
   user has veto on scope.
5. **Draft the storyboard.** Write `<run_dir>/storyboard.yaml` per
   `extensions/poc-video/references/storyboard-schema.md`: one scene per
   story beat, each with `intent`, `narration_gist`, `budget_s` (Σ ≤
   `target_duration_s`), `reference_screenshot` from your shots, and
   replayable `steps`. Never author `retake`/`skip`/`status` — those are
   runner-managed.
6. **Validate.** `node extensions/poc-video/scripts/validate-storyboard.mjs <run_dir>/storyboard.yaml [<run_dir>/vo.yaml]`
   must pass clean before anything else happens.
7. **CHECKPOINT 1.** Present the storyboard to the user for review:
   - **approve** → pass 1 ends here until pass 2 is implemented
   - **edit** → apply changes (yours or theirs), re-validate, re-present
   - **send back with a general note** → re-run targeted exploration for the
     implicated areas only, keep the rest of the findings, new draft, re-present
8. **Close.** `poc_video_close` (the profile stays under the run dir for retakes).

## Hard rules

- **Credentials are never captured.** Auth is always manual, user-signaled:
  open browser → stop → user logs in → user says ready.
- **The storyboard is the contract.** Recording is a dumb deterministic replay
  of `storyboard.yaml`. Hand-edits are always allowed (that's the portability
  story) — but they must validate.
- **No silent spend:** VO/TTS costs money (cents) — VO text is user-approved
  before batch synthesis.
- **No silent fallback:** a broken selector pauses for live fixing; never
  auto-retry with alternative selectors. During pass 1, if a selector fails,
  say so and pick a more stable anchor — record the working one in the storyboard.
- **The runner is the single writer at runtime** (panel and agent edits both
  go through it) — pass 2 will enforce this; in pass 1, the storyboard is
  draftable by anyone.

## Cross-agent note

Pass-1 exploration uses the `poc_video_*` extension tools (pi sessions with
this repo). If exploration ever needs to run outside pi, Playwright MCP is
the designated alternative — the storyboard/validator layers are
driver-agnostic, so nothing else changes. Don't build around the absence of
either driver.

## Available now

```bash
# scaffold:      node extensions/poc-video/scripts/pass1-init.ts <target> --pocs-root <pocs>
# validate:      node extensions/poc-video/scripts/validate-storyboard.mjs <storyboard.yaml> [vo.yaml]
# record/replay: cd extensions/poc-video && just record <run-dir> [watch|step|dry-run]
#                (dry-run = selector validation, no recording; watch = real recording)
# manual tests:  cd extensions/poc-video && just --list
```
