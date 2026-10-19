# demo-recording — future ideas

Ideas that came up while designing and are explicitly **not** in scope yet.
Each one names where it came from, so it can be picked up with its context.

| Idea | Origin | Notes |
|---|---|---|
| **Full annotation editor** | Annotation grill (D37) | Draw or move regions, add your own annotations from scratch, change the zoom factor, free timing on a timeline track. v1 keeps to toggles, text edits, ±0.5 s nudges and choosing between suggested zoom targets. |
| **Flexible stage lineage** | Annotation grill (D30) | Beyond the strict chain: render any combination of versions side by side (e.g. two narration styles with the same annotations), or a full version tree in the panel. |
| **Cursor frame-locking** | S5 grill (D28) | Only if cursor unevenness is still noticed in real takes. |
| **Background music** | S5 grill (D28) | Out of v1. |
| **Parallel discovery lanes** | User request, after S5 part 3 | **Moved into the plan as slice S6** ([IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md#s6--parallel-discovery-lanes-user-request-opt-in-discoverylanes)). |
| **Lineage map view + navigation** | Branching-stages discussion (D44–D46) | **View:** the whole project as a tree: storyboard versions → takes → voice-overs → annotation versions → renders, each node showing its state (accepted, draft, orphaned, final) and the current **working line** highlighted.<br>**Navigation:** clicking a node selects it as the working line (ancestors follow, descendants re-pick their most recently accepted child) and jumps to its stage tab. Hover shows lineage, dates and who/what produced it (input-log entries). Collapsing old or unaccepted branches keeps it readable.<br>**Actions in place:** accept/un-accept, compare two branches side by side (e.g. two voice-overs on different takes), and "render this line".<br>**Until then:** the stage tabs' input pickers list each accepted input with its lineage. |
| **Early checks** | F32, D-QA-12, run 2 grill (D-R2-2) | **Thin, informational, config-gated; not built.** Full description [below](#early-checks-thin-config-gated-informational). |
| **Coherence review (Q8)** | D-QA-11 | An advisory, on-request, Director-led review beyond the deterministic QA: does the narration claim what the footage shows, is the order coherent, does the goal of the brief come across. Proposes fixes into the same fix-set flow; never blocks, never runs on its own. |
| **Extra QA checks (Q9)** | QA catalog | Loudness against about -16 LUFS, length against the brief, subtitle and transcript sanity, scene order against the storyboard. |
| **Discovery checks (QS-disc)** | F32 | Declared areas not covered, blocked or state-changing actions, findings without evidence, a login screen captured. Needs the discovery report (P3). |
| **Compare for recording, annotations and render** | R2-3, D-R2-11 | After the storyboard and voice-over compare works: takes (length, errors, dead time, retries, keyframes per scene side by side), annotations (items on or off, zooms, redactions), renders (length, QA findings). |
| **A stored suggestion history** | R2-11, D-R2-8 | A bounded log in the project of what the next-action band suggested, when, and whether it was followed. Only if the "Suggestions" list is not enough. |
| **Pending fixes: superseded and stale** | D-QA-9 | The statuses exist; nothing sets them. A newer fix set for the same finding supersedes an older pending fix; a changed take makes a scene fix stale. |
| **A map node for fix sets** | Q4 | The tree link from a render, its findings, the new draft and the pending fixes (today a badge and a band suffix). |
| **A setting for the draft render after the voice** | R2-7 | Declined for now (the render is cheap, the button says what it does); `render.draftAfterVoice` if it becomes a nuisance. |

## Early checks (thin, config-gated, informational)

**What it was.** After run 1, F32 asked for QA after every phase. The grill (D-QA-12) cut that down to three free, deterministic checks that run
when a stage screen is opened, because the findings that cost the most in run 1 (timing: 3 to 6 in every final) cannot be found before the voice
exists, and the early-checkable ones were two or three wrong numbers per final that were finally confirmed as meant. Run 2 (D-R2-2) showed no need,
so it is **not built**. This is what it would be, so it can be picked up:

- **Principle.** A quiet hint, never a stage: it never blocks, never changes "Needs you", never starts a Director turn, never costs, and only the
  render keeps real gates. A shortcut that saves work, not a required step.
- **The three checks.** (1) **Voice-over** (on the draft, before synthesis): numbers and names the narration says that are not on the page in that
  scene (the render's value check, moved before the voice costs anything); (2) **Recording** (on the analysed take, before any narration is written
  around it): an error toast, a console error, a resumed or retried scene, an improvise fallback; (3) **Annotations** (when an edit exists): a
  redaction that does not cover its element.
- **How it shows.** A small note on the stage head ("2 notes", an info tone, never in the band), one popup (the render's "All checks" popup shell,
  which is already stage-agnostic and takes a `stage` parameter on `GET /api/checks`), each finding with **Send to the Director as a direction**
  (the existing direction mechanism: no fix sets) and **Ignore** with the existing scopes.
- **Switches.** `qa.early.storyboard | recording | vo | annotations` (booleans), **all off by default**, global or per project; the render is always on.
- **Cost.** About 3 to 4 days; the findings model, the popup, the identity and the ignore store exist from P1b. The storyboard and discovery
  adapters, a Fix / Leave flow per stage and folding the confidence signals into findings are not part of it.
- **When to build it.** If a run shows a wrong number found only at the render that would have been cheap to fix before synthesis, or a bad take
  noticed only after the narration was written around it.
