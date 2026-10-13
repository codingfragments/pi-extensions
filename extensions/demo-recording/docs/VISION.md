# demo-recording — Vision & Decision Record

> Status: **agreed** (grill session, initial). Changes to any decision below
> must be recorded here with a date and a one-line rationale.

## The vision in one paragraph

Give the extension a web app URL and some background. It explores the app
like a curious expert, finds the use cases worth showing, and writes a
storyboard that reacts to real screen content. That storyboard is reviewed
and approved in a local side-panel web app. It then records the demo as one
continuous, human-looking take (realistic cursor, realistic typing),
analyses the take, and writes a dense, opinionated, anchored voice-over.
After a second approval it synthesizes the voice (ElevenLabs custom voice
first, with fallbacks), edits the video to the narration (audio-led), and
exports per-scene videos plus one combined end-to-end video. Everything
lives in one working directory.

## Phases (user-facing)

| Phase | What happens | Human gate |
|---|---|---|
| **0. Brief** | Guided `/demo new` + free-form context + brief-drafting skill (web search only on request) → `brief.md` | brief reviewed (soft) |
| **1. Discover & storyboard** | Agent explores the app (vision-first, DOM-assisted), proposes scenes, order, steps, narration outline; live in panel | **storyboard approval** (hard gate before recording) |
| **2. Record** | One continuous take of the approved storyboard; `improvise` steps for live inputs; split into scenes later | take accepted (soft, QA flags) |
| **3. Analyse & voice-over** | Keyframes + event log + DOM values → cut list, zoom picks, anchored VO script | **VO script approval** (hard gate before TTS, costs money) |
| **4. Voice, edit, export** | TTS chain → alignment → audio-led edit → polish → QA → `out/` | final review (soft) |

## Decisions

| # | Area | Decision | Rationale |
|---|---|---|---|
| D1 | Recording engine | **Playwright + DOM-injected virtual cursor** for the MVP. Bezier/Fitts paths come from `@playwright-labs/ghost-cursor`, typing is human-like. An **OS-capture backend (`--cursor=native`, macOS) comes later** | Deterministic, cross-platform, all tooling in-repo. The native cursor is an optional upgrade, not a dependency |
| D2 | Capture | **CDP screencast** frames with timestamps → ffmpeg. Not Playwright `recordVideo` | `recordVideo` is low-bitrate VP8, so text comes out mushy. The screencast timestamps double as the clock for the event log |
| D3 | Run mode | **Headless recording by default**, `--headed` optional for discovery/debugging | The user keeps working while it records; the panel LIVE view shows progress |
| D4 | Perception | **Vision-first**: screenshots are the source of truth. **DOM harvest** is the precision layer for exact values in the VO | Human-like judgment of what is demo-worthy, with no misread numbers in the narration |
| D5 | Auth | **One-time manual login → storageState** (`0600`, per app). Expired sessions are detected and trigger a re-login prompt. Login never appears in demos | Robust against SSO/MFA, and no passwords are stored |
| D6 | Discovery safety | **Agent judgment**, backed by a hard keyword denylist, a live **mutation audit log** in the panel and an optional per-app `policy.json` override | User preference for speed. The safety net costs nothing in flow |
| D7 | Reactivity | **Deterministic storyboard + `improvise`-flagged steps** (search queries, chat messages, filter choices invented live from what's on screen). The **VO is written from the actual run** | Reproducible recordings. Reactivity lives where the app is nondeterministic, and in the narration |
| D8 | Takes | **One continuous take, split into scenes in the edit.** Scenes with a deep link can be re-shot alone. A failed take **resumes from the last good scene boundary** | Natural flow and continuity. Fragility is contained |
| D9 | Orchestration | **The pi session directs** (skill + tools), a **deterministic Node engine executes** (record, TTS, align, edit, render), **panel actions are injected into the session** as user messages | Reuses pi's agent loop and model choice. Mechanical work stays reproducible and costs no tokens |
| D10 | Side panel | Local web app: **LIVE / REVIEW / VOICE / EXPORT** views. Per-scene approve / request changes / re-run, notes per scene. No drag-and-drop or timeline editor in v1 | Keeps the panel from becoming the product |
| D11 | Sync | **Audio-led, event-anchored.** VO anchors (`[@results-visible]`) plus TTS word timestamps drive cuts, freezes and speed ramps | Narration lands on the exact moment; dead time disappears |
| D12 | TTS | **ElevenLabs (custom voice by name) → OpenAI `gpt-4o-mini-tts` → Kokoro (local)**. A universal whisper alignment covers engines without timestamps. **No engine mixing within one video.** Audio is cached by content hash | Best quality first. Cloud and offline fallbacks. Consistent timing data. **Update (S4):** the ElevenLabs default model is now `eleven_v4`, with `eleven_multilingual_v2` as a fallback when the timestamp endpoint rejects v4 for the account. Keys come from the environment only. |
| D13 | Analysis / QA | **Session model only**, within Anthropic / OpenAI. ElevenLabs is for TTS (and optionally alignment). No Gemini. Temporal QA is **deterministic**: ffmpeg freeze/silence/black detection, an in-page alert/toast/console observer, a check that quoted values exist in the DOM at their anchor time, and whisper drift scoring | Vendor limits. Deterministic checks are more reliable than sparse keyframes |
| D14 | Polish v1 | **Auto-zoom/pan only on events flagged in the storyboard. Captions = step callouts** (not the transcript). **Title card on the full video only.** Background music later | Restraint: zoom everywhere looks cheap, and callouts mark the important steps |
| D15 | Format | **1600×900 CSS viewport @ DPR 2** (3200×1800 capture) → **1920×1080 @ 30 fps H.264**. Configurable | Crisp text and ~1.6x zoom headroom |
| D16 | Workdir | **Configurable root (default `~/DemoRecordings`)**: `apps/<app>/` holds shared auth, policy and discovery cache; `projects/<project>/` holds everything per demo. Versioned and never overwritten | Re-use across demos of the same app, and full history |
| D17 | Brief | **Guided `brief.md` + free-form context**, plus a skill that drafts the brief from whatever is given (interactive, web search on request) and asks for what's missing | The brief drives audience, length and stance |
| D18 | VO persona | **Expert guide in first person.** The **stance** (champion / evaluator / teacher) and motivation are set in the brief. Dense (~150–165 wpm), no filler or marketing superlatives, one takeaway per scene, quotes real on-screen values | "Dense and opinionated" without losing credibility |
| D19 | Language | **English v1.** Language is a brief field, so multilingual later is a matter of config + prompts | `eleven_multilingual_v2` and whisper already support more |
| D20 | Test target | **Bundled fixture SPA** (seeded, static) with dashboard, search, streaming chat, deep links, a slow spinner and an error toast. The full pipeline runs end to end on it with offline TTS | Reproducible vertical-slice tests. Real apps are for acceptance only |
| D21 | QA gating (S5 grill) | **Hard/soft split.** *Blocking*, until fixed or explicitly confirmed: a narrated value not on the page, an error toast or console error in used footage, an anchor off-sync by more than 300 ms. *Warnings:* holds, silences, narrator pauses, filler words | Credibility killers block; cosmetic issues don't |
| D22 | Agent auto-fix | **Mechanical fixes only** (re-time or move anchors, alignment, holds, re-render), stored as **edit overrides** next to the timeline, so the approved script and audio stay untouched and nothing needs re-approval. Changes to content (narration text, values, re-takes, storyboard) are always asked first. Every auto-fix appears in the report | Speed without silently changing approved content |
| D23 | Confidence review | **Measured signals set the level** (high/medium/low with reasons). The model's 1–5 self-rating is shown separately as the "agent's view" and can only **lower** a level. The panel sorts lowest first and says "N items need your eyes". A bulk "approve high-confidence" button needs a click plus a confirmation listing what is skipped | Trust measurement, use the model for soft hints |
| D24 | Brands | **Brand packages:** a **neutral** brand ships in the extension. User brands live in `~/DemoRecordings/brands/<name>/` (nothing trademarked in the repo). They are built by the `demo-brand` skill (`/demo brand new`) from a zip or folder, with a guided prompt explaining what's needed, and previewed and tweaked in the panel's **Brand** tab. Switch with `/demo brand use` or in the panel. Config `brand` sets the default | Reusable branding (e.g. Datadog) without assets in the public repo |
| D25 | Frame and title | **Footage inset (~92 %) on a branded backdrop** with rounded corners and a shadow. The **title card** (app, demo title, date) dissolves (0.8 s) into the first frame under the intro narration. An optional **logo bug** is set per brand (off in neutral) | One coherent produced look |
| D26 | Overlays | **Callouts:** a fixed bottom-left branded pill over the footage, written by the director (`callout:` ≤ 60 chars) and **editable inline in Review**. Edits touch only the overlay and trigger a re-render, never a re-take. **Zoom:** 1.5× (max 1.8×), 0.6 s ease in, hold, 0.5 s out, at most 2 per demo (warning above). **Highlight** (user addition): an opt-in `highlight: true` step flag (the director decides, typically when a callout names an app region). It draws a subtle rounded outline in the brand accent around the step's target box (2 px, ~70 % opacity, faint glow, a few px of padding) that fades with the callout and follows the zoom. No fills, arrows or pulsing | Mark steps without covering the story |
| D27 | Subtitles and variants | Transcript **VTT sidecars always**. **Burned-in subtitles** are optional; when enabled, **every video exists in both versions**. The **Export tab** toggles callouts, subtitles and the logo bug. Renders are cached per variant, so a toggle renders only what's missing **Brand switch in Export** (user addition): the brand is part of the variant key. Switching it re-renders from the existing timeline + `raw.mp4` + voice audio, a pure engine job with **no LLM and no TTS**; only missing variants are rendered | Clean master plus social-ready variants |
| D28 | Out of v1 | Background music stays out. Cursor frame-locking only if unevenness is still noticed | Focus |

## Explicit non-goals for v1

- Timeline editor, drag-and-drop storyboard editing in the panel.
- Background music.
- Languages other than English (config-ready, not tested).
- Mobile/native apps; non-web targets.
- Gemini or any vendor beyond Anthropic, OpenAI, ElevenLabs.
- Remotion (license requires a paid company license above 3 employees).

## Known limitations (accepted)

- **Canvas/WebGL UIs and cross-origin iframes:** the DOM layer can't see inside them, so only vision works there and quoted values can't be guaranteed. These are flagged in QA.
- **Synthetic cursor:** cursor styles (pointer/text/default) are emulated from the computed `cursor` of the element under the point.
- **CDP screencast throughput at 3200×1800** is a risk. It gets a spike in S1, with 2560×1440 as the fallback.
- **Long continuous takes are fragile.** Resume-from-boundary contains the damage but doesn't eliminate it.
- **Discovery safety is heuristic.** The audit log reports after the fact. Sensitive tenants need `policy.json`.
- **Session expiry mid-take** aborts the take, triggers a re-login prompt, then resumes.
