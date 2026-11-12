# The demo-recording extension — how it's actually built

This is the grounded walkthrough of `extensions/demo-recording`: what's in the folder,
what each piece of code does, what depends on what, and how a demo video actually gets
made from the moment you type `/demo new` to the finished MP4. I wrote it for someone
who is about to change this codebase — so it leads with the simple version of the story
and then goes deep, module by module.

If you want the *design* reasoning (why it's built this way, decisions D1–D20x, the
alternatives that were rejected), read the extension's own
[`docs/ARCHITECTURE.md`](../extensions/demo-recording/docs/ARCHITECTURE.md). This
document is deliberately more mechanical: less philosophy, more wiring.

---

## Contents

1. [The one-paragraph version](#1-the-one-paragraph-version)
2. [The big picture (graph)](#2-the-big-picture-graph)
3. [The folder, at a glance](#3-the-folder-at-a-glance)
4. [Dependencies](#4-dependencies)
5. [The flow: from URL to finished video](#5-the-flow-from-url-to-finished-video)
6. [The core machinery — deep dive](#6-the-core-machinery--deep-dive)
   - 6.1 [Entry point and the `Runtime`](#61-entry-point-and-the-runtime)
   - 6.2 [The tool layer (`src/tools/`)](#62-the-tool-layer-srctools)
   - 6.3 [The workdir: where everything lives on disk](#63-the-workdir-where-everything-lives-on-disk)
   - 6.4 [Stages, versions and the working line](#64-stages-versions-and-the-working-line)
   - 6.5 [The panel (local web UI)](#65-the-panel-local-web-ui)
   - 6.6 [The event bus and background jobs](#66-the-event-bus-and-background-jobs)
   - 6.7 [The browser layer](#67-the-browser-layer)
   - 6.8 [The recorder](#68-the-recorder)
   - 6.9 [Voice-over, TTS and alignment](#69-voice-over-tts-and-alignment)
   - 6.10 [The audio-led edit](#610-the-audio-led-edit)
   - 6.11 [Annotations](#611-annotations)
   - 6.12 [Render and QA](#612-render-and-qa)
   - 6.13 [The smaller cast: discovery, compare, confidence, director, brands](#613-the-smaller-cast)
   - 6.14 [Skills, CLI and scripts](#614-skills-cli-and-scripts)
7. [A worked session, end to end](#7-a-worked-session-end-to-end)
8. [Where the tests live](#8-where-the-tests-live)
9. [Things worth knowing before you change something](#9-things-worth-knowing-before-you-change-something)

---

## 1. The one-paragraph version

`demo-recording` is a pi extension that records narrated demo videos of web apps. You
give it a URL and a brief; it explores the app with a real (headless) browser, writes a
storyboard you approve in a local web panel, records the whole thing as one continuous
human-looking take — virtual cursor, realistic typing, improvised inputs — then writes
a voice-over *from the recording that actually happened*, speaks it with ElevenLabs (or
OpenAI, or a local Kokoro voice), bends the video to the narration, adds zooms and
callouts, renders it branded, and runs an automatic QA pass before you accept the
result. Every step produces an immutable numbered version on disk, nothing advances on
the model's say-so alone, and the only browser that opens is on your loopback interface.

It's a big extension — roughly 700 files, ~200 of them tests — because it is genuinely
five products in one: an agent harness (tools + skills), a browser automation stack, a
screen recorder, a small film-editing suite, and a local review web app.

---

## 2. The big picture (graph)

The honest picture has four kinds of participants, and keeping them straight is most of
understanding the codebase:

- **You** (the human) — approve things, answer questions, give direction.
- **The Director** — the model running in the pi session. It decides and writes; it
  calls the extension's tools. It never touches a file it wasn't given.
- **The engine** — the extension's own Node/TypeScript code. It executes, measures,
  verifies. It is deliberately *not* an LLM.
- **Scripts and external tools** — Playwright, ffmpeg, faster-whisper, Kokoro, the TTS
  providers.

```
                        ┌──────────────────────────────────────────────────┐
                        │                  pi session                      │
                        │                                                  │
                        │   you ──chat──► Director (model)                 │
                        │                  │  calls tools                  │
                        │                  ▼                                │
                        │   demo_rec_project / _browser / _storyboard /     │
                        │   _record / _take / _vo / _tts / _edit /          │
                        │   _annotations / _render / _qa / _compare ...     │
                        │   (17 tools, registered in index.ts)              │
                        └───────────────┬──────────────────────────────────┘
                                        │  engine code (src/)
                 ┌──────────────────────┼───────────────────────┐
                 ▼                      ▼                       ▼
        ┌────────────────┐   ┌───────────────────┐   ┌────────────────────┐
        │  browser layer │   │   workdir on disk  │   │  background jobs   │
        │  (Playwright)  │   │  ~/DemoRecordings  │   │  (record, tts,     │
        │  cursor, typing│   │  apps/<app>/       │   │  edit, render, qa) │
        │  screencast    │   │  projects/<proj>/  │   │  abortable,        │
        │  safety guard │   │   brief.md, state, │   │  progress → bus    │
        └───────┬────────┘   │   storyboard/,    │   └─────────┬──────────┘
                │            │   takes/, vo/,    │             │
                │            │   annotations/,    │             │ events
                │            │   render/          │             ▼
                │            └─────────┬──────────┘   ┌────────────────────┐
                │                      │ read/write  │  EventBus (bus.ts) │
                │                      │             │  ring of 500,      │
                │                      │             │  replay for late   │
                │                      │             │  subscribers       │
                │                      │             └────┬─────────┬────┘
                │                      │                  │         │ ws + polling
                │                      │                  ▼         ▼
                │                      │        ┌─────────────────────────┐
                │                      │        │  local panel (HTTP)     │
                │                      │        │  127.0.0.1, bearer      │
                └──────────────────────┴───────►│  token, vanilla-JS UI   │
                                                │  review / approve / map │
                                                └───────────┬─────────────┘
                                                            │ your clicks
                                                            ▼
                                                   a user message back to
                                                   the Director (the bridge)
```

The two arrows worth staring at:

- **Panel → Director.** Everything you click in the panel becomes *one* user message
  delivered into the pi session (`bridge.ts` formats it). The panel never edits files
  behind the agent's back on anything directional; the agent is the one who acts.
- **Disk is the truth.** Stages, versions, lineage — all of it is *read from the
  artifact files* (`take.json` names its storyboard version, a render's metadata names
  its annotations version). There is no database and no second source of truth to get
  out of sync. `state.json` only records approvals and which line is "the working
  line".

---

## 3. The folder, at a glance

```
extensions/demo-recording/
├── index.ts            # the extension factory — the only file pi loads
├── cli.ts              # standalone runner: `panel`, `accept`, doctor, fixture helpers
├── package.json        # playwright, ws, yaml (deps); pi + typebox (peers)
├── src/                # ~150 TypeScript modules, plain .ts (jiti, no build step)
│   ├── runtime.ts      # per-session god object: config, bus, jobs, panel, project
│   ├── bus.ts          # typed event bus (ring buffer, replay)
│   ├── jobs.ts         # background job registry (abortable, one per kind)
│   ├── config.ts       # settings, defaults, env overrides (~/.config/demo-recording)
│   ├── roles.ts, grants.ts, questions.ts, question-flow.ts, question-chat.ts
│   ├── commands/demo.ts        # the /demo slash command
│   ├── tools/          # 17 registerXTool() modules — the agent's hands
│   ├── workdir/        # projects & apps on disk: layout, state, stages, lineage
│   ├── discovery/      # phase-1 app exploration (session, survey, measure, report)
│   ├── browser/        # Playwright: launch, pool, safety, cursor, typing, screencast
│   ├── recorder/       # the storyboard runner (one continuous take)
│   ├── recording/      # notes taken while recording (project memory)
│   ├── analysis/       # take analysis: timing, marks, dead time, motion
│   ├── vo/             # voice-over script store + validation
│   ├── tts/            # engine chain: elevenlabs → openai → kokoro → say
│   ├── align/          # word-timing alignment (whisper + energy onsets)
│   ├── edit/           # audio-led edit: sync, timeline, fit, draft render
│   ├── annotations/    # suggestion, resolve, weights, privacy, render
│   ├── render/         # final render, subtitles, sidecars, poster, stamp
│   ├── qa/             # the automatic check and the fix loop
│   ├── compare/        # version-vs-version verdict (facts, not vibes)
│   ├── confidence/     # storyboard/vo/annotation confidence scoring
│   ├── panel/          # local HTTP server + route modules + public/ frontend
│   ├── brand/          # brand packages (logo, colors, title card)
│   ├── director/       # watches pi events → "what is the Director doing"
│   ├── projects/       # create/open/list projects
│   ├── graph/          # the version graph for the panel's map view
│   ├── drafts/         # unsaved panel edits per stage
│   ├── spike/          # timeboxed experiments (capture, zoom)
│   ├── pipeline/, fixture/, auth/, media/, models.ts, util/ ...
├── skills/             # 6 SKILL.md files shipped with the extension
├── py/                 # small Python helpers (kokoro_tts.py, align.py) via uv
├── brands/             # built-in `neutral` brand package
├── test/               # ~200 test files, node:test style
├── scripts/            # shot generators, audits, ratchets (dev tooling)
├── fixtures/           # a sample demo app + storyboards for tests
└── docs/               # VISION, IMPLEMENTATION_PLAN, ARCHITECTURE, ... (rich!)
```

Sizes that matter: `src/recorder/runner.ts` (~1,150 lines) and `src/discovery/session.ts`
(~1,280 lines) are the two monsters; `src/qa/run.ts` (~900) and
`src/panel/public/render.js` (~830) follow. Everything else is pleasantly small and
single-purpose — the module boundaries are real, not decorative.

---

## 4. Dependencies

From `package.json`:

| Package | Kind | What it's actually for |
|---|---|---|
| `playwright` ^1.57 | dependency | The browser. Launch, navigation, the ARIA digest the storyboard targets use, CDP screencast capture. |
| `ws` ^8.18 | dependency | WebSocket push from the engine to the panel (live progress, discovery screens). |
| `yaml` ^2.8 | dependency | Parsing and writing storyboards, which are YAML by design (diffable, reviewable). |
| `@earendil-works/pi-coding-agent` | peer | The extension API: `ExtensionAPI`, events, `ctx.ui`, session entries. Never bundled. |
| `@earendil-works/pi-ai` | peer | Model-call helpers (used by `improvise` and the annotation designer). |
| `typebox` | peer | Schemas for the 17 tool parameter sets. |

And the things it shells out to instead of depending on:

- **ffmpeg** — encoding, cutting, subtitles, loudness normalization (−16 LUFS). Called
  through `src/media/ffmpeg.ts`.
- **uv + Python** — `py/kokoro_tts.py` (offline Kokoro voice, ~124 MB of models) and
  `py/align.py` (faster-whisper `base.en` word timings, ~145 MB) when the TTS engine
  isn't ElevenLabs (which ships its own character timings).
- **TTS providers** — ElevenLabs (primary, voice *by name*), OpenAI `gpt-4o-mini-tts`
  (fallback), macOS `say` (dev/tests only). Keys come from the environment only —
  never from the config file, never logged.

Node ≥ 22. The extension runs straight from `.ts` via jiti, so there is no build step
and no compiled output to keep in sync — you edit `src/`, you restart or `/reload`.

---

## 5. The flow: from URL to finished video

The pipeline is a five-stage chain, and the stage names are load-bearing — they appear
as directories, version families, panel tabs and tool gates:

```
 brief ──► discovery ──► storyboard ──► recording ──► vo ──► annotations ──► render
 (you)      (agent +      (agent writes,  (engine      (agent      (engine        (engine)
             browser)      you approve)    records)     writes)     suggests,      + QA check
                                                                       you accept)
                    every step writes an immutable, numbered version to disk
```

In slow motion:

1. **`/demo new <project> <app-url>`** — `commands/demo.ts` creates the project under
   `~/DemoRecordings/projects/<slug>/` (brief.md, `state.json`, stage directories),
   opens the panel, starts the `demo-brief` skill.
2. **Discovery** — the agent drives the app through the `demo_rec_browser` tool: a
   first *survey* (the engine walks the navigation itself, ~2 s a page), then targeted
   deep looks. Budgets (screens/actions/minutes) are enforced by the engine, and at the
   end the agent must write a **discovery report** where every claim cites a screen,
   a finding or a source. Refused if a declared area was never seen.
3. **Storyboard** — the agent writes YAML: scenes, steps, `mark`s, targets written as
   ARIA `{role, name}` pairs. `demo_rec_storyboard write` validates and stores an
   immutable version. You review per scene in the panel; your review travels back as
   one `[demo-panel]` message; the agent writes v2, and so on. **You** approve (the
   agent structurally cannot).
4. **Recording** — `demo_rec_record start` launches a background job. The runner
   walks the storyboard with a human-ish cursor (`cursor/motion.ts` — bezier-ish arcs,
   overshoot, idle drift), human-ish typing, and *improvised* inputs for search boxes
   and chat (a fast model invents text while the cursor travels). One failing scene
   doesn't kill the take: footage is cut at the scene start, the app state is restored
   off-camera, capture resumes as a stitched segment. Output under
   `takes/take-NNN/`: frames, `events.jsonl`, `take.json`, `raw.mp4`.
5. **Analysis → voice-over** — `demo_rec_take analyze` extracts per-scene timing, mark
   timestamps, page text at each mark, dead time, error toasts. The agent then writes
   the VO from *that*, with `[@mark]` anchors and `{{dom:mark|regex}}` bindings that
   pull real on-screen values. Validated against the take (an anchor that doesn't
   exist is an error, not a warning).
6. **Voice** — `demo_rec_tts` synthesizes per section with one engine for the whole
   video; if it dies mid-way, the chain restarts with the next engine. Audio is cached
   by content, so re-renders only pay for what changed.
7. **Edit** — `demo_rec_edit` bends the take to the narration: cut dead time first,
   then gentle speed-ups of static stretches, then trims, then hold settled frames or
   let the narrator pause if it can't shrink. Typing and clicks are never time-warped.
   Produces a 960×540 draft to watch.
8. **Annotations** — the engine suggests ~2× what should be on (zooms, highlights,
   spotlights, callouts, chapter titles, privacy redactions) from the real recording
   and narration, resolves/weights them, auto-enables the best half, adds redactions.
   You accept in the panel.
9. **Render** — `demo_rec_render final` produces 1920×1080 (per-brand variants,
   per-scene clips, transcript VTT, callouts SRT, poster) and automatically runs **QA**
   on every final: values said vs shown, error toasts, sync drift, frozen/black/silent
   stretches, redaction gaps. Findings come back to the agent as a fix loop
   (`demo_rec_qa`), earliest-stage fix first.

---

## 6. The core machinery — deep dive

### 6.1 Entry point and the `Runtime`

`index.ts` is deliberately boring — that's the design. A factory function that:

- constructs one `Runtime` (`src/runtime.ts`, ~660 lines) and wires everything to it;
- contributes the skills folder via `resources_discover` (so skills survive filtered
  package installs);
- restores the active project on `session_start` from the session's custom entries;
- registers the director watcher (what the Director is doing, from pi events), the
  question-chat handler, `/demo`, and the 17 tools;
- tears everything down on `session_shutdown`.

The `Runtime` owns: config (merged: defaults → global → project → env), the `EventBus`,
the `Jobs` registry, the panel handle, the active project, the discovery session, the
model bindings, and the **bridge** — the function that turns panel actions into user
messages via `pi.sendUserMessage`. It's the one place where "the extension-wide state"
lives; tools receive it and reach through it. Nothing long-lived starts in the factory
itself (a pi session may load the extension just to list tools).

### 6.2 The tool layer (`src/tools/`)

One file per tool, each exporting `registerXTool(pi, rt)`. The tools are thin: they
parse parameters, do permission/budget checks, then call into the engine modules. The
division of labor that matters:

- **Agent-facing intelligence** (writing the storyboard, the VO, the discovery report,
  the QA proposals) lives in the **skills**, not the tools.
- **Verification and refusal** lives in the tools: `demo_rec_storyboard` refuses a
  storyboard covering an unseen area, `demo_rec_record` refuses without an approved
  storyboard, `demo_rec_tts` refuses without an approved voice-over, `demo_rec_render
  final` refuses without accepted annotations, `demo_rec_compare` refuses verdicts not
  backed by measured facts.

That last point is the extension's most repeated trick, and once you see it you see it
everywhere: **the agent proposes, the engine disposes.** The model can write any
narration it likes; the tool checks every `[@mark]` against the take. It can suggest
any annotation; the resolver decides whether the target element exists and where.

### 6.3 The workdir: where everything lives on disk

Root defaults to `~/DemoRecordings` (config `root`, env `DEMO_REC_ROOT`), set up by
`src/workdir/layout.ts`:

```
~/DemoRecordings/
├── apps/<app>/            # app registry: app.json, auth/ (0700, login rules only)
└── projects/<slug>/
    ├── brief.md           # versioned; the demo's identity
    ├── context/           # inputs.jsonl (project memory), findings, notes
    ├── state.json         # approvals + working line ONLY (never content)
    ├── storyboard/v1.yaml, v2.yaml ...
    ├── takes/take-001/    # frames/, events.jsonl, take.json, raw.mp4, scenes.json
    ├── vo/v1.md ...       # narration scripts (immutable versions)
    ├── annotations/v1.json ...
    └── render/vN/<flavor>/ final mp4s, scenes/, subtitles, poster, QA report
```

`context/inputs.jsonl` is the project memory: every directional input (chat directions,
panel reviews, inline edits, noted sources/assets) is appended with an id; withdrawn
directions are marked `outdated`, never deleted. `demo_rec_project context` packs the
brief + working line + lineage + active inputs into the agent's next turn, which is how
a restarted session picks up where it left off.

### 6.4 Stages, versions and the working line

`src/workdir/stages.ts` defines the chain
(`storyboard → recording → vo → annotations → render`) and the rules that make branching
safe:

- Every version is **based on exactly one parent version**, read from the artifact
  files themselves — a take's `take.json` names its storyboard, a render names its
  annotations. Not from filenames, not from `state.json`.
- **Accepted** versions are recorded in `state.json` (`accepted.<stage>.<version>`),
  and several versions per stage can be accepted — accepting resets nothing, it just
  says "good enough to build on".
- **Usable** means accepted *and* every ancestor accepted. Withdraw an approval and
  downstream versions become "blocked by dependency" — flagged, not deleted.
- The **working line** (`line.<stage>`) is the single path the panel highlights and
  tools default to. Tools take an explicit version when they want to branch.

`src/graph/build.ts` turns these files into the version graph the panel's map view
draws — computed, never stored, so it cannot disagree with the disk.

### 6.5 The panel (local web UI)

`src/panel/server.ts` starts a plain Node HTTP server on the **loopback interface
only**, with a random **bearer token** (POST routes require it; the URL you're given
includes it). No framework — `routes.ts` plus per-concern route modules
(`stage-routes`, `version-routes`, `render-routes`, `annotation-routes`, `qa`'s
`fix-routes`, `config-routes`, ...) each contributing typed GET/POST handlers. The
frontend is `src/panel/public/` — vanilla ES-module JavaScript, no bundler, ~60 small
files with real `.d.ts` declarations for the shared cores. That's unusual and it's on
purpose: no build step, reviewable diffs, and the same code runs in dev and prod.

The panel can do three kinds of things:

1. **Show** — live discovery, recording progress, versions, the version map, costs.
2. **You** — approve/withdraw versions, edit VO sections (each save = new version),
   answer questions, mark findings.
3. **Ask the agent** — every directional action becomes one `[demo-panel]` user message
   through the bridge. The panel is the *review surface*, not a second pilot.

### 6.6 The event bus and background jobs

`bus.ts` is a tiny typed pub/sub with a 500-event ring buffer, so a panel opened
mid-run replays recent history. `jobs.ts` runs the long work (record, tts, edit,
render, qa) detached from the tool call: the tool returns immediately, progress flows
to the bus → panel + pi's footer status, and when the job finishes the result is
delivered back into the session as a `[demo-recording]` message. One job per kind at a
time (starting a second recording while one runs is a clean error), everything
abortable via `AbortController`.

### 6.7 The browser layer

`src/browser/` wraps Playwright into something a demo needs:

- `launch.ts` / `pool.ts` / `session.ts` — lifecycle and a small pool.
- `safety.ts` — every action passes a check: destructive/financial/sharing actions are
  **blocked**, state-changing ones allowed but audited and surfaced to you in the
  panel's safety feed. This is why the extension can explore a real app without
  being dangerous.
- `diagnosis.ts` + `digest.ts` — the ARIA digest: role/name targets with exact values,
  which the storyboard targets and the annotation resolution are written against.
- `capture/screencast.ts` — CDP screencast recording (JPEG frames + frame events),
  which is what actually gets encoded into the take.
- `cursor/motion.ts`, `cursor/typing.ts`, `cursor/overlay.js` — the human illusion:
  arcs and easing with slight overshoot, per-key typing cadence, idle drift on dwell.
  The overlay is injected JS that draws the virtual cursor into the page.

### 6.8 The recorder

`src/recorder/runner.ts` is the take engine. Per scene it: resolves each step's target
(ARIA-first), moves the cursor there like a hand would, types/clicks/scrolls, stamps
**marks** into `events.jsonl` with timestamps, keeps `attempts.jsonl` for diagnostics,
and emits progress snapshots for the panel. Failure handling is the interesting part —
a scene that can't complete is cut at its start, the app is restored off-camera (deep
link or a fast off-screen replay of previous scenes), and capture resumes as a new
segment stitched at the boundary. Previous good footage is never thrown away. Improvised
inputs (`improvise.ts`) are generated by a fast model *while the cursor travels*, so
search boxes get plausible text with no extra latency.

### 6.9 Voice-over, TTS and alignment

- `vo/script.ts` + `vo/store.ts` — the script format (markdown, front matter, sections
  per scene plus `_intro` / `_bridge:<scene>` / `_outro`), `[@mark]` anchors,
  `{{dom:mark|regex}}` bindings, validation against the take.
- `tts/engines.ts` — the chain: ElevenLabs (voice by name, provider character timings)
  → OpenAI → Kokoro (local, via `uv`) → `say`. One engine per video, fail-over
  mid-way restarts the section. Synthesis is cached by content hash.
- `align/onset.ts` + `align/align.ts` — when the engine isn't ElevenLabs, word
  timings come from faster-whisper refined by audio energy onsets (the Python side),
  then anchored to mark events.

### 6.10 The audio-led edit

`src/edit/` — the fixed order of operations in `pipeline.ts` matters and is documented
in place: **cut dead time → speed up static stretches (≤1.6×; streamed answers 1.3×;
in-app video 1.15×) → trim → slow down or hold a settled frame if the narration runs
long → let the narrator pause if the video can't shrink.** Never touched: typing and
clicks (the human illusion must stay real). `sync.ts` computes where every anchor
lands; the result message reports per-scene cuts/holds/pauses and any off-sync anchors.
`render.ts` produces the 960×540 DRAFT so you can watch before committing to finals.

### 6.11 Annotations

`src/annotations/` is a small design studio: `context.ts` builds the input pack
(scenes, marks, narration, on-screen element refs, privacy hits), the agent (with the
`demo-annotations` skill) suggests ~2× what should be on, `resolve.ts` places each
suggestion against real elements (with alternatives when the target is ambiguous),
`weights.ts` + `zoom-limits.ts` score and clamp them, `privacy.ts` adds redactions,
`draft.ts`/`preview-queue.ts` power the panel's drafts and clip previews, and
`render.ts` draws zooms, highlights, spotlights, callouts, chapter cards into frames.

### 6.12 Render and QA

`render/run.ts` — finals need accepted annotations: full-size 1920×1080 per brand
variant, per-scene clips, transcript VTT, callouts SRT, poster, DRAFT tag absent.
`qa/run.ts` then checks every final automatically: numbers the narration said vs what
the page showed, error toasts that leaked into footage, anchor sync drift,
frozen/black/silent stretches, redaction gaps. `qa/fixes.ts` is the fix loop: you
flag findings in the panel, the agent proposes one fix per affected stage
(earliest stage first), you approve, a new version carries it. `compare/` is the
cousin: verdicts between two storyboard or VO versions, built only from counted
facts, and the tool refuses a verdict without a measured fact behind it.

### 6.13 The smaller cast

- **`discovery/`** — the biggest module: the browser session with enforced budgets,
  the survey engine, progress measurement (progress counts what was *seen*, not what
  was declared), a watchdog (a browser that doesn't answer is restarted on the same
  page), a heartbeat, and the report store. The storyboard gate lives here: an area
  declared in the discovery plan but never seen blocks the storyboard.
- **`confidence/`** — soft signals (how much real evidence backs a storyboard scene,
  a VO section, an annotation set), surfaced in the panel, never blocking on their own.
- **`director/`** — watches pi's own events to display what the Director is doing in
  the panel. Read-only; the extension never steers the session on its own initiative.
- **`brand/`** — brand packages (logos for light/dark, colors, fonts, title card,
  logo bug, backdrop); `brands/neutral` is the built-in default.
- **`drafts/`** — unsaved panel edits per stage, private until saved (so two people —
  or you and the agent — can't clobber each other).
- **`auth/`** — app login rules (stored under `apps/<app>/auth/`, mode 0700, contents
  never surfaced; the panel shows login *state* only).
- **`models.ts`** — which model class does what: the session model for direction, fast
  models for improvise/designer suggestions.
- **`util/`** — bounded collections, a janitor for temp files, seeded RNG (reproducible
  motion/typing), zip handling, word diffs.

### 6.14 Skills, CLI and scripts

- **`skills/`** — six skills ship inside the extension and are offered through
  `resources_discover`: `demo-recording` (the director's main brain), `demo-brief`,
  `demo-voiceover`, `demo-annotations`, `demo-brand`, `demo-config`. The heavy
  "how to write a storyboard / VO" guidance lives here, not in the tools — which keeps
  the tools enforceable and the prose editable.
- **`cli.ts`** — a standalone escape hatch outside pi: `panel` (run the control room on
  its own port), `accept` (approve a version from the shell — the same gate as the
  panel button), doctor, and fixture helpers. Useful for debugging and CI.
- **`scripts/`** — dev-only: screenshot generators for the docs, a panel audit, UX
  "ratchet" checks (fail if the panel's network/keyboard footprint regresses), the
  diagram renderer for `docs/diagrams/*.mmd`.

---

## 7. A worked session, end to end

Putting the pieces in one sequence — this is what a complete run *feels like* from the
inside, with the code that fires at each step:

| What happens | Code involved |
|---|---|
| You: `/demo new loans-demo http://localhost:3000` | `commands/demo.ts` → `projects/manage.ts` → `workdir/layout.ts` |
| Panel opens; `demo-brief` skill drafts brief.md with you | `panel/server.ts`, skills |
| You: `/demo discover quick` | `tools/browser.ts` → `discovery/session.ts`, `survey.ts` |
| Budget spent; agent writes discovery report | `tools/discovery-report.ts` → `discovery/report.ts` |
| Agent writes storyboard v1 | `tools/storyboard.ts` → `storyboard/parse.ts`, `store.ts` |
| You mark scenes, hit *Send review* | `panel/stage-routes.ts` → `bridge.ts` → `pi.sendUserMessage` |
| Agent writes v2; you hit *Approve v2* | `panel/version-routes.ts` → `workdir/stages.ts` |
| You: "record it" | `tools/record.ts` → `jobs.ts` → `recorder/runner.ts` (+ `browser/*`, `cursor/*`, `capture/screencast.ts`) |
| Take done → `[demo-recording]` message wakes the Director | `jobs.ts` onFinish → `runtime.ts` bridge |
| Agent analyzes take, writes VO v1 | `tools/take.ts` → `analysis/take.ts`; `tools/vo.ts` → `vo/store.ts` |
| You edit sections inline, then *Approve* | `panel/voice-routes.ts`, `drafts/` |
| `demo_rec_tts` speaks it | `tools/tts.ts` → `tts/*`, `align/*` (maybe `py/`) |
| `demo_rec_edit` bends the take; DRAFT appears | `tools/edit.ts` → `edit/pipeline.ts`, `sync.ts` |
| Annotations suggested; you accept | `tools/annotations.ts` → `annotations/*` |
| `demo_rec_render final` + automatic QA | `tools/render.ts` → `render/run.ts`, `qa/run.ts` |
| You accept the deliverable in the panel | `panel/render-routes.ts` |

Every box in that right column is a versioned artifact under
`projects/<slug>/` before the next one starts. If anything goes wrong at step *n*, you
re-do step *n*, not the whole chain — that's the entire point of the stage design.

---

## 8. Where the tests live

`test/` is ~200 files using **`node:test`** (no external test framework), with helpers
in `test/helpers/` that stub a pi session, seed a panel, build fake projects, and run
the fixture demo app (`fixtures/demo-app/` — a tiny static app with search, rows and
modals, served by `src/fixture/server.ts`). The naming is historical but readable:
`s1-*` capture, `s2-*` discovery/panel, `s3-*` recording, `s4-*` VO/TTS/edit,
`s5-*` stages/annotations/render/QA, `s7-*` login, `ux*` panel behavior, `p1a-*` the
director/QA redesign. There's even a `docs-architecture.test.ts` that keeps the
extension's own architecture doc honest.

The tests are a surprisingly good map of intent — if you want to know exactly what a
module promises, read its test first.

---

## 9. Things worth knowing before you change something

A short list of invariants that are easy to break and expensive to break silently:

1. **Nothing long-lived starts in the extension factory.** Timers, servers, browsers
   belong to `session_start`/first-use; `session_shutdown` must be idempotent.
2. **Disk is the source of truth.** If you add state, decide whether it belongs in the
   artifact (then put it in the file the stage writes) or in `state.json` (approvals
   and the working line only). Never both.
3. **Approvals are yours and only yours.** No code path may auto-approve a version;
   the tools must keep refusing to act on unaccepted inputs.
4. **The engine never invents.** Values shown in narration are checked against page
   text captured at marks; verdicts need measured facts; coverage claims need seen
   screens. Keep the refusals.
5. **Typing and clicks are never time-warped** in the edit, and the human motion
   parameters are tuned — resist "just speed it up" fixes.
6. **The panel is loopback + bearer token only.** It serves the workdir's media files;
   treat any new route as needing the same guard.
7. **Secrets stay in the environment.** Config never stores keys; auth directories are
   0700 and their contents are never rendered or logged.
8. **One job per kind.** If you add a background job, it goes through `Jobs` with an
   AbortController and a panel-visible label — not a bare `setTimeout`.
9. **Skills carry the prose, tools carry the rules.** If you find yourself encoding
   writing advice into a tool description, it probably belongs in a skill.
10. **The tests are the contract.** Several of them assert the *exact* refusal
    messages and stage gating — update them deliberately, not accidentally.

---

*Written from the code as it stands (S0–S5 complete, S6 parallel discovery / S7 login
hardening / S8 native capture still ahead). If this doc and the code disagree, believe
the code, then fix the doc — and the extension's own `docs/` tree in
`extensions/demo-recording/docs/` is the deeper reference: `ARCHITECTURE.md` for the
why, `ACTORS.md` for who does what, `IMPLEMENTATION_PLAN.md` for the slice history,
and `VISION.md` for the decisions.*
