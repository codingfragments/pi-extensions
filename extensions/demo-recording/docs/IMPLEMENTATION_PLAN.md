# demo-recording — Implementation Plan

Companion to [VISION.md](VISION.md) (decisions D1–D20). This plan is built
from **vertical slices**: every slice ends with something you can run
end-to-end and watch, never with a layer that only works in isolation.
Slice S1 already produces a (crude) narrated MP4. Every later slice makes
one part of that pipeline good.

---

## 1. Architecture

```
┌──────────────────────── pi session (director) ────────────────────────┐
│ model: session model (Anthropic / OpenAI)                             │
│ skills: demo-recording (workflow), demo-brief, demo-voiceover         │
│ tools:  demo_rec_*  (see §4)                                          │
└───────────────┬───────────────────────────────────────▲───────────────┘
                │ tool calls                             │ sendUserMessage
                ▼                                        │ (panel actions)
┌──────────────────────── engine (deterministic Node) ───┴──────────────┐
│ workdir/  state machine + approval gates + versioning                 │
│ browser/  chromium session, storageState, virtual cursor, perception, │
│           in-page observers, safety, capture (CDP screencast)         │
│ recorder/ storyboard runner, improvise, event log, resume             │
│ tts/      provider chain (elevenlabs → openai → kokoro → say), cache  │
│ align/    word timestamps (provider-native or whisper)                │
│ edit/     sync solver → timeline.json → ffmpeg render, overlays       │
│ qa/       freeze/silence/black, alerts, value check, drift            │
│ bus       typed event bus ──────────────┐                             │
└─────────────────────────────────────────┼─────────────────────────────┘
                                          ▼ ws
┌──────────────── panel (127.0.0.1:3777, token-protected) ──────────────┐
│ LIVE · REVIEW · VOICE · EXPORT   — Preact + htm, vendored, no build   │
└───────────────────────────────────────────────────────────────────────┘
          all artifacts ──►  ~/DemoRecordings/{apps,projects}/…
```

**Principles**

1. **Human gates are enforced in the engine, not in the prompt.**
   `demo_rec_record` refuses to run without an approved storyboard version.
   `demo_rec_tts` refuses to run without an approved VO script version.
2. **Every artifact is versioned and immutable.** New storyboard → `v4.yaml`.
   New take → `take-003/`. `state.json` points at the approved/current versions.
3. **Engine operations are pure functions over the workdir** (inputs → files),
   and each one can also be invoked through a CLI (`node extensions/demo-recording/cli.ts …`).
   The test suite and debugging don't need a model.
4. **One clock per take.** CDP screencast frame timestamps are the time base.
   Every event, DOM snapshot and keyframe is stamped in that time base.
5. **Long-running work runs in the background.** Tools return a job id
   immediately, progress streams to the bus/panel, and completion is reported
   back into the session with `pi.sendMessage`.

---

## 2. Module layout

```
extensions/demo-recording/
├── index.ts                    entry: tools, commands, resources_discover, lifecycle
├── cli.ts                      engine CLI (tests, debugging, no model needed)
├── package.json  README.md
├── docs/  VISION.md  IMPLEMENTATION_PLAN.md
├── src/
│   ├── config.ts               settings: root dir, viewport, fps, tts chain, budgets
│   ├── bus.ts                  typed event bus (engine → panel/session)
│   ├── jobs.ts                 background job runner, cancellation, progress
│   ├── workdir/                layout, state.json, versioning, gates, takes
│   ├── browser/
│   │   ├── session.ts          launch, storageState restore/save, viewport/DPR
│   │   ├── cursor/overlay.js   injected virtual cursor (SVG, styles, click ripple)
│   │   ├── cursor/motion.ts    ghost-cursor paths → page.mouse + overlay sync
│   │   ├── cursor/typing.ts    human typing model
│   │   ├── cursor/scroll.ts    eased wheel scrolling
│   │   ├── perceive.ts         screenshot + DOM harvest (text, roles, boxes, values)
│   │   ├── observers.js        injected: route changes, alerts/toasts, console, network idle
│   │   ├── safety.ts           denylist, mutation classifier, audit log, policy
│   │   └── capture/
│   │       ├── screencast.ts   CDP Page.startScreencast → frames/ + index
│   │       └── native-macos.ts (S7) ScreenCaptureKit / avfoundation
│   ├── storyboard/  schema.ts (typebox)  validate.ts  diff.ts
│   ├── recorder/    runner.ts  steps/*.ts  improvise.ts  resume.ts  split.ts
│   ├── vo/          anchors.ts  script.ts
│   ├── tts/         provider.ts  elevenlabs.ts  openai.ts  kokoro.ts  say.ts  cache.ts
│   ├── align/       align.ts
│   ├── edit/        sync.ts  timeline.ts  render.ts  overlays/ (HTML templates)
│   ├── qa/          media.ts  values.ts  drift.ts  report.ts
│   ├── panel/       server.ts  bridge.ts  public/ (index.html, app.js, vendor/)
│   ├── tools/       one file per tool group
│   └── commands/    demo.ts (/demo …)
├── py/                         uv scripts with PEP 723 inline deps
│   ├── align.py                faster-whisper word timestamps
│   └── kokoro_tts.py           local TTS
├── skills/
│   ├── demo-recording/SKILL.md workflow, rules, phase playbooks
│   ├── demo-brief/SKILL.md     draft brief.md, ask for gaps
│   └── demo-voiceover/SKILL.md VO style rules, anchors, stance handling
├── fixtures/demo-app/          static seeded SPA for tests (D20)
└── test/  unit/ integration/ e2e/
```

Skills are shipped **inside the extension** and contributed through the
`resources_discover` event, so they work both from the repo and when
installed via a filtered package source that selects only this extension.

---

## 3. Data contracts (the backbone, defined in S0/S1, evolved later)

### 3.1 Working directory

```
<root>/                                  default ~/DemoRecordings (DEMO_REC_ROOT / settings)
  apps/<app-slug>/
    app.json                             base URL, login probe, notes
    auth/state.json                      storageState, chmod 600, never shown/logged
    policy.json                          optional allow/deny overrides (D6)
    discovery/<yyyymmdd-hhmm>/           screens/*.png, dom/*.json, sitemap.json, audit.jsonl
  projects/<project-slug>/
    brief.md  context/                   brief + attached free-form material
    state.json                           phase, approved versions, history, flags
    storyboard/v1.yaml v2.yaml …
    takes/take-001/
      frames/  frames.jsonl              screencast frames + timestamps
      events.jsonl  dom/  keyframes/
      raw.mp4  scenes.json               CFR master + scene boundaries
      audit.jsonl  qa.json
    vo/script.v1.md …  audio/<engine>/<scene>.wav  alignment/<scene>.json
    edit/timeline.v1.json
    out/scenes/NN-<id>.mp4  out/full.mp4  out/full.callouts.srt
        out/full.transcript.vtt  out/report.md
```

### 3.2 Storyboard (`storyboard/vN.yaml`)

```yaml
version: 2
app: acme-analytics
start_url: /dashboard
viewport: { width: 1600, height: 900, dpr: 2 }
scenes:
  - id: 03-search
    title: Ask in plain language
    takeaway: NL search gets the grouping right first try
    deep_link: /search?q=churn+by+region      # optional, enables solo re-shoot (D8)
    narration_outline:
      - why search matters for this persona
      - quote the outlier region
    steps:
      - { do: move,  target: { role: searchbox, name: Search } }
      - { do: type,  target: { role: searchbox, name: Search }, text: churn by region, mark: type-start }
      - { do: press, key: Enter }
      - { do: wait,  for: { text: Results }, timeout: 15s, mark: results-visible }
      - { do: hover, target: { text: EMEA }, dwell: 1.2s, zoom: true, callout: Regional outlier }
      - { do: improvise, kind: type, target: { role: textbox, name: Ask a follow-up },
          prompt: ask a sharp follow-up based on the visible answer, max_chars: 80,
          submit: true, mark: followup-sent }
    end_assert: { text: EMEA }                # optional
```

Targets resolve in order: `role+name` (Playwright `getByRole`) → `text` → `label` → `css`.
`mark:` names the **anchor events** that the VO can reference. `zoom` and `callout`
are opt-in per step (D14).

### 3.3 Event log (`events.jsonl`)

```json
{"t":2140,"type":"type-start","scene":"03-search","step":1,"mark":"type-start",
 "box":{"x":412,"y":88,"w":520,"h":40},"data":{"text":"churn by region"}}
{"t":9420,"type":"wait-satisfied","scene":"03-search","step":3,"mark":"results-visible","dom":"dom/0031.json"}
{"t":7020,"type":"alert","data":{"role":"alert","text":"Couldn't load segment"}}
{"t":5000,"type":"idle-start"} {"t":9400,"type":"idle-end"}
```

`t` = ms since take start, in screencast time. Idle/loading ranges are first-class
because they are the **preferred cut material**.

### 3.4 VO script (`vo/script.vN.md`)

```markdown
## 03-search — Ask in plain language
Natural-language search, so I'll just ask for churn by region. [@type-start]
Four seconds, and it got the grouping right. [@results-visible] EMEA at
{{dom:results.EMEA.churn}} is the outlier. What I'd want next is the drill-down.
```

- `[@mark]` = anchor. The phrase *after* the anchor starts at the event.
- `{{dom:…}}` is an optional value binding, resolved from the take's DOM snapshot
  and frozen into the text before TTS. Plain literal values are also allowed, but
  QA checks them against the DOM (D13).
- Full-video-only lines (intro, bridges between scenes, outro) live under `## _full`.

### 3.5 Timeline (`edit/timeline.vN.json`)

```json
{"fps":30,"size":[1920,1080],"segments":[
  {"scene":"03-search","src":[2000,5600],"speed":1.0,
   "zoom":[{"t":3100,"box":[400,80,560,60],"scale":1.5,"ease":"inOutCubic"}]},
  {"scene":"03-search","src":[9000,9400],"speed":1.0},
  {"scene":"03-search","freeze":{"at":9400,"dur":1100}}],
 "audio":[{"file":"audio/elevenlabs/03-search.wav","at":0}],
 "callouts":[{"text":"Regional outlier","in":7.2,"out":9.8}],
 "titlecard":null}
```

---

## 4. Tools & commands

Tool names use the `demo_rec_` prefix (collision-resistant, see repo AGENTS.md).

| Tool | Phase | Purpose |
|---|---|---|
| `demo_rec_project` | 0 | create / open / status of a project; writes brief, attaches context |
| `demo_rec_browser` | 1 | discovery browser: `open`, `look` (screenshot + DOM digest), `act` (move/click/hover/type/scroll/navigate via virtual cursor, safety-checked), `close` |
| `demo_rec_storyboard` | 1 | `write` (validate + version + push to panel), `get`, `diff` |
| `demo_rec_record` | 2 | start a take of the approved storyboard (background job); `status`, `cancel`, `resume` |
| `demo_rec_take` | 3 | `keyframes` (images + events + DOM values per scene, for the director), `accept` |
| `demo_rec_vo` | 3 | `write` (validate anchors/bindings against the take, version, push to panel) |
| `demo_rec_tts` | 4 | synthesize the approved VO per scene via the provider chain (background) |
| `demo_rec_edit` | 4 | build timeline (sync solver) + render scenes and full video (background) |
| `demo_rec_qa` | 2–4 | run detectors, write `qa.json` / `report.md`, raise panel flags |

| Command | Purpose |
|---|---|
| `/demo new` | guided brief → project (uses demo-brief skill) |
| `/demo open <project>` | set active project, show status, open panel |
| `/demo login <app>` | headed browser, manual login, save storageState (D5) |
| `/demo panel` | print/open panel URL (with token) |
| `/demo status` | phase, approvals, jobs, flags |
| `/demo doctor` | prerequisites: ffmpeg, uv, chromium, API keys, voice resolution, disk |

**Panel → session bridge.** Panel actions are persisted to `state.json` and
then injected into the session with `pi.sendUserMessage("[demo-panel] …",
{ deliverAs: "followUp" })` while the agent is streaming. Example:
`[demo-panel] storyboard v2: scene 03-search CHANGES — "type slower, zoom on EMEA"; scene 05 APPROVED`.
A pure approval of everything flips the gate directly. The message just informs the director.

---

## 5. Toolset & model choices

| Concern | Choice | Notes / alternatives |
|---|---|---|
| Language/runtime | TypeScript via jiti (no build) | Same as the rest of the repo |
| Browser automation | `playwright` (Chromium) | Already in root devDeps. `npx playwright install chromium` is checked by doctor |
| Human mouse paths | `@playwright-labs/ghost-cursor` (MIT) | Path math (bezier, overshoot, Fitts timing). The visible cursor is **our own overlay**, not its debug helper |
| Capture | CDP `Page.startScreencast` | JPEG q≈92, frame-acked. OS capture in S7 |
| Video processing | ffmpeg (Homebrew) | libx264 for masters, `h264_videotoolbox` optional for fast previews |
| Overlays/title cards | HTML templates → PNG via the same Playwright (`omitBackground`) | No new deps. Brandable later. No Remotion (license) |
| Panel | `node:http` + `ws` + Preact + htm (vendored ESM) | No bundler. Works offline. Bound to 127.0.0.1 with a random token |
| Python helpers | `uv run py/*.py` with PEP 723 inline deps | Self-contained, no venv to manage |
| Alignment | faster-whisper (local, `small.en` → `medium.en`) | Fallbacks: ElevenLabs Scribe or OpenAI `whisper-1` word timestamps |
| TTS 1 | ElevenLabs, custom voice **by name** (`GET /v1/voices` → id, cached), `eleven_multilingual_v2`, `/with-timestamps` | `ELEVENLABS_API_KEY` |
| TTS 2 | OpenAI `gpt-4o-mini-tts` with tone `instructions` | `OPENAI_API_KEY`. Aligned via whisper |
| TTS 3 | Kokoro (local, Apache-2) | Python via uv. Spike S4: `kokoro-js` (ONNX in Node) might avoid Python |
| TTS dev | macOS `say` | Smoke tests and CI only |
| Director model | session model (Claude Sonnet/Opus class or GPT-5 class) | Discovery vision, storyboard, VO, cut decisions |
| In-run `improvise` model | fast model via `@earendil-works/pi-ai` (Claude Haiku / GPT mini class), configurable | Latency is hidden: the call runs **while** the cursor travels to the input |
| Validation | `typebox` schemas for storyboard, events, timeline, VO | Shared with tool parameter schemas |
| Tests | `node --test` (Node 24 type stripping), Playwright headless on the fixture | Heavy e2e is opt-in with `DEMO_REC_E2E=1` |

---

## 6. Vertical slices

Every slice lists **Purpose**, **Deliverables**, **How to test**, and **Exit criteria**.
A slice is done only when its exit criteria pass on the fixture app. From S6 on,
they must also pass on one real app.

### S0 — Skeleton, workdir, fixture, panel "hello" ✅ done

> Done: config (defaults < file < env), workdir layout + immutable versioning +
> state/gates, event bus, token-protected panel (LIVE view) on 127.0.0.1, Acme
> Pulse fixture SPA, doctor, `/demo new|open|status|panel|doctor`, engine CLI.
> 28 tests (incl. real-browser fixture tests). Deviation: `/demo new` takes
> project + URL + app name (stub brief); the guided brief stays in S2.

**Purpose.** Establish the shape everything hangs on: extension loading, config,
the workdir contract, the event bus, the panel server, and a deterministic
target app. Nothing clever. Only the plumbing that every later slice uses.

**Deliverables**
- `index.ts` registers `/demo` (`new`, `open`, `status`, `panel`, `doctor`) and `resources_discover` for skills.
- `config.ts` (root dir, viewport, fps, port, TTS chain, budgets) with settings + env override.
- `workdir/`: create app/project layout, `state.json` read/write, immutable versioning helper.
- `bus.ts` + `panel/server.ts`: 127.0.0.1, random token, ws broadcast. LIVE view shows bus events as a log.
- `fixtures/demo-app/`: static SPA with `/`, `/search`, `/chat`, `/item/:id`, `?slow=1`, `?flaky=1`, all seeded. It's served by the test harness on a free port.
- `/demo doctor`: checks ffmpeg, uv, chromium, keys (presence only, never printed), and free disk.

**How to test**
- Unit: workdir layout + versioning (never overwrite, monotonic versions), config precedence.
- Manual: `pi` → `/demo new` (minimal stub brief) → `/demo panel` → open the URL → see the "project created" event in LIVE.
- Fixture: `node extensions/demo-recording/cli.ts fixture serve` → the app works in a browser and the seeded values are stable across reloads.

**Exit criteria.** `npm run typecheck && npm test` pass. A project folder is created under
the configured root. The panel shows live bus events. Doctor reports a clear PASS/FAIL per prerequisite.

---

### S1 — Thin end-to-end: hard-coded storyboard → narrated MP4 *(the walking skeleton)*

**Purpose.** Prove the whole pipeline exists before any part of it is good:
browser → capture → event log → TTS → naive mux → `out/full.mp4`. It also runs
the **capture spike** (D2/D15 risk): can the CDP screencast sustain 30 fps at
3200×1800 while we drive the page?

**Deliverables**
- `browser/session.ts` (launch headless, viewport + DPR) and `capture/screencast.ts` (frames + `frames.jsonl`, CFR conversion to `raw.mp4` with the ffmpeg concat demuxer + per-frame durations).
- Minimal `recorder/runner.ts`: executes `move`/`click`/`type`/`wait`/`press` from a **hand-written** 1-scene storyboard YAML. Teleporting mouse is OK here, but the **overlay cursor must be visible**.
- `events.jsonl` with screencast-clock timestamps.
- `tts/say.ts` + naive mux (audio laid from t=0, video padded/trimmed).
- CLI: `cli.ts run-s1 --fixture` does everything in one go.

**How to test**
- Spike report (`docs/spikes/S1-capture.md`): measured fps, dropped frames, CPU, and file sizes at 3200×1800 vs 2560×1440. This decides the default.
- E2E (`DEMO_REC_E2E=1`): run on the fixture, then `ffprobe` asserts duration > 0, 1920×1080, 30 fps, and an audio stream present. Extract the frame at the `results-visible` event and assert it differs from the frame before it (the page actually changed).
- Manual: watch `out/full.mp4`. The cursor is visible and the text is crisp.

**Exit criteria.** One command produces a watchable narrated MP4 from the fixture.
The capture default is decided with data.

---

### S2 — Brief, discovery, storyboard, panel review loop *(Phase 0–1)*

**Purpose.** Make the first human-facing loop real: brief → agent explores →
storyboard builds up live in the panel → user approves / requests changes /
asks for a scene rerun → new version → approval gate flips.

**Deliverables**
- `skills/demo-brief`: drafts `brief.md` (URL, audience, stance, goal, target length, must-show/avoid, language, voice name) from free-form input. Asks for gaps. Web search only when asked.
- `demo_rec_browser` (`open`/`look`/`act`/`close`): `look` returns a screenshot (vision-first, D4) plus a compact DOM digest (visible text, interactive elements with role/name/box, key values). It reuses the S3 cursor when available, otherwise S1 moves.
- `browser/safety.ts` (D6): denylist, mutation classifier, `audit.jsonl`, `policy.json`. Mutating actions appear live in the panel.
- Discovery artifacts: `apps/<app>/discovery/<ts>/` (screens, DOM, sitemap), reusable across projects.
- Discovery budget in config: max screens, actions and minutes. The director is told its remaining budget in every `look` result.
- `storyboard/schema.ts` + `validate.ts` + `diff.ts`, and `demo_rec_storyboard`.
- `skills/demo-recording`: phase playbook covering how to explore, what makes a scene demo-worthy, human-like flow rules (look before you click, dwell on results, don't zig-zag), and the storyboard authoring rules.
- Panel **LIVE** (current screenshot, action log, storyboard cards building up) and **REVIEW** (scene cards with thumbnail, steps, narration outline; approve / changes + notes / re-run; whole-storyboard approve).
- Bridge: panel actions → `state.json` → `sendUserMessage`. Approval gate for recording.

**How to test**
- Unit: schema validation (good/bad storyboards), target resolution order, safety classifier on fixtures of labels ("Delete workspace" blocked, "Search" allowed, "Send" logged as mutating).
- Integration: scripted discovery on the fixture without a model (CLI drives `look`/`act`). The digest contains the seeded KPI values. The audit log records the chat send.
- Manual (with model): `/demo new` → point at the fixture → watch cards appear in LIVE → request changes on one scene in REVIEW → the agent receives `[demo-panel] …` and writes v2 → the diff is shown → approve → `state.json` gate = approved.
- Negative: calling `demo_rec_record` before approval fails with a clear message.

**Exit criteria.** From a free-form brief, the agent produces an approved,
schema-valid storyboard for the fixture app through the panel, with no hand-editing of files.

---

### S3 — Recorder quality: human cursor, typing, improvise, resume *(Phase 2)*

**Purpose.** Make takes look human and survive reality: realistic motion,
typing and scrolling, cursor styles, live `improvise` inputs, complete event
logging, scene splitting, and resume-from-boundary.

**Deliverables**
- `cursor/overlay.js`: SVG arrow / hand / I-beam chosen from the computed `cursor` value under the point, a click ripple, injected via `addInitScript` (survives navigation, position persisted in `sessionStorage`), `pointer-events:none`.
- `cursor/motion.ts`: ghost-cursor paths with overshoot and Fitts timing. Real `page.mouse` events are dispatched along the same path, so hover states fire. A small idle drift during dwell.
- `cursor/typing.ts`: log-normal per-key delays, longer pauses at word boundaries, an optional low typo+backspace rate (config, default off for real takes).
- `cursor/scroll.ts`: eased wheel increments, with scroll-into-view done humanly instead of jumping.
- `observers.js`: route changes, `role=alert`/toast detection, console errors, network-idle and spinner heuristics → `idle-start`/`idle-end` and `alert` events.
- `recorder/improvise.ts`: fast-model call (pi-ai) with screenshot + DOM digest + step prompt. It starts when the cursor begins moving toward the target. The output is logged verbatim in events.
- `recorder/split.ts` → `scenes.json` (boundaries on scene start events). `recorder/resume.ts`: on failure, keep the good prefix and restart from the failing scene via `deep_link` or a fast off-camera replay. A **take is stitched** from segments, and stitch points are recorded.
- Session expiry detection (app login probe) → abort, prompt `/demo login`, resume.
- `demo_rec_record` as a background job with progress → panel LIVE (frame preview at ~2 fps).

**How to test**
- Unit: typing delay distribution (mean and variance within bounds), path generation (no teleports, monotonic time), resume planner (which prefix is kept).
- Integration on the fixture:
  - `?slow=1`: an idle range is logged around the spinner.
  - `?flaky=1`: an `alert` event is logged with its text.
  - Chat scene with `improvise`: the input is non-empty, ≤ `max_chars`, and logged.
  - Kill the browser mid-scene 3 → resume → final `raw.mp4` contains scenes 1–N with exactly one stitch point.
- Visual check (manual, recorded in PR): side-by-side of the S1 vs S3 cursor. Reviewer sign-off "looks human".

**Exit criteria.** The approved fixture storyboard records unattended, headless,
with natural motion and typing. The event log contains every anchor mark,
idle range and alert. A forced failure resumes correctly.

---

### S4 — Analysis, voice-over, TTS chain, alignment, audio-led edit *(Phase 3–4 core)*

**Purpose.** Turn a take into a narrated, tightly synced video. This is the heart
of the product: VO from the actual run, anchors, the provider chain, word
timestamps, and the sync solver that bends video to narration.

**Deliverables**
- `demo_rec_take keyframes`: per scene, keyframes at each event + scene-change detection (ffmpeg `select='gt(scene,0.3)'`), event list, idle ranges, DOM values near anchors. Sized for the model context (thumbnails + a few full-res crops).
- `skills/demo-voiceover`: stance handling (from the brief), density (~155 wpm), banned words, one takeaway per scene, anchor placement rules, value-binding usage, `_full` bridges/intro/outro.
- `vo/anchors.ts` + `demo_rec_vo write`: parse anchors and bindings, validate that every `[@mark]` exists in the take and every `{{dom:…}}` resolves. Bindings are frozen into the text.
- Panel **VOICE**: VO per scene with inline text edit (writes a new version), approve per scene and as a whole, and estimated duration vs available video time per scene.
- `tts/`: provider interface (`synthesize(text, voice, opts) → {audio, words?}`), ElevenLabs (voice-by-name resolution + `/with-timestamps`), OpenAI `gpt-4o-mini-tts`, Kokoro (`py/kokoro_tts.py`), `say`. **Chain policy:** pick the first healthy engine *for the whole video* (D12). Fallback on quota, 5xx, or voice-not-found happens before synthesis starts, never mid-video. Content-hash cache.
- `align/`: normalize provider char timestamps → words. Otherwise `py/align.py` (faster-whisper) with a forced-alignment pass against the known text.
- `edit/sync.ts` (**sync solver**): for consecutive anchors, compare the video span `dv` with the audio span `da`.
  - `dv > da`: cut idle ranges first, then speed-ramp non-typing motion up to 1.6x, then trim dwell.
  - `dv < da`: freeze on the anchor's settled frame, then slow dwell down to 0.85x.
  - Typing and click moments are never altered.
  - Produces `timeline.json`.
- `edit/render.ts`: segments → ffmpeg filter graph → `out/scenes/*.mp4` and `out/full.mp4` (concat with short crossfades). Loudness-normalized to −16 LUFS.

**How to test**
- Unit (pure, the most important tests in the repo): the sync solver on synthetic event/word sets.
  - An anchored word starts within ±80 ms of its event in output time.
  - No cut inside typing.
  - Idle is consumed before speed changes.
  - Total duration is within ±5% of the audio.
- Unit: anchor/binding parser, voice-by-name resolution (mocked API), cache keys, the chain-selection policy.
- Integration: alignment round-trip with `say` audio + `align.py`, with word timings within ±60 ms of `say`'s own word boundaries where available, or a WER check.
- E2E on the fixture (`DEMO_REC_E2E=1`, offline TTS): full Phase 3–4 run produces scene MP4s and `full.mp4`. Whisper on the final audio → anchor words land within ±150 ms of the event frames.
- Manual with ElevenLabs: render the fixture demo with the custom voice and listen. The VO quotes the fixture's seeded values correctly.

**Exit criteria.** From an accepted take, the agent writes an approved anchored VO
through the panel, synthesis runs through the chain, and the rendered videos are
measurably in sync (anchor drift p95 ≤ 150 ms) with dead time removed.

---

### S5 — Polish & deterministic QA *(D13, D14)*

**Purpose.** Lift the result from "correct" to "looks produced", and catch the
failures humans would spot: selective zoom, step callouts, the title card,
and the automated QA report.

**Deliverables**
- Zoom/pan from step `zoom: true` events, using the logged box: eased in → hold → out on the next page change or the next zoom target. Max scale is bounded by DPR headroom.
  - **Spike** (`docs/spikes/S5-zoom.md`): ffmpeg `scale=eval=frame` + per-frame `crop` expressions vs Node-side frame compositing (sharp). Pick by quality and speed.
- Callouts (step captions, D14): HTML template → transparent PNG → `overlay` with fade, timed from step events. Sidecar `full.callouts.srt`. Optional `full.transcript.vtt` from the alignment (off by default).
- Title card (full video only): HTML template from the brief (app name, topic, date) → 3 s clip, fade.
- `qa/`:
  - `media.ts`: ffmpeg `freezedetect`, `silencedetect`, `blackdetect` on rendered outputs.
  - `values.ts`: every number/name in the final VO text exists in the DOM snapshot at its anchor (or in the nearest snapshot within the scene). A mismatch is a hard flag.
  - Alerts/console errors during the used segments are flagged with timestamps.
  - `drift.ts`: whisper on the rendered audio vs the script → per-scene drift score.
  - `report.md` + panel flags on scene cards. The director auto-fixes trivial flags (re-time, re-cut) and asks about the rest.
- Panel **EXPORT**: playable outputs, downloads, QA report.

**How to test**
- Unit: zoom keyframe generation (never exceeds headroom, eases, no zoom on unflagged steps), callout timing, the value extractor (numbers with units/percent/currency, names).
- E2E on the fixture:
  - `?flaky=1` produces an alert flag at the right timestamp.
  - A VO with a deliberately wrong value gets a hard flag.
  - `?slow=1` without a cut (solver disabled) gets a freeze/dead-air flag.
- Manual review: the fixture demo with zooms on 2 flagged steps only, callouts on the important steps, and a title card on the full video only.

**Exit criteria.** QA catches all three injected fixture defects with zero false
positives on the clean fixture run. Polished output passes the reviewer's visual check.

---

### S6 — Auth, safety hardening, real-app acceptance

**Purpose.** Leave the fixture: log into real apps, survive real-world SPAs, and
prove the whole flow on one of your actual targets.

**Deliverables**
- `/demo login <app>`: headed browser → manual login → user confirms in pi → save storageState (`0600`) + a learned **login probe** (final URL pattern + landmark). Re-login flow on expiry (S3 hook).
- Hardening against real SPAs: shadow DOM, virtualized lists, sticky headers occluding targets (auto scroll offset), cookie banners (auto-dismiss rule per app), lazy charts (wait for paint), canvas/iframe regions flagged as "vision-only".
- Safety review: denylist tuned on real labels, `policy.json` documented, audit log visible in the panel and in `report.md`.
- Secrets hygiene: storageState never logged, never sent to models, never in panel payloads. Screenshots of login pages are excluded from discovery artifacts.
- README: setup, prerequisites, costs (ElevenLabs characters per minute of VO, model usage per phase), security notes.

**How to test**
- Manual acceptance on one real app (you choose): brief → approved storyboard → take → approved VO → ElevenLabs render → `out/`. Every artifact is reviewed in the panel.
- Expiry test: delete/expire a cookie → the take aborts cleanly → re-login → resume.
- Leak test: grep the whole project folder + bus logs for cookie values/tokens → none found.

**Exit criteria.** One real-app demo produced end to end with only panel approvals
and notes as human input. No secrets leak in artifacts or logs.

---

### S7 — Native OS-capture backend (optional, `--cursor=native`, macOS)

**Purpose.** A higher-fidelity mode for hero recordings: the real OS cursor and
real GPU rendering, behind a flag, reusing everything else.

**Deliverables**
- `capture/native-macos.ts`: headed Chrome window at a fixed position/size, real cursor driven via CGEvent (Swift/JXA helper) along the same ghost-cursor paths, capture via ScreenCaptureKit (or ffmpeg avfoundation), clock sync between capture and the event log (a flash-frame marker at take start).
- Same event log contract, so analysis, VO, edit and QA are unchanged.
- Doctor checks for Screen Recording / Accessibility permissions.

**How to test**
- The same fixture storyboard recorded in both modes: the S4 sync test passes in both, and the event-to-frame alignment error is ≤ 1 frame.
- Manual: native vs virtual cursor side by side.

**Exit criteria.** `--cursor=native` produces outputs that pass the same E2E and QA suite as the default backend.

---

## 7. Cross-cutting

- **Costs & budgets.** Config caps discovery (screens/actions/minutes), improvise calls per take, and TTS characters per project. The panel shows the running spend estimate. TTS is cached by hash, so re-renders after edit-only changes cost nothing.
- **Observability.** Every engine job writes `jobs/<id>.log`. The bus mirrors key events. `report.md` summarizes takes, retries, QA and spend.
- **Determinism.** The fixture is seeded. The engine never uses `Math.random` without a seeded RNG stored in the take (`take.json`), so a take's motion/typing can be replayed exactly.
- **Security.** The panel binds only to 127.0.0.1 and requires a per-session token (protects against CSRF from other local sites). API keys come from env/keychain only. The README calls out the destructive/egress capabilities: browser actions on real apps, external TTS/LLM calls with screen content.
- **Packaging.** Runtime deps (`playwright`, `@playwright-labs/ghost-cursor`, `ws`, `yaml`) go in `dependencies`. Pi core packages + `typebox` go in `peerDependencies: "*"`. The Chromium download is a doctor-guided step. ffmpeg and uv are documented system prerequisites.

## 8. Open questions (to resolve inside the slices)

| # | Question | Resolved in |
|---|---|---|
| Q1 | Capture resolution default (3200×1800 vs 2560×1440) | S1 spike |
| Q2 | Kokoro via Python (uv) vs `kokoro-js` in Node | S4 spike |
| Q3 | Zoom rendering: ffmpeg expressions vs Node frame compositing | S5 spike |
| Q4 | Default whisper model size (speed vs alignment accuracy) | S4 |
| Q5 | Improvise model default (latency budget ≤ cursor travel time) | S3 |
| Q6 | First real app for acceptance | before S6 |

## 9. Definition of done (v1 = S0–S6)

- `/demo new` → approved storyboard → take → approved VO → ElevenLabs voice → `out/scenes/*.mp4`, `out/full.mp4`, `full.callouts.srt`, `report.md`.
- Human input limited to: the brief, `/demo login` once per app, panel approvals/notes.
- Fixture E2E suite green. One real app accepted.
- README documents setup, costs, security, and the fallback behavior of the TTS chain.
