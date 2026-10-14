# demo-recording — Implementation Plan

Companion to [VISION.md](VISION.md) (decisions D1–D43). This plan is built
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
│ STORYBOARD·RECORDING·VOICE·ANNOTATIONS·RENDER·CONFIG + LIVE side panel│
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
│   │   ├── cursor/motion.ts    arc + min-jerk trajectories → page.mouse + rAF overlay
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
      layout.jsonl                       (S5 part 6) visible-element snapshots, §3.7
      audit.jsonl  qa.json
    vo/script.v1.md …  audio/<engine>/<scene>.wav  alignment/<scene>.json
    edit/timeline.v1.json                (cutter output, part of the voice-over stage)
    annotations/v1.json …                (S5: §3.6)
    render/v1.json  v1.qa.json  v1.overrides.json   (S5: §3.8)
    inputs.jsonl                         (S5: project input log, §3.9)
    brief/v1.md …                        brief history
    out/edit-vN/<brand>/scenes/NN-<id>.mp4  full.mp4   (S5 part 2; legacy after part 9)
    out/render-vN/<variant>/…  full.callouts.srt  full.transcript.vtt  report.md
  brands/<name>/                         user brand packages (docs/BRANDS.md)
```

### 3.2 Storyboard (`storyboard/vN.yaml`)

```yaml
version: 2
app: acme-analytics
title: Find the churn problem in a minute     # optional, ≤ 60 chars (title card)
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
      - { do: hover, target: { text: EMEA }, dwell: 1.2s, emphasis: the EMEA outlier is the story }
      - { do: improvise, kind: type, target: { role: textbox, name: Ask a follow-up },
          prompt: ask a sharp follow-up based on the visible answer, max_chars: 80,
          submit: true, mark: followup-sent }
    end_assert: { text: EMEA }                # optional
```

Targets resolve in order: `role+name` (Playwright `getByRole`) → `text` → `label` → `css`.
`mark:` names the **anchor events** that the VO and annotations can reference.
`emphasis:` (per step or scene, free text) is the director's intent only; annotations
are chosen later, in the Annotations stage (D31/D32). Legacy `zoom: true` / `callout:`
still parse and become emphasis hints.

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
  {"scene":"03-search","src":[2000,5600],"speed":1.0},
  {"scene":"03-search","src":[9000,9400],"speed":1.0},
  {"scene":"03-search","freeze":{"at":9400,"dur":1100}}],
 "audio":[{"file":"audio/elevenlabs/03-search.wav","at":0}]}
```

The timeline is timing only: cuts, speed, holds, audio placement and anchors. Zooms,
callouts and other overlays live in the annotation version (§3.6); brand, title card
and variants are applied at render (§3.8).

### 3.6 Annotations (`annotations/vN.json`, S5 part 7/8)

```json
{"version":3,"basedOn":{"vo":4},"take":"take-007","by":"annotation-designer",
 "importedFrom":2,
 "budget":{"optimumNoise":8.0},
 "items":[
  {"id":"a1","type":"zoom","scene":"03-search","anchor":{"mark":"results-visible"},
   "target":{"layout":"t9420#e17","text":"EMEA 14.2%"},"durMs":null,
   "weight":{"value":5,"noise":1.5},"enabled":true,"origin":"suggested",
   "reason":"the narration's key number; small in the frame"},
  {"id":"a2","type":"callout","scene":"03-search","anchor":{"mark":"results-visible","offsetMs":0},
   "text":"EMEA: 14.2 % churn","durMs":2500,"weight":{"value":4,"noise":1.0},
   "enabled":true,"origin":"edited","edits":[{"at":"…","field":"text","from":"Regional outlier"}]},
  {"id":"a3","type":"redact","scene":"05-account","target":{"layout":"t21800#e4","text":"jane@…"},
   "weight":{"value":3,"noise":0},"enabled":false,"origin":"suggested","reason":"looks like an email"}
 ]}
```

- **`type`:** `zoom` | `callout` | `highlight` | `spotlight` | `redact` | `chapter`.
- **`anchor`:** a storyboard `mark`, a VO word (`{"word":"EMEA","section":"03-search"}`), or a scene start. It maps to output time through the timeline.
- **`target`:** a layout-snapshot element ref (`t<ms>#e<n>`) plus its text, or a step target. Missing for callouts and chapters.

**Weights (Q7, resolved):**
- **`value`** (1–5): from the designer, raised by +1 when the item matches an `emphasis` hint or a VO anchor/word, capped at 5.
- **`noise`:** deterministic, per type × duration:

  | Type | Base noise |
  |---|---|
  | callout | 1.0 |
  | highlight | 0.6 |
  | zoom | 1.5 |
  | spotlight | 2.0 |
  | chapter, redact | 0 (outside the budget) |

  Items longer than their type's default duration add `+0.5 × (extra seconds / default)`.
- **Recommended set:** greedy by `value / noise` (ties: higher value), respecting the caps (≤ 2 zooms, no two overlapping in time on the same region) and the 2× ratio (enable about half of the counted suggestions).
- **`optimumNoise`:** the noise of the recommended set.
- **Budget meter:**
  - "balanced" within ±25 % of the optimum, otherwise "too quiet" or "too busy";
  - plus "value captured" = enabled value / total suggested value.

**Versioning:** every save in the panel makes a new version; `origin` and `edits` keep what the user changed, which `import` re-applies.

### 3.7 Layout snapshots (`takes/take-NNN/layout.jsonl`, S5 part 6)

```json
{"t":9420,"reason":"settle","url":"/search?q=churn","scroll":{"x":0,"y":0},
 "els":[{"id":"e17","role":"cell","text":"EMEA 14.2%","box":{"x":412,"y":388,"w":120,"h":28}},
        {"id":"e18","role":"button","name":"Export","box":{"x":1400,"y":80,"w":96,"h":32}}]}
```

**Granularity (Q8, resolved):**
- **When:** a snapshot after each step settles (after its wait condition, or at the next frame-quiet moment, ≤ 1.5 s), at every `mark`, and on a route change once it settles. At most one per 500 ms.
- **Which elements:** those intersecting the viewport, and visible (not `display:none`, `visibility:hidden` or `opacity` < 0.1). Kept:
  - elements with their own text (≤ 200 chars, trimmed);
  - interactive roles (button, link, textbox, combobox, checkbox, tab, menuitem);
  - table cells and rows, headings;
  - images with alt text;
  - inputs (their *value* only when not `type=password` and not `autocomplete` credential fields).
- **Size:** at most 400 elements, the largest text boxes first, then interactive ones. Typical: 20–60 KB per snapshot, about 2–5 MB per take.
- **Boxes:** CSS px in the viewport (× dpr = source px), plus the scroll offset.
- **Relation to `dom/<mark>.yaml`:** the existing aria snapshots at marks stay (the VO value bindings use them). Layout snapshots add positions.

### 3.8 Render versions (`render/vN.json`, S5 part 9)

```json
{"version":2,"basedOn":{"annotations":3},"kind":"final","brand":"acme",
 "variants":{"subtitles":"burned+clean","callouts":true,"logoBug":true},
 "outputs":{"clean":"out/render-v2/acme/full.mp4","subtitled":"out/render-v2/acme+subs/full.mp4",
            "scenes":"out/render-v2/acme/scenes/","vtt":"out/render-v2/full.transcript.vtt"},
 "qa":{"file":"render/v2.qa.json","blocking":0,"warnings":3,"confirmed":[]},
 "rim":{"color":"#ffffff1f","reason":"auto: contrast 1.45 < 1.8"}}
```

### 3.9 Project input log (`inputs.jsonl`, S5 part 3)

```json
{"id":"in-0007","at":"2026-10-14T09:12:03Z","stage":"vo","version":4,"source":"panel",
 "kind":"nudge","text":"calmer, more evaluator, cut scene 2 by a third",
 "refs":["vo/script.v4.md"]}
{"id":"in-0008","at":"…","stage":"annotations","version":3,"source":"chat","kind":"direction",
 "text":"no zoom on the login screen","outdated":{"at":"…","reason":"login scene removed"}}
```

- **`source`:** `command` | `panel` | `chat` | `agent`.
- **`kind`:** `brief` | `direction` | `review` | `nudge` | `asset` | `source`.
- **Agent reads:** `demo_rec_project context` returns the entries that are not outdated, grouped by stage.
- **Panel reads:** Project context shows everything, with outdated entries struck through.

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
| `demo_rec_config` | any | show / set / unset settings, two-phase (diff first) — S5 ✅ |
| `demo_rec_brand` | render | list / show / inspect / create / update / duplicate / preview / use — S5 ✅ |
| `demo_rec_annotations` | annotations | `suggest` (background), `get`, `write`, `import from=vK`; never approves — S5 part 8 |
| `demo_rec_render` | render | `draft` / `final` (background), `status`; brand + variants — S5 part 9 |
| `demo_rec_project context` | any | the project's memory: brief, non-outdated inputs, lineage, stale flags — S5 part 3 |

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
| Human mouse paths | own cubic-arc + min-jerk trajectory (`cursor/motion.ts`) | ghost-cursor was tried in S3; its sparse point table produced visible corners. The visible cursor is our own overlay, animated on `requestAnimationFrame` |
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
| In-run `improvise` model | `anthropic/claude-haiku-4-5` → `openai/gpt-5.4-mini` via pi's model registry (`improvise.models`) | Benchmarked in S3. The call starts **before** the cursor travels to the input. If it is late, the cursor hesitates (≤ `hesitateMs`), then the step's `fallback` text is typed |
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

### S1 — Thin end-to-end: hard-coded storyboard → narrated MP4 *(the walking skeleton)* ✅ done

> Done: `cli.ts run-s1 --fixture` → approved storyboard version → headless take
> with visible virtual cursor (arrow/hand/I-beam, click ripple) → CDP
> screencast → exact CFR master (3200×1800) → `say` → 1080p30 MP4.
> Spike: [spikes/S1-capture.md](spikes/S1-capture.md) — **Q1 resolved: 3200×1800
> default** (57 fps during animation); fallback via `capture.maxWidth/maxHeight`.
> Findings that changed the design: headless needs `--force-device-scale-factor`
> for device-pixel frames; CFR mapping is now exact by construction (output
> frame k = latest source frame ≤ t0 + k/fps) after the concat demuxer added
> +0.43 s drift. Tests: units always; browser/ffmpeg integration when present;
> E2E with `DEMO_REC_E2E=1` (anchor check inside the event box: ±150 ms).

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

### S2 — Brief, discovery, storyboard, panel review loop *(Phase 0–1)* ✅ done

> Done: skills `demo-brief` + `demo-recording` (shipped in the extension);
> tools `demo_rec_project`, `demo_rec_browser` (open/look/act/close; look =
> screenshot + aria digest), `demo_rec_storyboard` (write/get — **no approve**),
> `demo_rec_record` (gate-enforced); `/demo new` → brief skill, `/demo discover`
> → director skill; safety net (denylist / audited state changes / policy.json,
> blocked *before* the click); per-app discovery artifacts; budgets; target lint;
> panel LIVE (current screen, budget, safety feed) and REVIEW (scene cards, per-
> scene approve/changes/re-run + notes, version diff, one consolidated message
> to the agent, approve); POST = Bearer + JSON only; token-scoped media.
> **Deviations:** the storyboard validator stays hand-written (path-precise
> errors the model can self-correct from) instead of typebox; `demo_rec_record`
> pulled forward from S3 (foreground, no narration) to close the loop in pi;
> discovery settle = DOM-quiet + busy-indicator detection (fixed screenshots
> taken before results/streamed answers landed). **Finding:** passing a string
> to `locator.evaluate` never receives the element — it silently produced empty
> names and let "Delete workspace" pass; caught by the discovery test, fixed by
> passing a real function and never failing open.

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

### S3 — Recorder quality: human cursor, typing, improvise, resume *(Phase 2)* ✅ done

> **Done:**
> - Human motion: seeded cubic-arc geometry (initially ghost-cursor, replaced after review — see below), Fitts duration, a min-jerk velocity profile, overshoot+correct on long moves, idle drift during dwell.
> - Typing: log-normal delays, word/punctuation pauses, optional typos.
> - Page observers: route, toast/alert with text and level, idle ranges from busy indicators, console/page errors.
> - `improvise` with hesitation and `fallback`.
> - Resume: failed attempts are cut at scene start and kept in `attempts.jsonl`. State is restored via `deep_link` or a fast off-camera replay, the browser is reopened after a crash, and segments are stitched with an exact master.
> - Background `demo_rec_record` (start/status/cancel), completion via `pi.sendMessage`, footer status.
> - **Progress bars** for recording (per-scene segments, restarts, ETA) and discovery (`plan` areas + budget).
> - **Catppuccin Macchiato/Latte** themes.
> - `cli.ts record`.
>
> **Q5 resolved:** `anthropic/claude-haiku-4-5` (text-only, ~0.84 s median) → `openai/gpt-5.4-mini` (minimal reasoning, ~1.05 s). Benchmark below.
>
> **Deferred:** session-expiry detection → S6 (needs the login probe); frame-retention policy → S4.
>
> **Cursor tuning (after user review: "a tiny bit jerky; mainly the jiggle when stationary"):**
> - ghost-cursor's sparse point table was replaced by a dense, gentle C-arc (both control points on one side).
> - Mouse events are sampled by real elapsed time.
> - The overlay plays the planned trajectory on `requestAnimationFrame` (the compositor clock) instead of following jittery CDP `mousemove` deliveries.
> - Moves are about 25 % slower (cap 1.6 s). Overshoot is rarer and smaller, with no pause before the correction.
> - Idle drift (`DRIFT` in `motion.ts`): still for dwells < 1.8 s; rests 0.9–1.6 s after landing; jiggles of ±2/±1.2 px taking 1.4–2.2 s, with 1.6–3 s gaps.
> - Measured direction change between 30 fps frames: median 19° → 3°, p90 53° → 8°. Guarded by a regression test.
>
> **Findings:**
> - Events must be discarded by log position, not time (the previous scene-end shares the failed scene-start's millisecond).
> - The panel lost its connection on reload (token stripped from the URL); the token is now kept in `sessionStorage`.
>
> | Model (median of 3, fixture screen) | Text only | + screenshot |
> |---|---|---|
> | anthropic/claude-haiku-4-5 | **836 ms** | 1066 ms |
> | openai/gpt-5.4-mini (minimal) | 1053 ms | 1925 ms |
> | openai/gpt-5.4-nano (minimal) | 1014 ms | 3923 ms |
> | openai/gpt-4.1-mini | 1298 ms | 2978 ms |
> | openai/gpt-4.1-nano | 1481 ms | 4616 ms |
> | anthropic/claude-haiku-5-5 | 2459 ms | 3229 ms |

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
- **Recording progress bar** (user request): overall bar plus per-scene segments in the panel LIVE view and a footer status in pi (`ctx.ui.setStatus`). Shows current scene/step ("scene 2/4 · step 3/6 · typing 'churn by region'"), elapsed time and ETA. Progress is computed from completed steps, weighted by expected step durations (dwell + Fitts move time + typing length), with waits counted as open-ended until satisfied. Retries and resume show as restarted segments.
- **Discovery progress estimate** (user request, applies to S2's discovery): discovery is agent-driven, so there is no fixed step list. The estimate combines two signals:
  - *Exploration plan:* after the first look, the director declares the areas it intends to explore (e.g. `demo_rec_browser` action `plan` with `areas: ["dashboard", "search", "assistant", "settings"]`), then marks each area done as it moves on. This gives "area 2/4 · search".
  - *Budget burn:* screens, actions and minutes used against `budgets.discovery*`. The largest fraction is the hard upper bound.
  - *ETA:* remaining areas × the average time per finished area, capped by the remaining minutes budget. Shown as "~6 min left (budget max 14 min)".
  - Shown in the panel LIVE view (bar with area segments, then a final "writing storyboard" segment) and in pi's footer status. If the director never declares a plan, only the budget bar is shown, labelled as an upper bound.

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

### S4 — Analysis, voice-over, TTS chain, alignment, audio-led edit *(Phase 3–4 core)* ✅ done

> **Done:**
> - **Take analysis** (`demo_rec_take`): motion map from frame differences, dead time vs **streaming content** (busy regions whose text grows aren't cut), page text at every mark, keyframes.
> - **Voice-over:** script format with `[@mark]` anchors, `{{dom:mark|regex}}` bindings and `_intro/_bridge:/_outro`; validation against the take; versioned store (`demo_rec_vo`, no approve); `demo-voiceover` skill.
> - **Panel Voice tab:** timing bars, inline edit → new version, per-section review, approval gate.
> - **Voice chain** (`demo_rec_tts`, background): ElevenLabs by name with `/with-timestamps`, default `eleven_v4` → `eleven_multilingual_v2` fallback → OpenAI → Kokoro → say. One engine per video: a failure mid-render restarts the voice-over with the next engine. Content-hash cache.
> - **Alignment:** char-level script↔transcript mapping, Whisper hallucination guards, onset refinement, anchor snapping.
> - **Sync solver** (pure, property-tested).
> - **Frame-exact renderer** (`demo_rec_edit`, background) → `out/edit-vN/{scenes/*.mp4, full.mp4, timeline.json}`.
> - **Carry-overs:** resume replay guard; frame pruning.
>
> **Results:** S4 E2E on the fixture, measured independently in the final mix: anchors at 0–5 ms (target ±150 ms), screen events on cue, 4.2 s of dead time cut.
>
> **Q2:** Kokoro via `uv` + `kokoro-onnx`: ~8 s first run (124 MB models), ~5× real time.
>
> **Q4:** `base.en` + onset refinement, ≤ 32 ms on ground-truth audio (raw Whisper ≤ 182 ms); `small.en` optional.
>
> **Findings:**
> - Whisper loops the prompt into trailing silence. Fixed with `condition_on_previous_text=False` + `hallucination_silence_threshold`, silent-word filtering, and earliest-match alignment.
> - Whisper glues pauses onto the previous **or** next word. Fixed by refinement searching from inside the previous word.
> - Number words ("Six" ↔ "6", "%" ↔ percent) are normalized on both sides.
> - `hasBinary` didn't detect `uv`.
> - ffmpeg 9 removed `-filter_complex_script` (use `-/filter_complex`).
> - When video can't shrink (typing, in-app video), the narrator **pauses** rather than drifting.
>
> **Open:** live ElevenLabs check with the user's key + voice (`DEMO_REC_ELEVENLABS_E2E=1`, below).

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

### S5 — Stages, control room, brands, annotations, QA, guided review *(D13, D14, D21–D43)*

**Purpose.** Take the output from *correct* to *produced*, and turn the panel into a control room that points the human at what actually needs their attention.
- **Stage chain:** a strict, versioned chain Storyboard → Recording → Voice over → Annotations → Render (D30, D33), with a project input log as the project's memory (D42).
- **Look:** a branded look (D24/D25).
- **Annotations:** zooms, callouts, highlights and more, chosen *after* the voice-over from what was recorded and said (D31–D37).
- **Render:** a render stage with drafts, variants and a QA gate (D38, D21/D22).
- **Config:** a Config UI for settings, brands and project context (D41–D43).
- **Review help:** confidence-guided review and voice direction (D23, D29).

**Parts and order.** Each part is one PR, with tests, and ends with something runnable.

| Part | Content | Status |
|---|---|---|
| 1 | Model and config guards, config skill, voice picker | ✅ #33 |
| 2 | Brands: package format, renderer, tool/skill/commands, Brand tab | ✅ #34, #37, #38 |
| — | Spike Q3: zoom rendering | ✅ #35 ([spike](spikes/S5-zoom.md)) |
| 3 | Stage model + project input log | ✅ |
| 4 | Control-room shell (stage tabs, Live side panel) | next |
| 5 | Config UI (Settings · Brands · Project context) | |
| 6 | Recording inputs (layout snapshots, settled boxes, `emphasis`) | |
| 7 | Annotation rendering (engine) | |
| 8 | Annotations stage (designer, tab, review, approve, import) | |
| 9 | Render stage (draft/final, render versions, variants, subtitles) | |
| 10 | Deterministic QA + mechanical auto-fix | |
| 11 | Confidence-guided review + voice direction | |
| 12 | Actor & dependency model document, per-role model config | |

**Why this order:**
- **3 first:** the chain and the input log are the backbone every later part writes into.
- **4 before 5–9:** the new tabs land in the new shell, not the old one.
- **6 before 7–8:** the renderer and the designer need positions for elements nobody clicked.
- **7 before 8:** the engine can be tested with hand-written annotation files, no LLM.
- **9–10 together** form the final export gate.
- **11 polishes** stable stages.
- **12 documents** the roles once they exist in code.

---

*1. Model and config guards* — ✅ done (#33)
- **Model warnings:**
  - a warning in the discovery and take-analysis results (and the panel) when the session model has **no image input**;
  - doctor checks that `improvise.models` are available.
- **Config skill** (`demo-config`, `demo_rec_config`, `/demo config`):
  - effective values with their source;
  - precedence: defaults < global < `projects/<p>/config.json` < env;
  - a diff before every write, keeping `_comment`, validated;
  - never touches API keys.
- **Voice list** (`demo_rec_tts voices`, `/demo voices`), plus the `/demo voiceover` and `/demo render` commands.

*2. Brands (D24, D25)* — ✅ done (#34, #37, #38). Full reference: [BRANDS.md](BRANDS.md).
- **Code:** `src/brand/{brand,assets,manage,rim}.ts`, `brands/neutral/`.
- **Agent and commands:** the `demo_rec_brand` tool, `/demo brand list|use|new|rerender`, and the `demo-brand` skill.
- **Panel Brand tab:**
  - preview of unsaved tweaks on a real keyframe;
  - diff-confirmed save, save as copy, set default;
  - re-render, with playable variants.
- **Renderer:**
  - inset footage with mask, shadow and an automatic rim;
  - title card with dissolve and opening-frame hold;
  - logo bug in the backdrop margin.
- **`renderVariant`** writes `out/edit-vN/<brand>/`.
- **Title text:** fallback chain (brief `Title:` → storyboard `title:` → short goal → project name), shown as one line when it would repeat the app name.

*3. Stage model + project input log (D30, D33, D42)*
- **Stages and versions:**
  - `storyboard` — `storyboard/vN.yaml`.
  - `recording` — `takes/take-NNN/`; the take number is the recording version.
  - `vo` — `vo/script.vN.md`, plus the generated voice and the cutter's `edit/timeline.vN.json`.
  - `annotations` — `annotations/vN.json`.
  - `render` — `render/vN.json` plus outputs.
- **Versioning:** every version records **`basedOn`** (exactly one parent version). Version numbers count up per stage and are not hierarchical.
- **`state.json` schema 2:** `approved.<stage>` for all five stages (recording = take number) plus `history`. The latest version, its `basedOn` and the stale flags are **computed from the artifacts** (`src/workdir/stages.ts`), never stored, so they can't drift from the files. Schema-1 files are migrated on first read (`acceptedTake` → `approved.recording`, off-chain approvals dropped, submitted reviews copied into the input log), with a backup kept as `state.v1.json`.
- **Cascade reset (D33).** A new approved upstream version clears the downstream approvals and marks the downstream drafts as *based on an outdated parent*. Nothing is deleted, old versions stay readable, and "import from vN" (annotations, part 8) reuses work. Enforced in the engine:
  - `demo_rec_record` needs an approved storyboard;
  - `demo_rec_tts` needs an approved VO whose `basedOn` take is the accepted recording;
  - annotation suggestions need generated voice + timeline;
  - a final render needs approved annotations.
- **Project input log** `inputs.jsonl` (D42): one line per directional input. The panel, the agent and the commands all write through one `recordInput()`. Recorded inputs:
  - the brief and its revisions (`brief/vN.md`);
  - `/demo new` / `/demo discover` notes;
  - review notes and "send review to agent" messages per stage and version;
  - voice-direction nudges (D29);
  - annotation reviews;
  - attached sources and assets (`context/`, brand material, web sources the brief skill used, with URL);
  - chat directions the director classifies as project-relevant ("make scene 2 calmer").

  Each entry: `{ id, at, stage, version?, source: command|panel|chat|agent, kind: brief|direction|review|nudge|asset|source, text, refs[], outdated?: { at, reason } }`.
- **Agent memory:**
  - `demo_rec_project context` returns the active project's brief, the non-outdated inputs (newest first, grouped by stage), the lineage, and open stale flags;
  - the `demo-recording` skill re-reads it on `/demo open` and after a session restart, so the agent's memory and the Project context view (part 5) always match;
  - "outdated" entries are skipped (D43).
- **Migration of existing projects** (keycraft):
  - storyboard v1–v2 (v2 approved);
  - takes 001–006 as recordings v1–v6, each `basedOn` its `take.json` storyboard version;
  - VO v1–v3 `basedOn` the take in each script;
  - timelines attached to their VO version;
  - existing `out/edit-vN/` kept as legacy outputs, listed under Render as "legacy".

  Review notes already in `state.json` are copied into `inputs.jsonl`.

*4. Control-room shell (D39)*
- **Tabs:** Storyboard · Recording · Voice over · Annotations · Render · Config.
- **Shared stage header:** version picker, "based on …", approved/stale badge, and a cascade notice ("approving this resets Annotations v3 and Render v2").
- **Recording tab (new):** takes per storyboard version, with accept / re-record, analysis status, and a keyframe strip. Live takes stream in the Live panel.
- **Live control-room panel:**
  - **Layout:** a right-side slide-out (~360 px), which becomes a bottom drawer below ~1100 px. Collapsible: the collapsed rail still shows the current stage, the activity or "waiting for you", and the progress bar.
  - **Contents:** always the log stream, plus a segmented progress bar and a frame preview (latest discovery/recording frame, render thumbnail) when the activity has them.
  - **Per stage:** each stage contributes its own components (e.g. the Recording stage shows scene segments and improvise events; Render shows per-variant progress) and can toggle them.
- **The old Live tab content** (discovery card, recording progress) moves into the Live panel. Review and Voice become the Storyboard and Voice over tabs, unchanged inside. The Brand tab moves to Config (part 5).

*5. Config UI (D41–D43)*
- **Settings:**
  - every setting from `CONFIG_DOCS`, grouped, showing the effective value, its source (default / global / project / env), the docs, and whether it's shadowed;
  - edited through a validated form, always diff-confirmed, with global or project scope;
  - the raw global and project files are shown **read-only** beside it, with "open in editor" and "reload";
  - API keys: only "set / not set" plus the env-var name, never shown or written.
- **Brands:** the current Brand tab, moved in.
- **Project context**, the "memory" of the selected project:
  - **Brief:** current text, version history (`brief/vN.md`) and a diff to the previous version; editable as today.
  - **Inputs:** the input log, filterable by stage, kind and source, newest first. Each entry links to the version it produced. **Mark outdated / restore** with a reason (D43): never deleted, struck through, and skipped by the agent.
  - **Sources and assets:** `context/` files, web sources with URLs, brand material, uploaded files.
  - **Discovery:** sessions, sitemap, screens and the audit log.
  - **Lineage:** the stage chain with approved, latest and stale versions, and what a re-approval would reset.
- **Routes:** `GET /api/config`, `POST /api/config-set {key, value, scope, confirm?}` (two-phase, as `demo_rec_config`), `GET /api/context`, `POST /api/input-mark {id, outdated, reason}`.

*6. Recording inputs (D32, D34)*
- **Layout snapshots** `takes/take-NNN/layout.jsonl` (Q8): positions of visible elements, so annotations can target anything on screen.
- **Settled target boxes:** each step's target box is logged again once the page has settled after the step (`box` at the action, `boxSettled` after). This fixes highlights on elements that move just after an action.
- **Storyboard changes:**
  - optional top-level `title` (≤ 60 chars, done);
  - per-scene and per-step **`emphasis:`** free text (the director's intent, D32);
  - legacy `zoom: true` / `callout:` still parse and are converted into emphasis hints ("suggest a zoom here" / suggested callout text), with a deprecation note.
- **Skill updates:**
  - `demo-recording` writes `emphasis`, not annotation decisions;
  - `demo-voiceover` keeps `[@mark]` anchors (annotations use them for timing).
- **Re-record keycraft** after this part, so it gets layout snapshots.

*7. Annotation rendering (engine; D26, D35; spike Q3)*
- **Input:** `annotations/vN.json` (data contract in §3.6), mapped through the timeline: take time → output time per scene and for the full video.
- **Annotation types, in render order (see the [spike](spikes/S5-zoom.md)):**
  - **Redact / blur:** strong box blur of the element's box (page space, before the zoom), for every frame where the element is visible (from layout snapshots).
  - **Highlight:** rounded outline in the brand accent, 2 px at 1080p (≈ 3.6 px at source), ~70 % opacity, faint glow, ~6 px padding. Drawn in page space before the zoom, so it follows it. Fades with its callout or ~2 s. Skipped when the box is larger than 60 % of the frame.
  - **Zoom:** `perspective` (cubic, `eval=frame`, `(in-1)/fps`) at source resolution, only inside its window (`enable`).
    - 1.5× (max 1.8×), 0.6 s ease in so it is fully in **at the event**, hold until the next page change, the next zoom or the scene end, then 0.5 s out;
    - at most 2 per demo;
    - scenes with a zoom or page-space overlay keep source resolution until after the zoom; others keep the early scale.
  - **Spotlight:** dims everything except the box (rounded cut-out, ~55 % dark), 0.3 s in/out. Page space, before the zoom.
  - **Callout:** fixed bottom-left branded pill (`colors.pill`/`pillText`, ≤ 60 chars), fades in 150 ms before the event, ~2.5 s or until the next callout. Screen space, after the inset.
  - **Chapter title:** lower-third at a scene start ("2 · Find at-risk accounts"), 2.5 s. Full video only by default. Screen space.
- **Overlay rendering:** all overlays are HTML → transparent PNGs via Playwright (cached by content hash), animated with ffmpeg `fade`/`overlay` `enable` windows. Page-space overlays are positioned at source coordinates.
- **Previews:**
  - `previewStill(annotation)`: the keyframe at the event, with the overlay composited. Instant; cached.
  - `previewClip(annotation)`: a 3–5 s 960×540 clip around the event, rendered in a few seconds; cached per annotation hash.
- **Sidecars:** `full.callouts.srt` (callouts) and VTT transcripts (part 9).
- **Testable without an LLM:** hand-written annotation files on the fixture take.

*8. Annotations stage (D31, D35–D37)*
- **Annotation designer** (`annotation-designer` skill, played by the Director by default; D40).
  - **Inputs:** the accepted take (keyframes, layout snapshots, events), the storyboard's `emphasis` hints, the generated voice-over (script, anchors, word timings), the brief, and the input log.
  - **Suggests about 2× as many annotations as it enables**, each with:
    - type, scene, anchor (`mark` or word);
    - target (element ref from a layout snapshot, or a step target);
    - text (callouts, chapters), and a one-line reason;
    - weights (Q7).
  - **Pre-enables** the recommended set: the best value per noise within the caps.
  - **Defaults:** spotlight is off unless the value is 5; chapter titles and redactions are off and outside the budget.
  - **The **Privacy officer** role** (part of the same skill run by default) scans layout snapshots for emails, person names, tokens and IDs, and adds redaction suggestions with the reason "looks like an email".
  - **Writing rules** in the skill: a callout names *what* to look at, the voice says *why*, and never word for word; no annotation during typing; nothing on top of a callout; don't stack zooms.
- **Tool `demo_rec_annotations`:**
  - `suggest` (background; writes `annotations/vN.json`, `basedOn` the VO version);
  - `get` and `write` (agent revisions);
  - `import from=vK`, which re-applies the user's manual decisions (toggles, text edits, nudges) where the target and anchor still match, and lists the ones that couldn't be carried over;
  - `approve` is refused, because only the user approves (as with the storyboard).
- **Auto-start:** when voice generation + timeline finish, the Director hands over to the designer automatically, and v1 appears in the tab.
- **Annotations tab:**
  - one card per suggestion, grouped by scene: type icon, text, reason, weights, a still preview, and "play clip";
  - **filters** by type and by enabled/suggested;
  - a **budget meter** ("noise 7.5 / optimum 8 — balanced"; value captured %);
  - on/off toggles, inline text edit (callout and chapter), ±0.5 s start and duration nudges, a choice between zoom-target candidates;
  - every save is a new version (like VO inline edits), and the edit is logged as an input;
  - "Play scene with enabled annotations" (draft clip);
  - "Send review to agent" with notes, and **Approve**.
- **Panel routes:** `GET /api/annotations?version=`, `POST /api/annotations-edit` (toggle, text, nudge, target), `POST /api/annotation-preview {id, kind: still|clip}`, `POST /api/review*`, `POST /api/approve {artifact: "annotations"}`.

*9. Render stage (D27, D38)*
- **Render versions** `render/vN.json`: `{ basedOn: { annotations: N }, kind: draft|final, brand, variants: { subtitles, callouts, logoBug }, outputs, qa }`.
- **Draft vs final:**
  - **Draft** works from any annotation version (watermarked "DRAFT", 960×540, fast preset), for a look at the whole thing.
  - **Final** needs approved annotations and a passing QA gate (part 10), or explicit per-item "confirm & export anyway".
- **Variants:**
  - the brand dropdown per render (brands are presentation only and never touch approvals);
  - subtitles: VTT sidecars always (full and per scene, from word timings); burned-in optional, and when enabled every video exists in both versions;
  - toggles for callouts and the logo bug;
  - variant cache key = timeline + annotations + brand + variant options; only missing variants render.
- **Render tab:**
  - players with transcript track, downloads, and "open folder";
  - toggles and the brand dropdown;
  - the QA report with jump-to-time (part 10);
  - the render history (draft/final, brand, `basedOn`).
- **Panel route:** `POST /api/render {kind, brand, variants}`, a background engine job with no agent turn, no LLM and no TTS.
- **`demo_rec_render`** tool and `/demo render`. The current `demo_rec_edit` keeps working as "voice + timeline + draft".

*10. Deterministic QA (D13, D21) and mechanical auto-fix (D22)* — the **QA reviewer** role (D40), reports only.
- **Checks:**
  - `qa/media.ts`: ffmpeg `freezedetect`, `silencedetect`, `blackdetect`.
  - `qa/values.ts`: every number or name in the final narration must exist in the page text at its anchor (or the nearest snapshot in the scene).
  - Alerts and console errors in **used** footage.
  - `qa/drift.ts`: Whisper on the rendered audio vs the timeline, per anchor.
  - **Annotation checks (new):** a target missing from its snapshot, overlapping annotations, zoom headroom, a callout over a burned-in subtitle, a redaction that doesn't cover its element through the window.
- **Blocking:** value mismatch, error toast or console error in used footage, anchor drift above 300 ms, a redaction gap. **Warnings:** holds, silences, narrator pauses, filler, annotation overlaps. Output goes to `render/vN.qa.json`, `report.md` and panel flags.
- **The Director runs the final gate** (D40); blocking items need a user "confirm & export anyway" per item.
- **Auto-fix (mechanical only):** anchor re-time or move, alignment re-run, hold handling, re-render.
  - Stored as `render/vN.overrides.json`; the approved script, audio and annotations stay untouched.
  - Every fix is listed in the report.
  - Content changes (narration, values, re-takes, storyboard, annotation choices) are always asked.

*11. Confidence-guided review (D23) and voice direction (D29)*
- **Confidence:**
  - measured signals → a high/medium/low level with reasons, per storyboard scene, VO section and annotation;
  - the agent's 1–5 view can only lower the level;
  - panel badges, "N items need your eyes", lowest-first sorting, jump links, and a guarded "approve high-confidence";
  - review messages and tool results list low-confidence items first.
- **Voice direction:**
  - the Voice over tab gets a Direction panel: stance, tone and length presets, a focus field, free text;
  - "Draft new version" → the agent rewrites the whole script as vN+1 from the same take → word-level diff → approve → "Generate voice" (cost estimate first, only changed sections synthesized);
  - every direction is an input-log entry (`kind: nudge`), shown in Project context;
  - optional "save as default direction" into the brief.

*12. Actor & dependency model document (D40)*
- **`docs/ACTORS.md`** (see the cross-cutting entry): the vision behind the cast, each actor (responsibility, inputs, outputs, decisions, model profile, failure modes), the dependency model, handoffs, and the background decisions with the alternatives that were rejected.
- **Per-role model config:** `roles.<role>.model` (default: the session model via its skill; opt-in separate runs, e.g. `roles.qa.mode: "separate"` with a fresh context, `roles.operator` = the improvise chain). Doctor checks each configured role's model capabilities (image input, context size).

**How to test** (per part; each PR carries its own tests)
- **Part 3:**
  - state migration on a copy of a keycraft-like fixture project (schema 1 → 2, backup kept, lineage correct);
  - cascade reset clears exactly the downstream approvals;
  - the gates refuse out-of-chain work;
  - `recordInput` from every source; `context` excludes outdated entries;
  - a property test: no sequence of approvals leaves a downstream approval whose parent isn't the approved upstream version.
- **Part 4:**
  - panel smoke tests for every tab and the collapsible Live panel in both layouts (Playwright screenshots at 1400 px and 900 px);
  - the stage header shows the cascade notice.
- **Part 5:**
  - config form round-trip (diff, confirm, validation, shadowing, no secrets);
  - raw files read-only;
  - the Project context route lists brief versions, inputs (filters, mark outdated/restore), sources, discovery and lineage;
  - mark outdated changes what `demo_rec_project context` returns.
- **Part 6:**
  - layout snapshots on the fixture: element count cap, hidden and password fields excluded, numbers present, boxes match `getBoundingClientRect` within 1 px;
  - `boxSettled` differs from `box` on an element that animates after the click;
  - `emphasis` parse and legacy conversion.
- **Part 7:**
  - each annotation type rendered from a hand-written file on the fixture take, checked by pixel probes: blur variance inside the box, outline pixels around it, zoom scale at the hold, spotlight darkening outside, pill at the bottom left;
  - timing: overlays visible within ±1 frame of the window;
  - render order: highlight follows the zoom;
  - preview still/clip caching.
- **Part 8:**
  - designer output schema and caps (≤ 2 zooms, 2× ratio, defaults per type, privacy suggestions on fixture PII);
  - import from vK (carried, dropped with reasons);
  - the edits route makes new versions;
  - approval gate;
  - E2E with a stub model that returns a fixed suggestion set.
- **Part 9:**
  - draft renders from unapproved annotations; final refuses until approved and QA passes;
  - variant cache (only missing variants render);
  - VTT matches the word timings;
  - a brand switch makes no model call (stub registry that fails on use).
- **Part 10:** the injected fixture defects (`?flaky=1` alert, a wrong value in the VO, an uncut spinner, a redaction gap) are all caught; zero blocking items on the clean run; overrides leave the approved hashes unchanged.
- **Part 11:** confidence signals on injected defects; the agent's view never raises a level; the direction message contains every preset + free text; the cost estimate counts only cache misses.
- **Visual (manual, keycraft re-recorded after part 6):** annotations suggested → toggled → approved → final render with the neutral brand and one user brand, 2 zooms, callouts, a highlight, and a redaction on a fake email.

**Exit criteria.**
- The stage chain holds: every output traces back through `basedOn` to an approved storyboard, and any upstream re-approval resets downstream approvals.
- The Project context view and `demo_rec_project context` show the same memory, and outdated inputs are skipped by both.
- On keycraft (re-recorded), the designer's suggestions arrive automatically after the voice. A user toggles and approves them, and a final render with annotations passes QA.
- QA catches every injected fixture defect, with zero blocking items on the clean run.
- Config changes go through form → diff → confirm → validation, from the panel and from chat.

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
- `capture/native-macos.ts`: headed Chrome window at a fixed position/size, real cursor driven via CGEvent (Swift/JXA helper) along the same planned trajectories, capture via ScreenCaptureKit (or ffmpeg avfoundation), clock sync between capture and the event log (a flash-frame marker at take start).
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
- **Confidence-guided review** (user request, lands in S5 alongside QA): every storyboard scene and voice-over section carries a **confidence score with reasons**, and the panel steers attention to the weakest items first.
  - **Two sources, kept separate and labelled:**
    1. **Measured signals** (deterministic, trusted).
       - *Storyboard:* targets never seen or verified during discovery; selectors that are css-only; scenes without `deep_link` that are unsafe to resume; dwell or footage versus takeaway length; steps relying on `improvise` without `fallback`.
       - *Take:* error toasts, resumes or stitches, improvise fallbacks used, missed waits, long dead time.
       - *Voice-over:* speech/footage ratio, anchors off-sync after the edit (drift, narrator pauses), literal values not found in the page text (QA value check), filler words, unresolved or ambiguous bindings, Whisper/alignment uncertainty (low word coverage, interpolated anchors).
    2. **Model self-assessment** (advisory). When writing, the director rates each scene or section 1–5 on claim strength, evidence on screen and narrative fit, with a one-line "why". It's stored with the version and never used to auto-approve.
  - **Panel:**
    - per-card badge (high / medium / low) with an expandable reason list;
    - sort/filter "lowest confidence first";
    - a summary line, e.g. "3 items need your eyes";
    - jump links to the exact step, anchor or keyframe;
    - optional "approve all high-confidence" that still requires a click.
  - **Agent:** the review message and `demo_rec_*` get results list the low-confidence items first, so revisions target them.
  - **Tests:** each signal is unit-tested on fixtures with injected defects (unseen target, wrong value, off-sync anchor, fallback used); the panel ordering is tested. Self-assessment never changes a gate.
- **Config skill** (user request, lands in S5): a `demo-config` skill plus a `demo_rec_config` tool and `/demo config` command to view, explain, change and validate settings conversationally.
  - **Show:** the effective value per setting and where it comes from (default / `~/.config/demo-recording/config.json` / env / the project brief).
  - **Change:** writes to the config file and preserves the `_comment` block and formatting. Every write is validated with the same resolver, and invalid values are rejected with the exact field. Optionally scoped to the active project via the brief or `projects/<p>/config.json`.
  - **Select:** guided choices for the common decisions:
    - **voice:** `demo_rec_tts voices` lists every ElevenLabs voice with name, id and category; pick one, then a free `check`;
    - TTS chain order;
    - improvise models (from pi's available models);
    - capture resolution (3200×1800 vs 2560×1440);
    - Whisper model;
    - discovery budgets.
  - **Never** reads, writes or prints API keys (environment only). It can tell the user which env var to export, and that pi must be restarted for it to take effect.
- **Panel theme** (user request): [Catppuccin](https://catppuccin.com/palette) **Macchiato** (dark, default) and **Latte** (light), switchable from a toggle in the panel header. The choice is stored in `localStorage` and defaults to Macchiato regardless of the OS setting. The panel CSS already uses custom properties (`--bg`, `--card`, `--text`, `--accent`, `--ok`, `--warn`, `--err`, …), so this means two `[data-theme]` variable sets mapped to Catppuccin colors (base/mantle/surface0/text/subtext0/blue/green/yellow/red), plus status colors checked for contrast in both flavors. Scope: panel only; the fixture app and rendered videos are unaffected. Lands with the next panel-heavy slice (S3 progress bars).
- **Actor & dependency model document** (user request, *for a later stage*): a dedicated design doc (planned as `docs/ACTORS.md`) that describes in detail:
  - **the vision behind the cast** (D40): why work is split into roles, what each role optimizes for, and how this mirrors a real production crew (director, researcher, writer, operator, cutter, designer, QA, privacy);
  - **each actor:** responsibility, inputs, outputs and artifacts, the stage(s) it acts in, its tools, the decisions it may take alone vs. needs the Director or the user for, its model profile (default skill on the session model vs. opt-in separate run, required capabilities such as image input or context size), and its failure modes;
  - **the dependency model** (D30/D33): the stage chain with its parent links, global per-stage version counters, approval gates, cascade reset, "import from vN", and which artifact each stage reads from which upstream version;
  - **handoffs:** what the Director passes to each role and gets back, what is persisted vs. kept in context, and how roles report to the panel (Live control room, D39);
  - **background decisions:** the alternatives considered in the grills (independent stages, full version tree, carry-over vs. reset, every-actor-separate vs. personas), and why they were rejected.
- **Packaging.** Runtime deps (`playwright`, `ws`, `yaml`) go in `dependencies`. Pi core packages + `typebox` go in `peerDependencies: "*"`. The Chromium download is a doctor-guided step. ffmpeg and uv are documented system prerequisites.

## 8. Open questions (to resolve inside the slices)

| # | Question | Resolved in |
|---|---|---|
| Q1 | ~~Capture resolution default (3200×1800 vs 2560×1440)~~ → **3200×1800**, see spikes/S1-capture.md | S1 spike ✅ |
| Q2 | ~~Kokoro via Python (uv) vs `kokoro-js` in Node~~ → **uv + kokoro-onnx** (no Node deps; ~5× real time) | S4 ✅ |
| Q3 | ~~Zoom rendering: ffmpeg expressions vs Node frame compositing~~ → resolved: ffmpeg `perspective` at source res inside zoom windows ([spike](spikes/S5-zoom.md)) | S5 spike ✅ |
| Q4 | ~~Default whisper model size~~ → **base.en + onset refinement** (≤ 32 ms) | S4 ✅ |
| Q5 | ~~Improvise model default~~ → **claude-haiku-4-5 → gpt-5.4-mini**, text-only by default | S3 ✅ |
| Q6 | First real app for acceptance | before S6 |
| Q7 | ~~Annotation weights and target optimum~~ → designer value 1–5 (+1 for emphasis/VO match), deterministic noise per type × duration, greedy recommended set under caps, optimum = its noise, ±25 % = balanced (§3.6) | S5 plan ✅ |
| Q8 | ~~Layout snapshot granularity~~ → after each settle, at marks and route changes (≤ 1/500 ms), visible elements only, ≤ 400 per snapshot, no password values (§3.7) | S5 plan ✅ |

## 9. Definition of done (v1 = S0–S6)

- `/demo new` → approved storyboard → accepted recording → approved VO → ElevenLabs voice → approved annotations → final render (QA passed): `out/render-vN/<variant>/scenes/*.mp4`, `full.mp4`, `full.transcript.vtt`, `full.callouts.srt`, `report.md`, each traceable through `basedOn` to the approved storyboard.
- The project's memory (brief, inputs, sources, lineage) is visible in Config → Project context and matches what the agent reads.
- Human input limited to: the brief, `/demo login` once per app, panel approvals/notes.
- Fixture E2E suite green. One real app accepted.
- README documents setup, costs, security, and the fallback behavior of the TTS chain.
