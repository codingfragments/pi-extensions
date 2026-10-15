# Control room UX specification

> **Draft for review — 2026-10-15.** The design choices below were selected in
> the UX grill; writing this spec was authorised. **Implementation is not yet
> authorised.** The detailed contracts, starting token scales and slice plan
> are proposals for that review, not claims about the current UI.
>
> Scope: S5 UX pass, between part 13 and part 14. Decisions **D98–D115** in
> [VISION.md](VISION.md); delivery tracking in
> [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## 1. Story and agreed direction

**Review what the agent produced, steer the next step, and always know what is running.**

Within a glance, a person should know where they are, which version they are
viewing, what needs their attention, what happens next and what is running.
The panel remains a **stage workspace**, not a task inbox, a new dashboard
layer or a timeline editor.

| Choice | Agreed direction |
|---|---|
| Primary organisation | Freely navigable production stages, with a next-action summary; no automatic tab changes when results arrive |
| Versions | Compact version/source/status summary plus History; browsing is separate from changing production inputs |
| Project map | A **connected dependency graph**, grouped by stage, in a large overlay; not a nested tree as the primary visualisation |
| Graph exploration | All paths / Approved paths / Production line; expand/collapse, search/filter, focus, quick navigation; retain dim dependency context |
| Activity | Persistent compact status strip plus an on-demand drawer; no reserved idle column or automatic expansion |
| Review | List/table plus one detail inspector; stage-specific previews and controls |
| Approval | **Approve & use** as the main action; **Approve only** as an alternative |
| Visual direction | Calm workbench: restrained, Primer-like hierarchy using Catppuccin, without adopting a new UI framework |
| Config search | One result per setting, both scopes and effective source visible; explicit edit target |
| Artifact editing | Autosaved working drafts; explicit immutable version creation; approval remains explicit |
| Width and density | Fluid workspace, capped prose widths, one comfortable density; no density toggle |
| Project first-run | Brief summary and missing essentials, not a mandatory wizard or wall of empty fields |
| Visual proof | A **style tile and component showcase** (UX0) approved before UX1 implements it |
| Location | **Hash routes**: stage, item and map focus are in the URL; deep-linkable, back/forward work |
| Graph engine | Own SVG, stage-column layout, no graph library; drafts grouped by default |
| Migration | Token layer first, legacy names aliased, a **ratchet test**, legacy CSS deleted at UX9 |

Keep the current capabilities and safety gates. The map is an explorer, not a
pipeline editor. No new framework, real-model test calls, generic filesystem
browser, global command palette, spend ledger or budget caps in this pass.

## 2. Frame, navigation and activity

Project is the briefing/context destination. Storyboard → Recording → Voice
over → Annotations → Render remain the production stages. Map and Config are
utilities, not extra production steps. Both themes remain available.

**Wide layout, illustrated at 1400 px:**

```text
Keycraft                  Project             [Map] [Config] [Theme]
Storyboard ✓ → Recording ✓ → Voice ● → Annotations ○ → Render ○

NEEDS YOU  Review narration                         [Continue review]
────────────────────────────────────────────────────────────────────
Voice over                                               [History]
Viewing v3 · Draft · Based on recording 6
In production line: v2 — you are reviewing a new draft

┌ Sections ────────────────┬ Search results ─────────────────────────┐
│ ✓ Introduction          │ [Footage / keyframe]                    │
│ ! Search results     ◀  │                                        │
│ · Compare results       │ Narration, details and review controls │
└─────────────────────────┴────────────────────────────────────────┘
────────────────────────────────────────────────────────────────────
● Rendering draft · 3 of 6 scenes                       [Activity ↑]
```

**Narrow layout, illustrated at 900 px:**

```text
Keycraft                          [Project] [Map] [Config]
[Accessible stage navigation — current stage remains visible]
Needs you: review narration                     [Continue]
──────────────────────────────────────────────────────────
Voice v3 · Draft · Recording 6                  [History]
In production line: v2
[Sections: Search results ▾]
[Footage / editor]
[Review controls]
──────────────────────────────────────────────────────────
● Rendering draft · 3 of 6 scenes              [Activity ↑]
```

These are structural sketches, not pixel designs or real project values.
A secondary pane collapses when useful minimum widths no longer fit; 900 px
is a validation viewport, not a requirement to hard-code that breakpoint.

### Frame contract

- Separate **viewed stage**, **production-line state**, **review status** and
  **job status**. A selected tab is not necessarily the next production step.
- Show complete, needs review, blocked, running and not-started states with
  text/icons as well as colour. Approval on an unrelated branch does not make
  the current production stage complete.
- New artifacts update badges and offer an explicit destination; they do not
  switch tabs, replace the selected item, take focus or overwrite edits.
- Proposed return behaviour: restore the last stage/version per project. New
  projects start at Project. If a remembered item is unavailable, explain the
  fallback rather than silently substituting a different version.
- Keep the next-action summary short. Distinguish a blocking problem from an
  ordinary review request; offer a route to other pending items without
  turning the summary into an inbox.
- Derive running status from actual job/activity state. “Waiting for the
  Director” is **not** evidence that a model is currently running.

### Activity contract

The strip exposes running jobs, progress when known, failures and connection
state. Multiple jobs get a count and a route to their details. Idle takes one
short line. No invented percentages for work whose progress is unknown.

The drawer overlays the workspace, never squeezes it, and opens only on user
request. It contains job progress, live preview when available and logs;
existing full-log, event inspection, filtering and Copy remain accessible.
Failures stay discoverable after a toast is dismissed. No automatic drawer
opening, even on error; actionable failures are visible in the strip/summary.

## 3. Versions, approval and vocabulary

History lists versions, their source, approval, production selection and any
availability/dependency problem. It can open the map focused on an item.
Viewing a row changes only the view. The normal header always names the
viewed version and its source; viewing outside the production line adds an
explicit difference notice.

| Intent | UI language and consequence |
|---|---|
| Inspect an individual item | **Mark reviewed / Needs changes**; does not approve its containing version |
| Approve and select a version | **Approve & use vN**; approve it and explicitly make it part of the production line |
| Approve without selecting | **Approve only**; preserve a usable alternative without changing the line or starting work on it |
| Select an already approved version | **Use for next steps**; show the resulting line and downstream selection changes |
| Undo version approval | **Withdraw approval**; list affected descendants; preserve records and existing approvals elsewhere |
| Saved usable version | **Approved** (not a mixture of accepted and approved) |
| Working selection | **Production line / In production line** |
| Accepted item with an unusable ancestor | **Blocked by dependency**, with the ancestor named; its approval is not silently removed |
| Uncommitted edits | **Working draft**, with saving state; not a numbered version |
| Immutable, not-yet-approved artifact | **Draft version**, with its version number |
| Render appearance/output combination | **Variant** (not flavor) |
| Output kind | **Draft render / Final render**; keep QA and approval status separate |

**Action contracts proposed for implementation:**

1. Preview any line change, including ancestors and downstream selections.
   Approval never deletes prior work. Only valid, usable versions can be used.
2. Approve & use must have one coherent result; do not implement it as two
   independent browser requests with an intermediate Director notification.
   Validate before mutation, then notify from the final state. If state changed
   since the preview, reject/recompute rather than applying a stale plan.
3. Approve only must not inherit today's conditional selection side effect.
   Use a quiet notification rather than triggering production for the approved
   alternative. Audit existing panel/tool callers before changing shared logic.
4. Final approval retains the existing QA gate. At the terminal stage the
   primary action may say **Approve final**, with the selection consequence
   stated. No new final-export bypass is introduced.
5. Part 13's estimates, cost hints and confirmation policies remain. No graph,
   browsing, draft-save or search operation starts a model call or paid job.
   Do not add a routine extra cost dialog to ordinary agent-turn buttons.
6. Existing confidence rules and bulk-review confirmation remain; relabeling
   per-item approval does not silently mark previously unreviewed items.

Storage/API terms need not be renamed just to change UI vocabulary. Update
skills and docs alongside the relevant behaviour, without rewriting history.

## 4. Project map: a graph, not a file tree

Open a **large map overlay** from the global Map control or History. The stage
workspace remains behind it. Closing restores its selection, scroll and focus;
**Open in stage** closes the overlay and navigates to the exact selected item.
Focusing a graph branch never selects a new production line.

```text
┌ PROJECT MAP ───────────────────────────────────────────────── [×] ┐
│ [All paths] [Approved paths] [Production line]                     │
│ [Search…] [Filters] [Fit view] [Collapse groups]                    │
│                                                                  │
│ Storyboard    Recording    Voice       Annotations      Render    │
│ [v2]─────────[6]───────────[v3]─────────[v4]────────────[v8]        │
│   └──────────[5]───────────[v2]─────────[v3]────────────[v7]        │
│                └──────────[v1]                                    │
│                                                                  │
│ Selected: Voice v3 · Draft · Based on recording 6                  │
│ [Focus connections] [Expand artifacts] [Open in Voice]             │
└──────────────────────────────────────────────────────────────────┘
```

### Agreed graph behaviour

- Group nodes by stage in production order; show real branching dependencies.
  Expand/collapse stage groups and artifact groups. Collapsed groups show
  counts and aggregated connections, not pretend direct artifact edges.
- **All paths:** all recorded stage versions, including drafts, failures and
  blocked branches; availability and approval remain distinct.
- **Approved paths:** usable approved chains, not just independently approved
  nodes. A withdrawn ancestor excludes the affected path from usable matches.
- **Production line:** the exact selected chain, not “latest of each stage.”
- Search and secondary filters retain prerequisites of matches as visually
  secondary context. Matches are prominent; hidden branches show counts.
  Context nodes retain truthful statuses and accessible contrast.
- Select a node to inspect it. **Focus connections** shows its ancestors and
  descendants. **Open in stage** navigates; it is not an approval/use action.
- Provide an obvious way back to the whole graph. Do not lose the production
  line marker while exploring another branch.

### Coverage and interaction details proposed for spec review

- Include stage versions plus recorded audio, edit timelines, render variants,
  scene/full videos, subtitles, posters, analyses and QA reports under their
  owning artifacts. Media leaves expand on demand; do not load every preview.
- Distinguish **depends on** from **contains/output of** relationships. Stage
  group membership is presentation, not another dependency. Shared dependencies
  have one identity, not copies that appear to be independent artifacts.
- Use recorded metadata, including direct links for drafts rendered before
  annotations exist. Never infer an edge merely from version order or filenames.
  Unknown/legacy relationships stay visibly unknown. Do not promise historical
  revisions where only a current manifest was retained.
- **What the data gives today (checked in the code):** the stage versions form a
  **strict single-parent branching tree**, five levels deep (storyboard → take →
  voice-over → annotations → render), read from `parentOf`. Renders also record
  their take, timeline and voice version, and annotations record their take, so
  those are extra *recorded* links, not inferred ones. Genuinely **shared
  dependencies are rare** (a node has one stage parent); the map must not
  suggest otherwise. Unknown links happen for older or malformed records and are
  drawn as a broken stub with the reason. Artifact groups (audio, timelines,
  variants, QA reports) hang under their owner as *contains* relationships.
- Missing/pruned/deleted files keep their recorded nodes, with unavailable media
  actions explained. Opening the stage record remains possible where it exists.
- Brief, sources and findings remain accessible in Project. Only add them as
  graph dependencies when provenance actually exists; a raw inventory of caches,
  job internals or authentication storage is not the graph's purpose.
- Initial view: all paths with media groups collapsed and the production line
  highlighted. Remember view/filter/collapse state per project on later opens.
  Opening from History explicitly focuses that item; if filters would hide it,
  show an outside-filter notice with a reveal action, not a silent filter reset.
- Secondary filters: stage, artifact kind, approval/review state and availability.
  Show active filter chips, clear/reset actions and an explanatory no-match state.
- Provide pan/zoom, Fit view, collapse/expand stage and branch controls. Focus is
  a reversible view operation; opening details does not recenter the whole map.
- Preserve graph position and focus as background artifacts arrive; offer an
  update indicator rather than repeatedly rearranging the view under the user.
- Keyboard users need equivalent selection, focus, group expansion and navigation.
  Provide a synchronised accessible outline/list as an alternative interaction
  surface, **not a replacement for the agreed visual graph**.

Choose the layout/rendering approach during UX4 technical planning. No graph
library or new package is approved by this document. Test a branching fixture
and a larger generated fixture before choosing implementation complexity.

## 5. Review workspaces and saving

The common structure is a list/table, selected-item inspector and shared action
area. Keep review statuses visible while hiding repeated editors. Story order
is the default; risk filters, confidence explanations and carried-over review
information remain. Annotation enable switches can stay directly in rows.

| Screen | Main work | Progressive disclosure |
|---|---|---|
| Storyboard | Scene list; selected screenshot, intent and steps; review/re-run requests | Technical targets and step details; History; bulk review |
| Recording | Takes table and selected player, scene spans, errors and improvised inputs | Raw analysis/log details; new-take action retains its cost dialog |
| Voice over | Section list; footage/keyframe plus editable narration, anchors, confidence and diff | Voice direction panel; technical timing detail; generation estimate |
| Annotations | Filterable list with enable state, type and review signals; selected still/clip and editor | Target alternatives, timing, budget and privacy detail; bulk options |
| Render | Runs table; selected run's variants, player, files and QA | New render form on demand; advanced options; deletion/retention details |
| Project | Brief summary and missing essentials | Grouped editing, sources/context, findings and history |
| Config | Searchable settings; effective value/source and explicit scope edits | Technical keys, raw files and advanced details; Brands remains available |

The Recording table can adopt the shared foundation in UX2/UX3; the detailed
review migrations are UX5–UX7. Do not remove capabilities to meet a control count.

### Working-draft contract

- Voice and annotation edits autosave a **working draft** with explicit
  Saving / Draft saved / Save failed states. No new version per keystroke.
- Drafts survive item, version and stage navigation and reload. Scope them to
  the project, artifact type and base version; another version's draft must not
  overwrite them. Never overwrite the immutable base or an approved artifact.
- **Save new version** flushes the latest edits, validates and creates one
  immutable version. Preserve the working draft on failure. Repeated clicks
  must not create duplicate versions. Approval targets an explicit saved version.
- Detect conflicting edits from another tab/session; do not silently accept
  last-writer-wins data loss. Show an actionable recovery/conflict state.
- A failed autosave keeps unsaved text available and warns before unsafe
  navigation/closure where possible; do not claim browser-close recovery that
  has not been implemented and tested.
- **Discard draft** identifies which draft will be lost. Cheap review/toggle
  changes may offer Undo; Undo must not silently reverse production decisions.
- Render presets and Config forms are not artifact autosave: editing them must
  not run a render or apply configuration. Config keeps explicit Apply + diff.
- Saving never initiates TTS, model work, approval or production-line switching.

Use sticky stage context and appropriate action placement, without hiding focused
controls under fixed chrome. At narrow widths, provide an item picker/Back route
instead of squeezing the list, editor and player into unusable columns.

## 6. Project and Config

### Project first-run

Show the brief in human terms: audience, goal, scope/length and voice, plus
missing essentials linked to the relevant editing group. Keep sources, findings,
input memory and history available on demand. Preserve the existing conversation-
assisted brief workflow; no parallel mandatory wizard. Brief completeness is
orientation, not a new hard gate that silently blocks existing workflows.

```text
PROJECT · Keycraft
A demo for product teams evaluating the search workflow.

Audience    Product teams                       [Edit brief]
Goal        Show search → compare → act
Length      Not decided                         [Set length]
Voice       Project default

NEXT  Complete the missing brief details before discovery.
[Sources & context ▸] [Findings ▸] [Project history ▸]
```

### Config search

One result per setting. Search keys, labels, descriptions and displayed
non-secret values across groups/scopes. Show the effective value and source,
global value and project override together. Search does not change the edit
scope; actions explicitly say **Edit global** or **Override for this project**.

```text
Config                                         [Search settings…]
Query: voice                                      Clear search

Voice name                         Effective: Stefan_trained
Name used for narration.           Source: Global
Global value      Stefan_trained                 [Edit global]
Project override  Not set                        [Add override]
voiceName                                       [Technical details]
```

- Explain default, global, project and environment precedence. Environment
  values are read-only here. Warn when an applied value is shadowed.
- Highlight matching text; hide/collapse nonmatching groups while searching.
  Clearing restores normal grouping and expansion state. Distinguish no matches
  from unavailable config, loading and validation errors.
- Keep both scopes visible but disable project editing with a reason if no
  project is open. Brands stays a separate Config view; brand-asset full-text
  search is not required by this settings-search feature.
- No credentials or authentication contents in the search index, results, logs
  or copied diagnostics. API-key indicators remain set/not set only.
- Proposed shortcuts from the backlog: `/` and Cmd/Ctrl+K focus settings search
  **within Config**, outside editable controls and modal dialogs. Escape clears
  the query when search owns focus. Do not hijack editing or overlay Escape.

## 7. Design foundations and accessibility

**Calm workbench, Macchiato and Latte, 16 px base.** Borrow restrained hierarchy
and interaction principles from established workbenches such as Primer; do not
install a component framework or copy its palette. Mostly flat surfaces, limited
card nesting, clear separators and meaningful colour. Footage can grow with the
window; narration/prose stays around 60–80 characters per line.

Proposed starting scales for UX1, to verify visually:

| Foundation | Starting point / bar |
|---|---|
| Type | 12, 14, 16, 20, 24, 32 px; small sizes for secondary metadata, not primary editors; at most 8 sizes |
| Spacing | 0, 4, 8, 12, 16, 24, 32, 48 px; at most 8 steps |
| Radii | Square, small, medium, large and pill; at most 6 radii |
| Colour | Semantic surface, text, border, accent, info, success, warning, danger and focus tokens; zero hard-coded colours outside token definitions |
| Elevation | A small shared scale for surfaces, drawers and dialogs; no decorative shadow on every row |
| Width | Fluid shell, content-specific reading caps; one responsive policy rather than unrelated per-tab breakpoints |
| Density | One comfortable density; no global or list-only compact toggle in this sprint |
| Motion | Proposed: short functional transitions only; no pulsing status or decorative graph animation; reduced-motion alternative |

One component per job: buttons (primary/secondary/ghost/danger), form controls,
chips, badges/status, rows/tables, cards where needed, empty/loading/error states,
dialogs and drawers. Reuse part 13's decision/toast behaviour and cost-hint source;
restyle through tokens instead of introducing parallel implementations.

**WCAG 2.2 AA is the target, not a claim based on axe alone:**

- Text contrast ≥ 4.5:1 for normal text and ≥ 3:1 for large text; required
  non-text boundaries/status graphics ≥ 3:1. Check both themes and every surface,
  including graph context, muted text, selection and focus states.
- Visible focus on every interactive element; logical order; focus not obscured.
  Labels and status cannot depend solely on colour. Targets at least 24×24 CSS px.
- Fully keyboard-operable lists, inspectors, filters, dialogs, graph controls and
  an equivalent accessible graph outline. Escape affects only the topmost layer;
  close restores focus. Search shortcuts must not steal typing.
- Respect reduced motion and text zoom/reflow; avoid page-level horizontal
  overflow. The graph may pan internally, with equivalent non-spatial navigation.
- Disabled actions have an accessible explanation. Busy actions prevent duplicate
  submission without trapping focus. Announce meaningful saves/errors/progress,
  not every background event or keystroke.
- Overlay interaction is deliberate: opening Map from History replaces or safely
  suspends that surface; closing the top layer never dismisses another by accident.

## 8. Delivery slices and gates

Every slice, **including UX0**, is a separate branch/PR with local tests and before/after screenshots.
Spec approval is not implementation permission; pushes and merges have their own
gates. Do not rename stored schemas or break tool callers as a cosmetic refactor.

| Slice | Deliverable | Principal proof |
|---|---|---|
| UX0 | **Style tile and component/dialog showcase** (static page, §10.1) | Your approval of the screenshots; every shared component and layout principle shown in all states, both themes, 900 and 1400 px |
| UX1 | **Built** ([report](ux/UX1.md)): tokens and shared components exactly as approved in UX0; audit baseline/harness; ratchet test; existing dialog restyled | Both themes, token/contrast/focus checks, representative components; tile and panel tokens in sync |
| UX2 | Hash routing (§10.2), frame, stage status/next action, Activity strip/drawer; Recording adopts shared frame | Arriving results never steal navigation/focus; running vs waiting truthful |
| UX3 | Version summary, History, read-only browsing, explicit production/approval actions and vocabulary | Browse has no writes; approve-only keeps line; approve-and-use has coherent effects |
| UX4 | Dependency map overlay, `GET /api/graph`, path filters, collapse/focus/navigation, hash routes for the map | Forks/shared dependencies/legacy gaps; graph and outline equivalence; no production mutation |
| UX5 | Durable draft contract and storyboard/voice list-detail review | Reload/navigation/conflict/save failure; explicit new versions; review vs approval |
| UX6 | Annotation list/inspector, previews, direct toggles and draft integration | Privacy/target/timing/budget/import/re-suggest capabilities retained |
| UX7 | Render run/variant table, player/files/QA, creation form on demand | Draft/final gates, redaction confirmations, retention, variants and downloads |
| UX8 | Brief-summary first-run Project and grouped context views | Empty/partial/ready projects; sources/findings/memory stay reachable |
| UX9 | Config search/scope presentation and whole-workbench audit | Correct scope/effective source, shadowing, no secrets, full task regression |

Vocabulary and accessibility land with each touched screen, not as a late paint
job. UX9 verifies the whole pass. Part 14's guide/control-room/tutorial follows
this UI and regenerates its screenshots once.

## 9. Acceptance and validation

Historical pre-pass measurements, **not a fresh audit**: at 1500 px the fixture
had Render 196 controls, Annotations 102, Voice 46, Config 58, Project 30,
Storyboard 22 and Recording 5; pages reached about 3000 px. CSS had 14 font
sizes, 14 gaps, 51 padding combinations, 10 radii and 30 hard-coded colours;
Latte muted/status text failed AA. Re-measure the same fixture and view states
before each slice at **900 and 1400 px**, both themes; do not compare unlike
widths or count hidden controls as a usability success.

### Task-level acceptance scenarios

1. From any stage, identify viewed version, production selection, pending review
   and active job without opening History or Activity. A new result never moves you.
2. Browse an older version via History and Map, then close/return: no production
   state, approval or draft is changed. Open in stage goes to the exact artifact.
3. On a branching fixture, filter to approved paths and production line. Withdrawn
   ancestors, shared dependencies, missing media and unknown lineage remain honest.
   Collapse/focus/search are reversible and keyboard-equivalent.
4. Approve an alternative without selecting it; then explicitly approve/use another.
   Existing approvals/files survive. Stale line previews do not apply unnoticed.
5. Edit narration/annotations, navigate away and reload: recover the correct base's
   draft. Simulate failed writes and competing edits. Save creates exactly one
   validated version; it does not trigger generation or approval.
6. Review scenes, annotations and renders using the common inspector. Preserve
   confidence, batch-review safeguards, annotation controls, variants and QA overrides.
7. Search Config by key, description and safe value. Identify effective source;
   edit only the named scope, including a shadowed-value case. No secret appears.
8. Start with an empty/partial/complete brief. Find the next task and supporting
   context without filling a mandatory wizard or reading a large empty form.
9. Operate the workbench by keyboard in both themes and narrow layout; test nested
   surfaces, failed saves, busy states, reduced motion, text zoom and disconnection.

### Evidence and bars

- Aim to halve initially exposed controls on Render and Annotations without
  removing capabilities or making representative review tasks slower. Report
  visible/focusable control counts **and** task steps, completion/errors and
  scroll required; inspect the selected-detail state as well as the empty list.
- At most 8 font sizes, 6 radii and 8 spacing steps; no hard-coded colours outside
  tokens; one shared button system. Meaningful non-spacing dimensions (media,
  graph coordinates, borders) are not disguised spacing-scale exceptions.
- Score each screen before/after, 0–3 per heuristic: status visibility, real-world
  language, control/freedom, consistency, error prevention, recognition, efficiency,
  minimalism, recovery and help. Record examples, not just a total. Every screen's
  total should improve; no safety/accessibility regression is hidden by an average.
- Build `panel-audit` early: pinned axe-core fetched/cached from a CDN as tooling,
  plus our own token/contrast checks and Playwright keyboard/focus assertions.
  Browser tests skip explicitly where Chromium is unavailable. Missing audit
  tooling is a reported skipped/failed audit, never a passing accessibility result.
  Manual keyboard, visual, zoom and assistive-technology review complements automation.
- Keep existing tests green with assertions updated for moved structure, not weakened
  behaviour. Add route cost classifications for new endpoints. Use fake models and
  isolated config/root fixtures; never mutate real projects or the user's config.
- No automatic desktop video opening during tests. Manual commands use fish with
  per-command `env` overrides, never exported variables left in the user's shell.

## 10. Technical decisions (settled in the review grill) and what remains open

The product grill settled behaviour; a second review grill (2026-10-15) settled
these technical choices. Each is recorded as a decision (D110–D115).

### 10.1 Style tile and showcase gate (UX0, D110)

**Built:** [ux/README.md](ux/README.md) describes the pages, the tokens and the tests; screenshots are in `images/ux/`. The values in `tokens.css` are now measured, not proposed. Besides the two planned mock screens (Voice over, Render) it has a working **Project map** prototype (UX4) and a **Config** screen with a working settings search (UX9), added on request.

Before UX1, build **one static, themeable HTML page** (no panel code, no build
step; served from `docs/ux/` and generated screenshots under `docs/images/ux/`):

- **Tokens:** type scale, spacing, radii, elevation, semantic status and focus
  colours, both themes, with the measured contrast ratio beside every pair.
- **A component and dialog showcase** that covers every shared component and every
  layout principle in all its states: buttons (variants, sizes, busy, disabled with
  a reason), form controls with error states, chips, badges and status pills,
  rows/tables and the list + inspector pattern, tabs and stepper states (complete,
  needs you, blocked, running), the status strip and Activity drawer, toasts,
  confirm / danger / cost / diff / text dialogs, empty, loading and error states,
  the History list, a map node in every state and the map's controls, the draft
  saving states, the config search result, and focus rings.
- **Layout principles shown, not described:** the frame at 1400 and 900 px, the
  fluid workspace with capped prose, the list-and-detail collapse to an item picker,
  and overlays and drawers stacking.
- **Two mock screens** built from those parts, **Voice over** and **Render**, with
  fixture content, in both themes at 900 and 1400 px.
- **Gate:** you approve the screenshots (and may use the page in a browser) before
  UX1 starts. UX1 implements exactly that, and the page stays as the living
  reference; a test fails if the tile's tokens and the panel's tokens drift apart.

### 10.2 Location and routes (D111)

The location lives in the URL **hash**, no framework and no server routes:

| Route | Meaning |
|---|---|
| `#/project` | Project |
| `#/<stage>` and `#/<stage>/v<N>` | a stage, optionally a viewed version |
| `#/<stage>/v<N>/<item>` | a selected item (scene, section, annotation, variant) |
| `#/map` with `focus=`, `view=` (`all`, `approved`, `line`), `q=` | the map overlay and its view |
| `#/config` with `q=` and `scope=` | Config and its search |

Rules: changing a route **never mutates project state**; back/forward and reload
restore the place; an unknown or unavailable route explains the fallback instead
of silently showing something else; an overlay is part of the route, so Escape and
Back close the top layer only; a route may be pasted into chat. New background
results update badges and never rewrite the route. The remembered last place per
project (spec §2) is the default when the hash is empty.

### 10.3 Graph: data, layout and scale (D112, D113)

- **Data:** a read-only `GET /api/graph` walks existing records and returns nodes,
  edges (`depends-on` vs `contains`), status fields kept separate (approved,
  usable, in the production line, availability, review), `unknown-link` flags with
  a reason, and a **stable id per node** (e.g. `vo:3`, `render:12:full`). It stores
  nothing, so it cannot disagree with the files; the result is cached by file
  modification time and refreshed by the event bus. It is a GET with no side
  effect, and it is listed in the route table with cost class `none`.
- **Layout:** drawn as **SVG with Preact**, in one column per stage, rows ordered by
  branch, curved edges, no graph library. Selection, focus, group expansion and the
  synchronised outline are our own components, so focus rings, keyboard use and
  theming follow the tokens. Pan and zoom are limited to the map surface. Edges
  are only drawn for recorded links.
- **Drafts are grouped by default:** under each annotation version, finals show as
  nodes and draft renders fold into one node, "Drafts ×N", that expands in place.
  Filters can reveal them all; a group never hides a match (a matching draft opens
  its group and says so).
- **Scale budget:** the fixture has about 45 versions (37 renders). The map must stay
  responsive on a **generated 300-node fixture** (target: first paint under 200 ms
  of layout work, interaction without dropped frames on a laptop), by grouping and
  by not loading media for collapsed groups. If that fails, the answer is more
  grouping or virtualisation, not a library, unless a later review decides otherwise.

### 10.4 Migration without a big bang (D114)

1. **UX1** adds a token file and component CSS **next to** `style.css`, and aliases
   today's variable and class names to the tokens, so nothing visibly changes by
   accident.
2. Each slice migrates **its** screens and **deletes the legacy rules they used**.
3. A **ratchet test** counts hard-coded colours, font sizes, spacing values and
   legacy button/chip classes in `style.css` and the panel scripts, and fails if a
   count rises above the committed baseline; each slice lowers the baseline.
4. `app.js` (about 1,000 lines) is split into **one module per screen** while its
   screen is migrated; no behavioural change is hidden in a move.
5. **UX9 deletes the last legacy rules**, the aliases and the ratchet baselines.
6. Panel tests are updated for the new structure with their intent kept; a test
   that is deleted needs a reason in the PR.

### 10.5 Drafts: storage and conflicts (D115)

- **Storage:** one working draft per **stage and base version**, in the project:
  `drafts/<stage>/v<base>.json`, with a `revision` counter, the base version, the
  author tab/session id and a timestamp, written **atomically** (write then rename).
  It reuses the annotations draft pattern where compatible, without coupling
  extensions. A draft is never a numbered version and never appears in the map as
  one.
- **Conflicts:** a write carries the revision it was based on; a **stale revision is
  rejected** with the current draft, and the panel shows an actionable choice (keep
  mine, take theirs, compare). There is no silent last-writer-wins.
- **Recovery:** the unsaved text is kept in the browser until the server confirms,
  so a failed or rejected save never loses it; the UI says "Save failed" with a
  retry, never "Saved".
- **Save new version** flushes the latest revision, validates, and creates exactly
  one version (idempotent on the draft revision, so a double click cannot create two).
  On failure the draft stays. Discard names the draft it deletes.
- Draft routes are listed with cost class `none`; saving a draft never starts a
  model, TTS or render job and never changes approval or the production line.

### 10.6 Still open, to settle inside the slice that needs it

- Final token values and content-driven pane thresholds (settled in UX0 by looking
  at the tile, not argued on paper); small functional motion timings.
- How the **approval intents** map onto the existing `approve` and `select` routes and
  tool callers (UX3: audit callers first; one validated server operation, not two
  browser requests).
- The exact **draft schema** per stage (UX5), reusing the annotation draft where it fits.
- **Outline and graph equivalence** details and the pan/zoom controls (UX4).

The first step is **UX0 (the style tile and showcase)**, then UX1 foundations, each
only after explicit go-ahead.
